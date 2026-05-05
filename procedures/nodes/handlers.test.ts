// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import type {
	BashNode,
	CancelNode,
	CommandNode,
	NodeOutput,
	PromptNode,
} from "../schema/index.ts";
import type { SpawnPiOptions, SpawnPiResult } from "../spawn.ts";
import { bashHandler } from "./bash.ts";
import { cancelHandler, SENTINEL_CANCELLED_BY_NODE } from "./cancel.ts";
import { commandHandler } from "./command.ts";
import { selectHandler } from "./index.ts";
import { promptHandler } from "./prompt.ts";
import type { BashSpawnFn, NodeExecuteInput, SpawnPiFn } from "./types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseInput<N extends import("../schema/index.ts").DagNode>(
	overrides: Partial<NodeExecuteInput<N>> & { node: N },
): NodeExecuteInput<N> {
	const stubSpawnPi: SpawnPiFn = async () => ({
		exitCode: 0,
		finalText: "",
		stderr: "",
		aborted: false,
		durationMs: 0,
	});
	const stubSpawnBash: BashSpawnFn = async () => ({
		exitCode: 0,
		stdout: "",
		stderr: "",
		timedOut: false,
		aborted: false,
		durationMs: 0,
	});
	return {
		cwd: "/cwd",
		env: {},
		workflowArgs: [],
		upstreamOutputs: new Map(),
		signal: new AbortController().signal,
		spawnPi: stubSpawnPi,
		spawnBash: stubSpawnBash,
		resolveCommand: async () => null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// cancelHandler
// ---------------------------------------------------------------------------

describe("cancelHandler", () => {
	test("returns failed output with sentinel error prefix", async () => {
		const node: CancelNode = { id: "stop", cancel: "precondition not met" };
		const result = await cancelHandler(baseInput({ node }));
		expect(result.state).toBe("failed");
		expect(result.output).toBe("precondition not met");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(SENTINEL_CANCELLED_BY_NODE);
		expect(result.error).toMatch(/precondition not met/);
	});
});

// ---------------------------------------------------------------------------
// bashHandler
// ---------------------------------------------------------------------------

describe("bashHandler", () => {
	test("happy path: completed output is the trimmed stdout", async () => {
		const node: BashNode = { id: "ls", bash: "ls" };
		const calls: { script: string }[] = [];
		const stubBash: BashSpawnFn = async (input) => {
			calls.push({ script: input.script });
			return {
				exitCode: 0,
				stdout: "a\nb\n",
				stderr: "",
				timedOut: false,
				aborted: false,
				durationMs: 1,
			};
		};
		const result = await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash }));
		expect(result.state).toBe("completed");
		expect(result.output).toBe("a\nb");
		expect(calls[0].script).toBe("ls");
	});

	test("substitutes $ARGUMENTS before shell-out", async () => {
		const node: BashNode = { id: "echo", bash: "echo $ARGUMENTS" };
		let captured = "";
		const stubBash: BashSpawnFn = async (input) => {
			captured = input.script;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				timedOut: false,
				aborted: false,
				durationMs: 1,
			};
		};
		await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash, workflowArgs: ["foo", "bar"] }));
		expect(captured).toBe("echo foo bar");
	});

	test("substitutes upstream $nodeId.output WITH shell-quoting", async () => {
		const node: BashNode = { id: "uses-up", bash: "echo $up.output" };
		const upstreamOutputs = new Map<string, NodeOutput>([
			["up", { state: "completed", output: "it's tricky" }],
		]);
		let captured = "";
		const stubBash: BashSpawnFn = async (input) => {
			captured = input.script;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				timedOut: false,
				aborted: false,
				durationMs: 1,
			};
		};
		await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash, upstreamOutputs }));
		// Single quote escaping: ' → '\''
		expect(captured).toBe("echo 'it'\\''s tricky'");
	});

	test("non-zero exit becomes failed output with stderr in error", async () => {
		const node: BashNode = { id: "x", bash: "false" };
		const stubBash: BashSpawnFn = async () => ({
			exitCode: 1,
			stdout: "partial",
			stderr: "boom",
			timedOut: false,
			aborted: false,
			durationMs: 1,
		});
		const result = await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash }));
		expect(result.state).toBe("failed");
		expect(result.output).toBe("partial");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/exit 1/);
		expect(result.error).toMatch(/boom/);
	});

	test("timed-out execution is reported with the configured timeout", async () => {
		const node: BashNode = { id: "x", bash: "sleep 9999", timeout: 100 };
		const stubBash: BashSpawnFn = async () => ({
			exitCode: 124,
			stdout: "",
			stderr: "killed",
			timedOut: true,
			aborted: false,
			durationMs: 100,
		});
		const result = await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash }));
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/timed out after 100ms/);
	});

	test("aborted execution is distinguished from a generic failure", async () => {
		const node: BashNode = { id: "x", bash: "sleep 9999" };
		const stubBash: BashSpawnFn = async () => ({
			exitCode: 130,
			stdout: "",
			stderr: "interrupted",
			timedOut: false,
			aborted: true,
			durationMs: 1,
		});
		const result = await bashHandler(baseInput<BashNode>({ node, spawnBash: stubBash }));
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/aborted/);
	});
});

