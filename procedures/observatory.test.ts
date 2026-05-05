// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";

import {
	buildProcedureNodeView,
	buildProcedureRunDetail,
	buildProcedureRunSummary,
	buildProceduresObservatoryManifest,
	clearProceduresObservatoryLens,
	collectProceduresSnapshot,
	type CurrentRunInput,
	dependentsByNodeId,
	nodeKind,
	type ProceduresSnapshot,
	refreshProceduresObservatoryLens,
	resolveProceduresObservatoryPaths,
	writeProceduresObservatoryLens,
} from "./observatory.ts";
import { createRun } from "./store.ts";
import type {
	BashNode,
	CancelNode,
	CommandNode,
	DagNode,
	NodeOutput,
	PromptNode,
	WorkflowDefinition,
	WorkflowRun,
} from "./schema/index.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "procedures-observatory-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function makeWorkflow(nodes: DagNode[], name = "demo"): WorkflowDefinition {
	return { name, nodes } as WorkflowDefinition;
}

function promptNode(id: string, depends: string[] = []): PromptNode {
	return { id, prompt: "hi", depends_on: depends } as PromptNode;
}

function bashNode(id: string, depends: string[] = []): BashNode {
	return { id, bash: "echo hi", depends_on: depends } as BashNode;
}

function cancelNode(id: string, depends: string[] = []): CancelNode {
	return { id, cancel: "stop", depends_on: depends } as CancelNode;
}

function commandNode(id: string, depends: string[] = []): CommandNode {
	return { id, command: "do-thing", depends_on: depends } as CommandNode;
}

describe("nodeKind", () => {
	test("discriminates each variant by its mutually-exclusive verb-field", () => {
		expect(nodeKind(promptNode("a"))).toBe("prompt");
		expect(nodeKind(bashNode("b"))).toBe("bash");
		expect(nodeKind(cancelNode("c"))).toBe("cancel");
		expect(nodeKind(commandNode("d"))).toBe("command");
	});
});

describe("dependentsByNodeId", () => {
	test("produces an empty list for leaves", () => {
		const map = dependentsByNodeId([promptNode("a")]);
		expect(map).toEqual({ a: [] });
	});

	test("builds reverse adjacency from depends_on", () => {
		const map = dependentsByNodeId([
			promptNode("a"),
			promptNode("b", ["a"]),
			promptNode("c", ["a"]),
			promptNode("d", ["b", "c"]),
		]);
		expect(map.a.sort()).toEqual(["b", "c"]);
		expect(map.b).toEqual(["d"]);
		expect(map.c).toEqual(["d"]);
		expect(map.d).toEqual([]);
	});
});

describe("buildProcedureNodeView", () => {
	const node = promptNode("summarize", ["scan"]);

	test("returns a pending-status view when output is missing", () => {
		const view = buildProcedureNodeView(node, undefined, ["report"]);
		expect(view).toEqual({
			id: "summarize",
			kind: "prompt",
			status: "pending",
			dependsOn: ["scan"],
			dependents: ["report"],
		});
	});

	test("includes timing, sessionId, and usage on a completed output", () => {
		const out: NodeOutput = {
			state: "completed",
			output: "result text",
			sessionId: "sess-1",
			startedAt: "2026-05-04T10:00:00.000Z",
			completedAt: "2026-05-04T10:00:01.500Z",
			durationMs: 1500,
			usage: { input: 100, output: 50, totalTokens: 150, costUsd: 0.001 },
		};
		const view = buildProcedureNodeView(node, out, []);
		expect(view.status).toBe("completed");
		expect(view.sessionId).toBe("sess-1");
		expect(view.startedAt).toBe("2026-05-04T10:00:00.000Z");
		expect(view.completedAt).toBe("2026-05-04T10:00:01.500Z");
		expect(view.durationMs).toBe(1500);
		expect(view.usage?.totalTokens).toBe(150);
		expect(view.output).toBe("result text");
	});

	test("surfaces the error string for failed outputs", () => {
		const out: NodeOutput = {
			state: "failed",
			output: "",
			error: "boom",
		};
		const view = buildProcedureNodeView(node, out, []);
		expect(view.status).toBe("failed");
		expect(view.error).toBe("boom");
	});

	test("omits empty output", () => {
		const out: NodeOutput = { state: "completed", output: "" };
		const view = buildProcedureNodeView(node, out, []);
		expect(view.output).toBeUndefined();
	});
});

