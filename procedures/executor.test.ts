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

import {
	composeEnv,
	defaultSpawnBash,
	executeWorkflow,
	type RefreshObservatoryFn,
} from "./executor.ts";
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

describe("defaultSpawnBash — timeout policy", () => {
	// Regression for the Codex review finding: omitting `timeout:` on a bash
	// node must NOT enforce a hidden default timer, since the README and
	// handler comments document Archon-compatible "no timeout" behavior.
	test("does not time out a long script when no timeoutMs is set", async () => {
		const result = await defaultSpawnBash({
			// `sleep 0.4` would have been killed by the prior 120s default, but
			// we use a short sleep so the test stays fast. The point is: the
			// timer should never fire when timeoutMs is undefined.
			script: "sleep 0.2 && echo done",
			cwd: process.cwd(),
			env: {},
		});
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("done");
	});

	test("times out when an explicit timeoutMs is set and exceeded", async () => {
		const result = await defaultSpawnBash({
			script: "sleep 5",
			cwd: process.cwd(),
			env: {},
			timeoutMs: 100,
		});
		// `timedOut` is the canonical signal (the executor uses it to compose
		// the failure message). The shell's exit code on SIGTERM is
		// platform-dependent, so we don't assert on it.
		expect(result.timedOut).toBe(true);
		expect(result.durationMs).toBeGreaterThanOrEqual(100);
		expect(result.durationMs).toBeLessThan(3000);
	});

	test("completes normally within an explicit timeoutMs window", async () => {
		const result = await defaultSpawnBash({
			script: "echo quick",
			cwd: process.cwd(),
			env: {},
			timeoutMs: 5000,
		});
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("quick");
	});
});

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

	test("refreshObservatory spy fires after each handler-driven node and at run end", async () => {
		const wf = makeWorkflow(`
name: spy
description: 2-node workflow exercising the observatory hook
nodes:
  - id: a
    bash: echo a
  - id: b
    depends_on: [a]
    bash: echo b
`);
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "go",
		});
		const calls: Array<{ nodeIds: string[]; runId: string }> = [];
		const refreshObservatory: RefreshObservatoryFn = (cwd, current) => {
			expect(cwd).toBe("/tmp");
			if (current) {
				calls.push({
					nodeIds: [...current.outputs.keys()].sort(),
					runId: current.runPaths.runId,
				});
			}
		};
		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd: "/tmp",
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
			refreshObservatory,
		});
		expect(result.finalStatus).toBe("completed");
		// 2 nodes × 1 hook each + 1 final hook = 3 calls. Each call sees all
		// outputs persisted up to that point, so the call sequence reveals the
		// in-memory outputs map growing as nodes settle.
		expect(calls.length).toBe(3);
		expect(calls[0].nodeIds).toEqual(["a"]);
		expect(calls[1].nodeIds).toEqual(["a", "b"]);
		expect(calls[2].nodeIds).toEqual(["a", "b"]);
	});

	test("refreshObservatory throwing does not fail a run", async () => {
		const wf = makeWorkflow(`
name: hostile-hook
description: hook throws — run must still finalize
nodes:
  - id: a
    bash: echo a
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
			refreshObservatory: () => {
				throw new Error("intentional observatory failure");
			},
		});
		expect(result.finalStatus).toBe("completed");
	});

	test("end-to-end: lens data.json reflects history + current run + per-node usage", async () => {
		const wf = makeWorkflow(`
name: e2e-lens
description: bash → prompt with token capture flowing through to the lens
nodes:
  - id: scan
    bash: echo data
  - id: summarize
    depends_on: [scan]
    prompt: "Summarize $scan.output"
`);
		// Real cwd so the default refreshObservatory writes the lens to disk.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-procedures-e2e-"));
		const runsDir = path.join(cwd, ".pi", "procedures", "runs");
		fs.mkdirSync(runsDir, { recursive: true });
		const { paths, run } = createRun({
			runsDir,
			workflow_name: wf.name,
			user_message: "go",
		});
		// Stub spawnPi so it reports a usage payload for the prompt node.
		const spawnPi: SpawnPiFn = async (opts) => ({
			exitCode: 0,
			finalText: `summary of: ${opts.prompt}`,
			sessionId: "sess-e2e",
			stderr: "",
			aborted: false,
			durationMs: 5,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				costUsd: 0.0012,
			},
		});

		const result = await executeWorkflow({
			workflow: wf,
			runId: run.id,
			paths,
			cwd,
			workflowArgs: [],
			signal: new AbortController().signal,
			commandRoots: [],
			spawnBash: stubBashAlwaysOk(),
			spawnPi,
		});
		expect(result.finalStatus).toBe("completed");

		// Per-node usage should have been threaded into the persisted output.
		const summarizeOutput = readNodeOutput(paths.nodesDir, "summarize");
		expect(summarizeOutput?.state).toBe("completed");
		if (summarizeOutput?.state === "completed") {
			expect(summarizeOutput.usage?.totalTokens).toBe(150);
			expect(summarizeOutput.startedAt).toBeDefined();
			expect(summarizeOutput.completedAt).toBeDefined();
			expect(summarizeOutput.durationMs).toBeGreaterThanOrEqual(0);
		}

		// Lens manifest + data + per-run snapshot all present.
		const lensDir = path.join(cwd, ".pi", "observatory", "lenses", "procedures");
		expect(fs.existsSync(path.join(lensDir, "lens.json"))).toBe(true);
		const data = JSON.parse(
			fs.readFileSync(path.join(lensDir, "data.json"), "utf-8"),
		);
		expect(data.runs.length).toBeGreaterThan(0);
		expect(data.current).not.toBeNull();
		expect(data.current.workflowName).toBe("e2e-lens");
		expect(data.current.layers).toEqual([["scan"], ["summarize"]]);
		expect(data.current.nodes.scan.status).toBe("completed");
		expect(data.current.nodes.summarize.status).toBe("completed");
		// Token totals roll up across nodes.
		expect(data.current.totalTokens).toBe(150);

		// Per-run snapshot file exists and matches.
		const runSnapPath = path.join(lensDir, "runs", `${run.id}.json`);
		expect(fs.existsSync(runSnapPath)).toBe(true);
		const runSnap = JSON.parse(fs.readFileSync(runSnapPath, "utf-8"));
		expect(runSnap.runId).toBe(run.id);
		expect(runSnap.nodes.summarize.usage.totalTokens).toBe(150);

		fs.rmSync(cwd, { recursive: true, force: true });
	});
});
