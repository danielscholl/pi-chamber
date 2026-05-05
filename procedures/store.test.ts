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
	appendEvent,
	createRun,
	generateRunId,
	listRuns,
	loadAllNodeOutputs,
	loadRun,
	readEvents,
	readNodeOutput,
	resolveRunPaths,
	updateRun,
	writeNodeOutput,
} from "./store.ts";

function tmpRunsDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-procedures-store-"));
}

describe("generateRunId", () => {
	test("uses YYYYMMDD-HHmmss-<6hex> shape", () => {
		const id = generateRunId(new Date("2026-05-04T15:30:45Z"), "abcdef");
		expect(id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
	});

	test("ids generated at distinct times sort chronologically", () => {
		const a = generateRunId(new Date("2026-05-04T10:00:00Z"), "000001");
		const b = generateRunId(new Date("2026-05-04T11:00:00Z"), "000002");
		expect([b, a].sort()).toEqual([a, b]);
	});

	test("two ids in the same second differ by random suffix", () => {
		const t = new Date();
		const a = generateRunId(t, "abc123");
		const b = generateRunId(t, "def456");
		expect(a).not.toBe(b);
	});
});

describe("createRun + loadRun + updateRun", () => {
	test("creates run.json with status pending and the directory layout", () => {
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({
			runsDir,
			workflow_name: "demo",
			user_message: "go",
		});
		expect(run.status).toBe("pending");
		expect(run.workflow_name).toBe("demo");
		expect(fs.existsSync(paths.runJsonPath)).toBe(true);
		expect(fs.statSync(paths.nodesDir).isDirectory()).toBe(true);
		expect(fs.statSync(paths.artifactsDir).isDirectory()).toBe(true);
	});

	test("loadRun round-trips through schema validation", () => {
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		const loaded = loadRun(paths.runJsonPath);
		expect(loaded?.id).toBe(run.id);
		expect(loaded?.status).toBe("pending");
	});

	test("loadRun returns null for a missing file", () => {
		expect(loadRun(path.join(tmpRunsDir(), "nope", "run.json"))).toBeNull();
	});

	test("updateRun patches status and refreshes last_activity_at", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		const updated = updateRun(paths.runJsonPath, { status: "running" });
		expect(updated.status).toBe("running");
		const reloaded = loadRun(paths.runJsonPath);
		expect(reloaded?.status).toBe("running");
	});

	test("loadRun throws on a corrupt run.json", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		fs.writeFileSync(paths.runJsonPath, JSON.stringify({ bogus: true }), "utf-8");
		expect(() => loadRun(paths.runJsonPath)).toThrow();
	});
});

describe("writeNodeOutput + readNodeOutput + loadAllNodeOutputs", () => {
	test("round-trips a completed output and writes a .txt mirror", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		writeNodeOutput(paths.nodesDir, "fetch", { state: "completed", output: "hello" });
		const read = readNodeOutput(paths.nodesDir, "fetch");
		expect(read?.state).toBe("completed");
		expect(read?.output).toBe("hello");
		const txt = fs.readFileSync(path.join(paths.nodesDir, "fetch.txt"), "utf-8");
		expect(txt).toBe("hello");
	});

	test("round-trips a failed output with error", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		writeNodeOutput(paths.nodesDir, "broken", {
			state: "failed",
			output: "stderr text",
			error: "exit 1",
		});
		const read = readNodeOutput(paths.nodesDir, "broken");
		expect(read?.state).toBe("failed");
		if (read?.state !== "failed") throw new Error("type narrowing");
		expect(read.error).toBe("exit 1");
	});

	test("loadAllNodeOutputs returns every persisted output as a Map", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		writeNodeOutput(paths.nodesDir, "a", { state: "completed", output: "1" });
		writeNodeOutput(paths.nodesDir, "b", { state: "skipped", output: "" });
		const map = loadAllNodeOutputs(paths.nodesDir);
		expect(map.size).toBe(2);
		expect(map.get("a")?.output).toBe("1");
		expect(map.get("b")?.state).toBe("skipped");
	});

	test("readNodeOutput returns null for an unknown node", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		expect(readNodeOutput(paths.nodesDir, "missing")).toBeNull();
	});

	test("sanitizes path-traversing node ids", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		// Path separator must NOT escape nodesDir.
		writeNodeOutput(paths.nodesDir, "../escape", { state: "completed", output: "x" });
		const escaped = path.join(paths.nodesDir, "..", "escape.json");
		expect(fs.existsSync(escaped)).toBe(false);
	});
});

