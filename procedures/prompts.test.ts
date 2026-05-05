// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import type { WorkflowLoadWarning } from "./loader.ts";
import {
	formatProcedureOption,
	formatProcedureReceipt,
	formatRunStatus,
	formatStrictRefusal,
	formatUnknownProcedure,
	formatWarnings,
	formatWorkflowList,
	parseProcedureChoice,
} from "./prompts.ts";
import type {
	NodeOutput,
	WorkflowDefinition,
	WorkflowWithSource,
} from "./schema/index.ts";
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

describe("formatProcedureOption + parseProcedureChoice", () => {
	const wfs = [
		workflow("deploy", "project", "ship it"),
		workflow("hello", "bundled", "smoke test\nignored second line"),
		workflow("long-one", "global", "x".repeat(120)),
	];

	test("formats a compact ▸-prefixed row with name, source, description", () => {
		const out = formatProcedureOption(wfs[0]);
		expect(out.startsWith("▸ deploy ")).toBe(true);
		expect(out).toContain("project");
		expect(out).toContain("ship it");
	});

	test("uses only the first line of multi-line descriptions", () => {
		const out = formatProcedureOption(wfs[1]);
		expect(out).toContain("smoke test");
		expect(out).not.toContain("ignored second line");
	});

	test("truncates very long descriptions with an ellipsis", () => {
		const out = formatProcedureOption(wfs[2]);
		expect(out.length).toBeLessThan(120);
		expect(out.endsWith("…")).toBe(true);
	});

	test("parseProcedureChoice round-trips a formatted option to its name", () => {
		const row = formatProcedureOption(wfs[0]);
		expect(parseProcedureChoice(row, wfs)).toBe("deploy");
	});

	test("parseProcedureChoice returns undefined for unknown or malformed input", () => {
		expect(parseProcedureChoice("+ New procedure", wfs)).toBeUndefined();
		expect(parseProcedureChoice("▸ ghost · project · gone", wfs)).toBeUndefined();
	});
});

describe("formatUnknownProcedure", () => {
	test("unknown procedure points the user at /procedures list", () => {
		const out = formatUnknownProcedure("ghost");
		expect(out).toContain("ghost");
		expect(out).toContain("/procedures list");
		expect(out).toContain(".pi/procedures/");
	});
});

describe("formatProcedureReceipt", () => {
	const wf: WorkflowDefinition = {
		name: "demo",
		description: "x",
		nodes: [
			{ id: "collect", bash: "echo hi" } as never,
			{ id: "summarize", prompt: "summarize", depends_on: ["collect"] } as never,
		],
	};

	const completed = (output = ""): NodeOutput => ({ state: "completed", output });
	const failed = (error = "boom"): NodeOutput => ({ state: "failed", output: "", error });
	const skipped = (): NodeOutput => ({ state: "skipped", output: "" });

	test("happy-path completed run: header + per-node ✓ + view footer", () => {
		const lines = formatProcedureReceipt({
			workflow: wf,
			runId: "rid-1",
			finalStatus: "completed",
			durationMs: 4_100,
			nodeOutputs: new Map([
				["collect", completed("lots of bash output")],
				["summarize", completed("Hello! How can I help?")],
			]),
		});
		expect(lines[0]).toBe("✓ demo completed in 4.1s · run rid-1");
		// bash node: no excerpt
		expect(lines).toContain("  ✓ collect");
		// prompt node: excerpt of assistant text
		expect(lines).toContain("  ✓ summarize: Hello! How can I help?");
		expect(lines.at(-1)).toBe(
			"  view: /procedures status rid-1  ·  /observatory → Procedures",
		);
	});

	test("collapses multi-line / whitespace assistant text into one line", () => {
		const lines = formatProcedureReceipt({
			workflow: { ...wf, nodes: [{ id: "p", prompt: "x" } as never] },
			runId: "rid-2",
			finalStatus: "completed",
			durationMs: 1_000,
			nodeOutputs: new Map([["p", completed("line one\n\nline two")]]),
		});
		expect(lines).toContain("  ✓ p: line one line two");
	});

	test("truncates long prompt excerpts with an ellipsis", () => {
		const long = "x".repeat(200);
		const lines = formatProcedureReceipt({
			workflow: { ...wf, nodes: [{ id: "p", prompt: "x" } as never] },
			runId: "rid-3",
			finalStatus: "completed",
			durationMs: 1_000,
			nodeOutputs: new Map([["p", completed(long)]]),
		});
		const row = lines.find((l) => l.startsWith("  ✓ p:")) ?? "";
		expect(row.length).toBeLessThan(long.length);
		expect(row.endsWith("…")).toBe(true);
	});

	test("failed status: ✗ header, ✗ row with error excerpt", () => {
		const lines = formatProcedureReceipt({
			workflow: wf,
			runId: "rid-4",
			finalStatus: "failed",
			durationMs: 2_500,
			nodeOutputs: new Map([
				["collect", completed()],
				["summarize", failed("model timeout")],
			]),
		});
		expect(lines[0].startsWith("✗ ")).toBe(true);
		expect(lines[0]).toContain("failed in 2.5s");
		expect(lines).toContain("  ✓ collect");
		expect(lines).toContain("  ✗ summarize: model timeout");
	});

	test("cancelled status: ⊘ header, cancel reason line, skipped rows for unrun nodes", () => {
		const lines = formatProcedureReceipt({
			workflow: wf,
			runId: "rid-5",
			finalStatus: "cancelled",
			durationMs: 800,
			cancelReason: "BUG path",
			nodeOutputs: new Map([
				["collect", completed()],
				["summarize", skipped()],
			]),
		});
		expect(lines[0].startsWith("⊘ ")).toBe(true);
		expect(lines).toContain("  cancel: BUG path");
		expect(lines).toContain("  · summarize (skipped)");
	});
});
