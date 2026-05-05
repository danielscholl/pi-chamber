// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { composeEnv, executeWorkflow } from "./executor.ts";
import { parseWorkflow } from "./loader.ts";
import type { BashSpawnFn, SpawnPiFn } from "./nodes/index.ts";
import type { NodeOutput, WorkflowDefinition } from "./schema/index.ts";
import { createRun, listRuns, loadRun, readEvents, readNodeOutput } from "./store.ts";

function tmpRunsDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-procedures-exec-"));
}

function makeWorkflow(yaml: string): WorkflowDefinition {
	const result = parseWorkflow(yaml, "test.yaml");
	if (result.error) throw new Error(`fixture workflow failed to parse: ${result.error.error}`);
	return result.workflow;
}

function stubBashAlwaysOk(): BashSpawnFn {
	return async (input) => ({
		exitCode: 0,
		stdout: `ran: ${input.script}`,
		stderr: "",
		timedOut: false,
		aborted: false,
		durationMs: 0,
	});
}

function stubPiAlwaysOk(textByPrompt: (prompt: string) => string = (p) => `echoed: ${p}`): SpawnPiFn {
	return async (opts) => ({
		exitCode: 0,
		finalText: textByPrompt(opts.prompt),
		sessionId: "stub-session",
		stderr: "",
		aborted: false,
		durationMs: 0,
	});
}

describe("composeEnv", () => {
	test("includes ARTIFACTS_DIR, BASE_BRANCH, positional args, ARGUMENTS", () => {
		const env = composeEnv({
			artifactsDir: "/runs/x/artifacts",
			baseBranch: "main",
			workflowArgs: ["foo", "bar"],
			upstreamOutputs: new Map(),
		});
		expect(env.ARTIFACTS_DIR).toBe("/runs/x/artifacts");
		expect(env.BASE_BRANCH).toBe("main");
		expect(env["1"]).toBe("foo");
		expect(env["2"]).toBe("bar");
		expect(env.ARGUMENTS).toBe("foo bar");
	});

	test("upstream outputs export as $<id>=<output>", () => {
		const env = composeEnv({
			artifactsDir: "/a",
			workflowArgs: [],
			upstreamOutputs: new Map<string, NodeOutput>([
				["fetch", { state: "completed", output: "ok" }],
			]),
		});
		expect(env.fetch).toBe("ok");
	});

	test("non-alphanumeric characters in node ids are sanitized for env keys", () => {
		const env = composeEnv({
			artifactsDir: "/a",
			workflowArgs: [],
			upstreamOutputs: new Map<string, NodeOutput>([
				["fetch-issue", { state: "completed", output: "x" }],
			]),
		});
		expect(env["fetch_issue"]).toBe("x");
	});

	test("only the first 9 args are exposed as positional vars", () => {
		const env = composeEnv({
			artifactsDir: "/a",
			workflowArgs: Array.from({ length: 12 }, (_, i) => `a${i}`),
			upstreamOutputs: new Map(),
		});
		expect(env["1"]).toBe("a0");
		expect(env["9"]).toBe("a8");
		expect(env["10"]).toBeUndefined();
	});
});