describe("buildProcedureRunDetail", () => {
	test("groups nodes by topological layer", () => {
		const workflow = makeWorkflow([
			promptNode("a"),
			promptNode("b", ["a"]),
			promptNode("c", ["a"]),
			promptNode("d", ["b", "c"]),
		]);
		const detail = buildProcedureRunDetail("run-1", workflow, new Map(), null);
		expect(detail.layers).toEqual([["a"], ["b", "c"], ["d"]]);
		expect(Object.keys(detail.nodes).sort()).toEqual(["a", "b", "c", "d"]);
		expect(detail.nodes.b.dependsOn).toEqual(["a"]);
		expect(detail.nodes.a.dependents.sort()).toEqual(["b", "c"]);
	});

	test("rolls up token and cost totals across completed nodes", () => {
		const workflow = makeWorkflow([promptNode("a"), promptNode("b")]);
		const outputs = new Map<string, NodeOutput>([
			[
				"a",
				{
					state: "completed",
					output: "x",
					usage: { totalTokens: 100, costUsd: 0.001 },
				},
			],
			[
				"b",
				{
					state: "completed",
					output: "y",
					usage: { totalTokens: 50, costUsd: 0.0005 },
				},
			],
		]);
		const detail = buildProcedureRunDetail("r", workflow, outputs, null);
		expect(detail.totalTokens).toBe(150);
		expect(detail.totalCostUsd).toBeCloseTo(0.0015, 6);
	});

	test("falls back to status='running' when run.json is not yet on disk", () => {
		const workflow = makeWorkflow([promptNode("a")]);
		const detail = buildProcedureRunDetail("r", workflow, new Map(), null);
		expect(detail.status).toBe("running");
	});

	test("computes durationMs from started_at + completed_at when run is terminal", () => {
		const workflow = makeWorkflow([promptNode("a")]);
		const run: WorkflowRun = {
			id: "r",
			workflow_name: "demo",
			status: "completed",
			user_message: "go",
			metadata: {},
			started_at: "2026-05-04T10:00:00.000Z",
			completed_at: "2026-05-04T10:00:04.000Z",
			last_activity_at: "2026-05-04T10:00:04.000Z",
		};
		const detail = buildProcedureRunDetail("r", workflow, new Map(), run);
		expect(detail.durationMs).toBe(4000);
		expect(detail.completedAt).toBe("2026-05-04T10:00:04.000Z");
	});
});

describe("buildProcedureRunSummary", () => {
	test("populates runId, status, and timing from a RunSummary", () => {
		const summary = buildProcedureRunSummary({
			runId: "20260504-100000-abc123",
			workflow_name: "classify",
			status: "completed",
			started_at: "2026-05-04T10:00:00.000Z",
			completed_at: "2026-05-04T10:00:02.500Z",
			working_path: null,
		});
		expect(summary.runId).toBe("20260504-100000-abc123");
		expect(summary.workflowName).toBe("classify");
		expect(summary.status).toBe("completed");
		expect(summary.durationMs).toBe(2500);
		expect(summary.failedCount).toBe(0);
		expect(summary.totalTokens).toBeUndefined();
	});

	test("accumulates token totals + failed-count when outputs are supplied", () => {
		const summary = buildProcedureRunSummary(
			{
				runId: "r",
				workflow_name: "demo",
				status: "failed",
				started_at: "2026-05-04T10:00:00.000Z",
				completed_at: null,
				working_path: null,
			},
			new Map([
				[
					"a",
					{
						state: "completed",
						output: "ok",
						usage: { totalTokens: 100, costUsd: 0.001 },
					},
				],
				["b", { state: "failed", output: "", error: "nope" }],
			]),
		);
		expect(summary.failedCount).toBe(1);
		expect(summary.nodeCount).toBe(2);
		expect(summary.totalTokens).toBe(100);
		expect(summary.totalCostUsd).toBeCloseTo(0.001, 6);
	});
});

describe("buildProceduresObservatoryManifest", () => {
	test("returns a valid v1 dag-run manifest", () => {
		const manifest = buildProceduresObservatoryManifest();
		expect(manifest).toEqual(
			expect.objectContaining({
				name: "Procedures",
				kind: "dag-run",
				source: "data.json",
			}),
		);
	});
});

describe("resolveProceduresObservatoryPaths", () => {
	test("places the lens under .pi/observatory/lenses/procedures", () => {
		withTempProject((cwd) => {
			const paths = resolveProceduresObservatoryPaths(cwd);
			expect(
				paths.lensDir.endsWith("/.pi/observatory/lenses/procedures"),
			).toBe(true);
			expect(paths.manifestPath.endsWith("lens.json")).toBe(true);
			expect(paths.dataPath.endsWith("data.json")).toBe(true);
		});
	});

	test("respects observatory.lensesPath in .pi/settings.json", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify(
					{ observatory: { lensesPath: "./.pi/observatory/custom-lenses" } },
					null,
					2,
				),
			);
			const paths = resolveProceduresObservatoryPaths(cwd);
			expect(
				paths.lensDir.endsWith(
					"/.pi/observatory/custom-lenses/procedures",
				),
			).toBe(true);
		});
	});
});