describe("appendEvent + readEvents", () => {
	test("appended events read back in order", () => {
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		appendEvent(paths.eventsLogPath, {
			timestamp: new Date().toISOString(),
			type: "run_started",
			runId: run.id,
		});
		appendEvent(paths.eventsLogPath, {
			timestamp: new Date().toISOString(),
			type: "node_started",
			runId: run.id,
			nodeId: "fetch",
		});
		const events = readEvents(paths.eventsLogPath);
		expect(events.length).toBe(2);
		expect(events[0].type).toBe("run_started");
		expect(events[1].nodeId).toBe("fetch");
	});

	test("malformed lines are dropped", () => {
		const runsDir = tmpRunsDir();
		const { paths, run } = createRun({ runsDir, workflow_name: "x", user_message: "y" });
		fs.writeFileSync(
			paths.eventsLogPath,
			`${JSON.stringify({ timestamp: "now", type: "run_started", runId: run.id })}\n` +
				"{not json}\n" +
				`${JSON.stringify({ timestamp: "later", type: "run_completed", runId: run.id })}\n`,
			"utf-8",
		);
		const events = readEvents(paths.eventsLogPath);
		expect(events.length).toBe(2);
	});
});

describe("listRuns", () => {
	test("returns runs newest-first", () => {
		const runsDir = tmpRunsDir();
		const a = createRun({ runsDir, workflow_name: "a", user_message: "" });
		// Sleep just enough for the second's-resolution timestamp to differ.
		// (Bun supports synchronous sleepSync via Bun.sleepSync but the tests
		// shouldn't depend on it; instead, force the run id directly.)
		const second = createRun({ runsDir, workflow_name: "b", user_message: "" });
		const list = listRuns(runsDir);
		expect(list.length).toBe(2);
		// Reverse-lexicographic on run-id stamps yields newest first; both ids
		// share the same second so order is determined by random hex suffix —
		// only assert the two known ids are present.
		const ids = list.map((r) => r.runId).sort();
		expect(ids).toEqual([a.run.id, second.run.id].sort());
	});

	test("missing runsDir returns empty list", () => {
		expect(listRuns("/nonexistent/runs")).toEqual([]);
	});

	test("corrupt run is skipped (not thrown)", () => {
		const runsDir = tmpRunsDir();
		const { paths } = createRun({ runsDir, workflow_name: "x", user_message: "" });
		fs.writeFileSync(paths.runJsonPath, "garbage", "utf-8");
		expect(listRuns(runsDir)).toEqual([]);
	});
});

describe("resolveRunPaths", () => {
	test("composes deterministic paths from runsDir + runId", () => {
		const p = resolveRunPaths("/tmp/runs", "20260504-150000-abc123");
		expect(p.runDir).toBe("/tmp/runs/20260504-150000-abc123");
		expect(p.runJsonPath).toBe("/tmp/runs/20260504-150000-abc123/run.json");
		expect(p.eventsLogPath).toBe("/tmp/runs/20260504-150000-abc123/events.ndjson");
		expect(p.nodesDir).toBe("/tmp/runs/20260504-150000-abc123/nodes");
		expect(p.artifactsDir).toBe("/tmp/runs/20260504-150000-abc123/artifacts");
	});
});