describe("executeWorkflow — end-to-end", () => {
	test("smoke: single bash node completes successfully", async () => {
		const wf = makeWorkflow(`
name: smoke
description: trivial bash run
nodes:
  - id: hi
    bash: echo hi
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "go",
		});
		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
		});
		expect(result.finalStatus).toBe("completed");
		expect(result.failedNodes).toEqual([]);
		const persistedOutput = readNodeOutput(paths.nodesDir, "hi");
		expect(persistedOutput?.state).toBe("completed");
		expect(persistedOutput?.output).toMatch(/ran: echo hi/);
		const persistedRun = loadRun(paths.runJsonPath);
		expect(persistedRun?.status).toBe("completed");
	});

	test("3-node DAG: bash → prompt → conditional bash", async () => {
		const wf = makeWorkflow(`
name: triage
description: bash + prompt + conditional bash
nodes:
  - id: scope
    bash: echo BUG
  - id: classify
    depends_on: [scope]
    prompt: "Classify $scope.output"
  - id: bug-flow
    depends_on: [classify]
    when: "$classify.output == 'BUG'"
    bash: echo handling-bug
  - id: feature-flow
    depends_on: [classify]
    when: "$classify.output == 'FEATURE'"
    bash: echo handling-feature
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "go",
		});
		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
			spawnPi: stubPiAlwaysOk(() => "BUG"),
		});
		expect(result.finalStatus).toBe("completed");
		const bugOut = readNodeOutput(paths.nodesDir, "bug-flow");
		const featureOut = readNodeOutput(paths.nodesDir, "feature-flow");
		expect(bugOut?.state).toBe("completed");
		expect(featureOut?.state).toBe("skipped");
	});

	test("all_done trigger_rule lets a collector run after a mixed-state fan-in", async () => {
		const wf = makeWorkflow(`
name: collect
description: fan-in with all_done
nodes:
  - id: a
    bash: echo a
  - id: b
    bash: echo b-fail
  - id: c
    bash: echo c-skipped
    depends_on: [a, b]
    when: "$a.output == 'never'"
  - id: collect
    depends_on: [a, b, c]
    trigger_rule: all_done
    bash: echo collected
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "go",
		});
		const stub: BashSpawnFn = async (input) => {
			if (input.script.includes("b-fail")) {
				return {
					exitCode: 1,
					stdout: "",
					stderr: "boom",
					timedOut: false,
					aborted: false,
					durationMs: 0,
				};
			}
			return {
				exitCode: 0,
				stdout: input.script.split(" ").pop() ?? "",
				stderr: "",
				timedOut: false,
				aborted: false,
				durationMs: 0,
			};
		};
		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stub,
		});
		// b failed; c was skipped via when:; collect should still run (all_done)
		const collectOutput = readNodeOutput(paths.nodesDir, "collect");
		expect(collectOutput?.state).toBe("completed");
		expect(result.failedNodes).toEqual(["b"]);
		expect(result.finalStatus).toBe("failed"); // b failure makes the run failed
	});

	test("cancel node short-circuits and yields cancelled status", async () => {
		const wf = makeWorkflow(`
name: cancel-me
description: cancel after a node
nodes:
  - id: precheck
    bash: echo precheck
  - id: stop
    cancel: precondition not met
    depends_on: [precheck]
  - id: never-run
    bash: echo skipped
    depends_on: [stop]
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
		});
		expect(result.finalStatus).toBe("cancelled");
		expect(result.cancelReason).toBe("precondition not met");
		// never-run did NOT execute (no persisted output for it).
		expect(readNodeOutput(paths.nodesDir, "never-run")).toBeNull();
		const finalRun = loadRun(paths.runJsonPath);
		expect(finalRun?.status).toBe("cancelled");
	});

	test("trigger_rule all_success skips downstream when an upstream fails", async () => {
		const wf = makeWorkflow(`
name: gate
description: skip on failure
nodes:
  - id: must-pass
    bash: echo BAD
  - id: depends-on-pass
    depends_on: [must-pass]
    bash: echo never
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		const stubFailing: BashSpawnFn = async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "no",
			timedOut: false,
			aborted: false,
			durationMs: 0,
		});
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubFailing,
		});
		expect(readNodeOutput(paths.nodesDir, "must-pass")?.state).toBe("failed");
		expect(readNodeOutput(paths.nodesDir, "depends-on-pass")?.state).toBe("skipped");
	});

	test("event log captures lifecycle: run_started → node_* → run_*", async () => {
		const wf = makeWorkflow(`
name: events
description: lifecycle smoke
nodes:
  - id: a
    bash: echo a
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
		});
		const events = readEvents(paths.eventsLogPath);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("run_started");
		expect(types).toContain("node_started");
		expect(types).toContain("node_completed");
		expect(types[types.length - 1]).toBe("run_completed");
	});

	test("session id threads forward through sequential single-node layers", async () => {
		const wf = makeWorkflow(`
name: session-thread
description: shared context between two prompts
nodes:
  - id: first
    prompt: "step 1"
  - id: second
    depends_on: [first]
    prompt: "step 2"
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});

		const sessionsByPrompt: Record<string, string | undefined> = {};
		const stubPi: SpawnPiFn = async (opts) => {
			sessionsByPrompt[opts.prompt] = opts.resumeSessionId;
			return {
				exitCode: 0,
				finalText: `done: ${opts.prompt}`,
				sessionId: `sess-${opts.prompt}`,
				stderr: "",
				aborted: false,
				durationMs: 0,
			};
		};
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnPi: stubPi,
		});
		// First node has no prior session.
		expect(sessionsByPrompt["step 1"]).toBeUndefined();
		// Second node receives the first node's session id (sequential single-node layer).
		expect(sessionsByPrompt["step 2"]).toBe("sess-step 1");
	});

	test("context: 'fresh' opts out of session threading", async () => {
		const wf = makeWorkflow(`
name: fresh-each
description: explicitly no shared session
nodes:
  - id: first
    prompt: "step 1"
  - id: second
    depends_on: [first]
    context: fresh
    prompt: "step 2"
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		const sessions: Record<string, string | undefined> = {};
		const stubPi: SpawnPiFn = async (opts) => {
			sessions[opts.prompt] = opts.resumeSessionId;
			return {
				exitCode: 0,
				finalText: "ok",
				sessionId: `sess-${opts.prompt}`,
				stderr: "",
				aborted: false,
				durationMs: 0,
			};
		};
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnPi: stubPi,
		});
		expect(sessions["step 1"]).toBeUndefined();
		expect(sessions["step 2"]).toBeUndefined();
	});

	test("parallel layer breaks session threading even without context: fresh", async () => {
		const wf = makeWorkflow(`
name: parallel-resets
description: parallel layer resets the threaded session
nodes:
  - id: first
    prompt: "p1"
  - id: a
    depends_on: [first]
    prompt: "pa"
  - id: b
    depends_on: [first]
    prompt: "pb"
  - id: after
    depends_on: [a, b]
    prompt: "after"
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		const sessions: Record<string, string | undefined> = {};
		const stubPi: SpawnPiFn = async (opts) => {
			sessions[opts.prompt] = opts.resumeSessionId;
			return {
				exitCode: 0,
				finalText: "ok",
				sessionId: `sess-${opts.prompt}`,
				stderr: "",
				aborted: false,
				durationMs: 0,
			};
		};
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnPi: stubPi,
		});
		// Layer 0: first (sequential, no prior session).
		expect(sessions["p1"]).toBeUndefined();
		// Layer 1: parallel — both should be undefined (cannot share a session).
		expect(sessions["pa"]).toBeUndefined();
		expect(sessions["pb"]).toBeUndefined();
		// Layer 2: 'after' is sequential again, but the session reset on the
		// parallel layer means it has no prior id to inherit.
		expect(sessions["after"]).toBeUndefined();
	});

	test("listRuns reflects the executor's persisted run", async () => {
		const wf = makeWorkflow(`
name: listed
description: ensures status flows to disk
nodes:
  - id: a
    bash: echo a
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
		});
		const summaries = listRuns(runsDir);
		expect(summaries.length).toBe(1);
		expect(summaries[0].status).toBe("completed");
		expect(summaries[0].workflow_name).toBe("listed");
	});

	test("priorOutputs make the executor skip already-completed nodes", async () => {
		const wf = makeWorkflow(`
name: resume
description: resume scenario
nodes:
  - id: pre
    bash: echo pre
  - id: post
    depends_on: [pre]
    bash: echo post
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "",
		});
		const calls: string[] = [];
		const stubBash: BashSpawnFn = async (input) => {
			calls.push(input.script);
			return {
				exitCode: 0,
				stdout: input.script,
				stderr: "",
				timedOut: false,
				aborted: false,
				durationMs: 0,
			};
		};
		await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			priorOutputs: new Map<string, NodeOutput>([
				["pre", { state: "completed", output: "echo pre" }],
			]),
			spawnBash: stubBash,
		});
		// Only `post` should have been spawned — `pre` was provided as a prior output.
		expect(calls).toEqual(["echo post"]);
	});
});