describe("writeProceduresObservatoryLens / clearProceduresObservatoryLens", () => {
	test("writes manifest + data files at the resolved lens path", () => {
		withTempProject((cwd) => {
			const snapshot: ProceduresSnapshot = {
				generatedAt: "2026-05-04T10:00:00.000Z",
				runs: [],
				current: null,
			};
			const paths = writeProceduresObservatoryLens(cwd, snapshot);
			expect(fs.existsSync(paths.manifestPath)).toBe(true);
			expect(fs.existsSync(paths.dataPath)).toBe(true);
			const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, "utf-8"));
			expect(manifest.kind).toBe("dag-run");
			const data = JSON.parse(fs.readFileSync(paths.dataPath, "utf-8"));
			expect(data.runs).toEqual([]);
			expect(data.current).toBeNull();
		});
	});

	test("clear removes the lens directory", () => {
		withTempProject((cwd) => {
			writeProceduresObservatoryLens(cwd, {
				generatedAt: "x",
				runs: [],
				current: null,
			});
			const paths = resolveProceduresObservatoryPaths(cwd);
			expect(fs.existsSync(paths.lensDir)).toBe(true);
			clearProceduresObservatoryLens(cwd);
			expect(fs.existsSync(paths.lensDir)).toBe(false);
		});
	});
});

describe("collectProceduresSnapshot", () => {
	test("returns empty snapshot when current is null", () => {
		const snap = collectProceduresSnapshot(null);
		expect(snap.runs).toEqual([]);
		expect(snap.current).toBeNull();
	});

	test("populates current from outputs and lists prior runs from disk", () => {
		withTempProject((cwd) => {
			const runsDir = path.join(cwd, ".pi", "procedures", "runs");
			fs.mkdirSync(runsDir, { recursive: true });
			// Seed one historical run.
			createRun({
				runsDir,
				workflow_name: "earlier",
				user_message: "go",
			});
			// Active run.
			const { paths: runPaths } = createRun({
				runsDir,
				workflow_name: "demo",
				user_message: "go",
			});
			const workflow = makeWorkflow([promptNode("a"), promptNode("b", ["a"])]);
			const outputs = new Map<string, NodeOutput>([
				[
					"a",
					{
						state: "completed",
						output: "ok",
						usage: { totalTokens: 50, costUsd: 0.0005 },
					},
				],
			]);
			const current: CurrentRunInput = { runPaths, workflow, outputs };
			const snap = collectProceduresSnapshot(current);
			expect(snap.current).not.toBeNull();
			expect(snap.current?.workflowName).toBe("demo");
			expect(snap.current?.layers).toEqual([["a"], ["b"]]);
			expect(snap.current?.totalTokens).toBe(50);
			// History contains both runs. (Within the same second, the random-hex
			// suffix's lexicographic order is non-deterministic — assert presence
			// + per-run shape rather than ordering.)
			expect(snap.runs.length).toBe(2);
			const ids = snap.runs.map((r) => r.runId);
			expect(ids).toContain(runPaths.runId);
			const active = snap.runs.find((r) => r.runId === runPaths.runId);
			const historical = snap.runs.find((r) => r.runId !== runPaths.runId);
			// Active run picks up totals from in-memory outputs; historical run does not.
			expect(active?.totalTokens).toBe(50);
			expect(historical?.totalTokens).toBeUndefined();
		});
	});
});

describe("refreshProceduresObservatoryLens", () => {
	test("end-to-end: builds a snapshot from disk + memory and writes the lens files", () => {
		withTempProject((cwd) => {
			const runsDir = path.join(cwd, ".pi", "procedures", "runs");
			fs.mkdirSync(runsDir, { recursive: true });
			const { paths: runPaths } = createRun({
				runsDir,
				workflow_name: "demo",
				user_message: "go",
			});
			const workflow = makeWorkflow([promptNode("a")]);
			const outputs = new Map<string, NodeOutput>([
				["a", { state: "completed", output: "ok" }],
			]);
			refreshProceduresObservatoryLens(cwd, { runPaths, workflow, outputs });
			const lensPaths = resolveProceduresObservatoryPaths(cwd);
			expect(fs.existsSync(lensPaths.manifestPath)).toBe(true);
			expect(fs.existsSync(lensPaths.dataPath)).toBe(true);
			const data = JSON.parse(fs.readFileSync(lensPaths.dataPath, "utf-8"));
			expect(data.current.workflowName).toBe("demo");
			expect(data.runs.length).toBe(1);
		});
	});
});