// ---------------------------------------------------------------------------
// promptHandler
// ---------------------------------------------------------------------------

describe("promptHandler", () => {
	test("happy path: completed output is finalText, sessionId is preserved", async () => {
		const node: PromptNode = { id: "ask", prompt: "Say hi" };
		const stubPi: SpawnPiFn = async () => ({
			exitCode: 0,
			finalText: "Hi!",
			sessionId: "sess-1",
			stderr: "",
			aborted: false,
			durationMs: 1,
		});
		const result = await promptHandler(baseInput<PromptNode>({ node, spawnPi: stubPi }));
		expect(result.state).toBe("completed");
		expect(result.output).toBe("Hi!");
		if (result.state !== "completed") throw new Error("type narrowing");
		expect(result.sessionId).toBe("sess-1");
	});

	test("substitutes $ARGUMENTS into the prompt before spawn", async () => {
		const node: PromptNode = { id: "ask", prompt: "Process: $ARGUMENTS" };
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return {
				exitCode: 0,
				finalText: "ok",
				stderr: "",
				aborted: false,
				durationMs: 1,
			};
		};
		await promptHandler(
			baseInput<PromptNode>({ node, spawnPi: stubPi, workflowArgs: ["one", "two"] }),
		);
		expect(captured?.prompt).toBe("Process: one two");
	});

	test("substitutes $upstream.output (NOT shell-escaped — it's a prompt arg)", async () => {
		const node: PromptNode = { id: "ask", prompt: "context: $up.output" };
		const upstreamOutputs = new Map<string, NodeOutput>([
			["up", { state: "completed", output: "it's fine" }],
		]);
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return {
				exitCode: 0,
				finalText: "",
				stderr: "",
				aborted: false,
				durationMs: 1,
			};
		};
		await promptHandler(
			baseInput<PromptNode>({ node, spawnPi: stubPi, upstreamOutputs }),
		);
		expect(captured?.prompt).toBe("context: it's fine");
	});

	test("forwards env (ARTIFACTS_DIR, $1..$9, ARGUMENTS, upstreams) to spawnPi", async () => {
		// Regression test for the env-propagation bug surfaced by the Codex
		// review: prompt nodes must inherit the procedure env so AI tools
		// (Bash, Write) inside the spawned pi see $ARTIFACTS_DIR etc.
		const node: PromptNode = { id: "x", prompt: "p" };
		const env = {
			ARTIFACTS_DIR: "/runs/abc/artifacts",
			BASE_BRANCH: "main",
			"1": "first-arg",
			ARGUMENTS: "first-arg second-arg",
			fetch_issue: "issue body text",
		};
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return {
				exitCode: 0,
				finalText: "",
				stderr: "",
				aborted: false,
				durationMs: 1,
			};
		};
		await promptHandler(baseInput<PromptNode>({ node, spawnPi: stubPi, env }));
		expect(captured?.env).toEqual(env);
	});

	test("forwards model / allowed_tools / systemPrompt / resumeSessionId to spawnPi", async () => {
		const node: PromptNode = {
			id: "x",
			prompt: "p",
			model: "opus",
			allowed_tools: ["Read"],
			denied_tools: ["Write"],
			systemPrompt: "you are a tester",
		};
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return {
				exitCode: 0,
				finalText: "",
				stderr: "",
				aborted: false,
				durationMs: 1,
			};
		};
		await promptHandler(
			baseInput<PromptNode>({ node, spawnPi: stubPi, resumeSessionId: "sess-prev" }),
		);
		expect(captured?.model).toBe("opus");
		expect(captured?.allowedTools).toEqual(["Read"]);
		expect(captured?.deniedTools).toEqual(["Write"]);
		expect(captured?.systemPrompt).toBe("you are a tester");
		expect(captured?.resumeSessionId).toBe("sess-prev");
	});

	test("non-zero exit reports failure with stderr in error", async () => {
		const node: PromptNode = { id: "x", prompt: "p" };
		const stubPi: SpawnPiFn = async () => ({
			exitCode: 2,
			finalText: "partial",
			stderr: "broken",
			aborted: false,
			durationMs: 1,
		});
		const result = await promptHandler(baseInput<PromptNode>({ node, spawnPi: stubPi }));
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/exit 2/);
	});

	test("stopReason 'error' is treated as failure even on exit 0", async () => {
		const node: PromptNode = { id: "x", prompt: "p" };
		const stubPi: SpawnPiFn = async () => ({
			exitCode: 0,
			finalText: "",
			stderr: "",
			stopReason: "error",
			errorMessage: "model returned error",
			aborted: false,
			durationMs: 1,
		});
		const result = await promptHandler(baseInput<PromptNode>({ node, spawnPi: stubPi }));
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/model returned error/);
	});
});

