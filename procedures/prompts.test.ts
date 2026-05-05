// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import type { WorkflowLoadWarning } from "./loader.ts";
import {
	formatRunComplete,
	formatRunStatus,
	formatStrictRefusal,
	formatUnknownProcedure,
	formatWarnings,
	formatWorkflowList,
} from "./prompts.ts";
import type { WorkflowWithSource } from "./schema/index.ts";
import type { RunSummary } from "./store.ts";

function workflow(name: string, source: WorkflowWithSource["source"], description = "x"): WorkflowWithSource {
	return {
		workflow: { name, description, nodes: [{ id: "a", prompt: "x" } as never] },
		source,
		path: `/abs/${name}.yaml`,
	};
}

describe("formatWorkflowList", () => {
	test("lists every workflow with its source label and description", () => {
		const out = formatWorkflowList([
			workflow("deploy", "project", "ship it"),
			workflow("hello", "bundled", "smoke"),
		]);
		expect(out).toContain("deploy");
		expect(out).toContain("[project]");
		expect(out).toContain("ship it");
		expect(out).toContain("hello");
		expect(out).toContain("[bundled]");
	});

	test("shows the bring-your-own message when the list is empty", () => {
		const out = formatWorkflowList([]);
		expect(out).toMatch(/No procedures discovered/);
		expect(out).toContain(".pi/procedures/");
		expect(out).toContain(".archon/workflows/");
	});

	test("uses only the first line of multi-line descriptions", () => {
		const out = formatWorkflowList([workflow("multi", "global", "first line\nsecond line")]);
		expect(out).toContain("first line");
		expect(out).not.toContain("second line");
	});
});

describe("formatRunStatus", () => {
	test("empty list prints the no-runs hint", () => {
		expect(formatRunStatus([])).toMatch(/No procedure runs/);
	});

	test("includes status, workflow name, and timestamps", () => {
		const summaries: RunSummary[] = [
			{
				runId: "20260504-150000-abcdef",
				workflow_name: "demo",
				status: "completed",
				started_at: "2026-05-04T15:00:00Z",
				completed_at: "2026-05-04T15:01:23Z",
				working_path: null,
			},
		];
		const out = formatRunStatus(summaries);
		expect(out).toContain("20260504-150000-abcdef");
		expect(out).toContain("[completed]");
		expect(out).toContain("demo");
		expect(out).toContain("2026-05-04T15:00:00Z");
	});

	test("caps display at 20 entries", () => {
		const summaries: RunSummary[] = Array.from({ length: 25 }, (_, i) => ({
			runId: `id-${i}`,
			workflow_name: "x",
			status: "completed" as const,
			started_at: "now",
			completed_at: null,
			working_path: null,
		}));
		const out = formatRunStatus(summaries);
		// 1 header + 20 lines max
		expect(out.split("\n").length).toBe(21);
	});
});

describe("formatWarnings + formatStrictRefusal", () => {
	const warnings: WorkflowLoadWarning[] = [
		{
			filename: "/abs/wf.yaml",
			nodeId: "do-stuff",
			kind: "ignored_capability",
			message: "hooks ignored",
		},
	];

	test("formatWarnings includes filename + node id + message", () => {
		const out = formatWarnings(warnings);
		expect(out).toContain("/abs/wf.yaml");
		expect(out).toContain("[do-stuff]");
		expect(out).toContain("hooks ignored");
	});

	test("empty warnings is empty string", () => {
		expect(formatWarnings([])).toBe("");
	});

	test("formatStrictRefusal includes the warnings and the bypass hint", () => {
		const out = formatStrictRefusal(warnings);
		expect(out).toMatch(/--strict refused/);
		expect(out).toContain("hooks ignored");
		expect(out).toContain("Drop --strict");
	});
});

describe("formatUnknownProcedure + formatRunComplete", () => {
	test("unknown procedure points the user at /procedures list", () => {
		const out = formatUnknownProcedure("ghost");
		expect(out).toContain("ghost");
		expect(out).toContain("/procedures list");
		expect(out).toContain(".pi/procedures/");
	});

	test("run-complete includes id and rounded seconds", () => {
		expect(formatRunComplete("rid-1", 1500)).toBe("Procedure run rid-1 completed in 1.5s.");
	});
});