// ---------------------------------------------------------------------------
// commandHandler
// ---------------------------------------------------------------------------

describe("commandHandler", () => {
	test("missing command: returns failed with bring-your-own message", async () => {
		const node: CommandNode = { id: "x", command: "lint" };
		const result = await commandHandler(
			baseInput<CommandNode>({ node, resolveCommand: async () => null }),
		);
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/command 'lint' not found/);
		expect(result.error).toMatch(/\.pi\/commands/);
		expect(result.error).toMatch(/\.archon\/commands/);
	});

	test("resolves command body and forwards to pi", async () => {
		const node: CommandNode = { id: "x", command: "lint" };
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return {
				exitCode: 0,
				finalText: "lint ok",
				stderr: "",
				aborted: false,
				durationMs: 1,
			};
		};
		const result = await commandHandler(
			baseInput<CommandNode>({
				node,
				spawnPi: stubPi,
				resolveCommand: async () => "Run the linter and report.",
			}),
		);
		expect(result.state).toBe("completed");
		expect(captured?.prompt).toBe("Run the linter and report.");
	});

	test("substitutes $ARGUMENTS and $upstream.output in resolved body", async () => {
		const node: CommandNode = { id: "x", command: "review" };
		const upstreamOutputs = new Map<string, NodeOutput>([
			["scope", { state: "completed", output: "PR #12" }],
		]);
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return { exitCode: 0, finalText: "", stderr: "", aborted: false, durationMs: 1 };
		};
		await commandHandler(
			baseInput<CommandNode>({
				node,
				spawnPi: stubPi,
				upstreamOutputs,
				workflowArgs: ["urgent"],
				resolveCommand: async () => "Review $scope.output with priority $1.",
			}),
		);
		expect(captured?.prompt).toBe("Review PR #12 with priority urgent.");
	});

	test("forwards env (ARTIFACTS_DIR + upstream vars) to spawnPi", async () => {
		// Same regression as the prompt-handler env test — command nodes also
		// run as pi child processes and must see the procedure env.
		const node: CommandNode = { id: "x", command: "review" };
		const env = {
			ARTIFACTS_DIR: "/runs/abc/artifacts",
			BASE_BRANCH: "main",
			scope: "PR #12",
		};
		let captured: SpawnPiOptions | undefined;
		const stubPi: SpawnPiFn = async (opts) => {
			captured = opts;
			return { exitCode: 0, finalText: "", stderr: "", aborted: false, durationMs: 1 };
		};
		await commandHandler(
			baseInput<CommandNode>({
				node,
				spawnPi: stubPi,
				env,
				resolveCommand: async () => "Review the scope.",
			}),
		);
		expect(captured?.env).toEqual(env);
	});
});

// ---------------------------------------------------------------------------
// selectHandler dispatch
// ---------------------------------------------------------------------------

describe("selectHandler", () => {
	test("dispatches by node discriminant", () => {
		expect(selectHandler({ id: "a", prompt: "x" } as PromptNode)).toBe(promptHandler);
		expect(selectHandler({ id: "b", bash: "echo hi" } as BashNode)).toBe(bashHandler);
		expect(selectHandler({ id: "c", cancel: "stop" } as CancelNode)).toBe(cancelHandler);
		expect(selectHandler({ id: "d", command: "lint" } as CommandNode)).toBe(commandHandler);
	});

	test("loop / approval / script return a Phase-1 not-implemented handler", async () => {
		const loopNode = {
			id: "lp",
			loop: { prompt: "x", until: "DONE", max_iterations: 3, fresh_context: false },
		} as never;
		const handler = selectHandler(loopNode);
		const result = await handler(baseInput({ node: loopNode }));
		expect(result.state).toBe("failed");
		if (result.state !== "failed") throw new Error("type narrowing");
		expect(result.error).toMatch(/Phase 1/);
		expect(result.error).toMatch(/loop/);
	});
});
