// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import { dagGraph } from "../dag-graph.ts";
import type { Colorize } from "../types.ts";

describe("dagGraph", () => {
	test("returns an empty array when there are no layers", () => {
		expect(dagGraph({ layers: [], nodes: {}, edges: [], width: 80 })).toEqual([]);
	});

	test("renders a linear chain with single-column connectors", () => {
		const out = dagGraph({
			layers: [["a"], ["b"], ["c"]],
			nodes: {
				a: { label: "scan", status: "completed" },
				b: { label: "summarize", status: "running" },
				c: { label: "classify", status: "pending" },
			},
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
			],
			width: 80,
		});
		// Three boxes (3 lines each) + two single-line connectors = 11 lines.
		expect(out.length).toBe(11);
		// Check each box's status glyph appears on its label row.
		expect(out[1]).toContain("● scan");
		expect(out[5]).toContain("◐ summarize");
		expect(out[9]).toContain("○ classify");
		// Connectors collapse to a single │ for aligned 1-edge seams.
		expect(out[3].trim()).toBe("│");
		expect(out[7].trim()).toBe("│");
	});

	test("renders fan-out with bus row and corner glyphs", () => {
		const out = dagGraph({
			layers: [["a"], ["b", "c"]],
			nodes: {
				a: { label: "split", status: "completed" },
				b: { label: "left", status: "completed" },
				c: { label: "right", status: "failed" },
			},
			edges: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
			],
			width: 80,
		});
		// 3 box rows + 3 connector rows + 3 box rows = 9 lines.
		expect(out.length).toBe(9);
		// Bus row contains ├ at parent's anchor (also a child anchor) and ┐ at
		// the rightmost child-only anchor.
		const bus = out[4];
		expect(bus).toContain("├");
		expect(bus).toContain("┐");
		expect(bus).toContain("─");
		// Verify both child boxes appear on their label row.
		expect(out[7]).toContain("● left");
		expect(out[7]).toContain("✗ right");
	});

	test("renders fan-in with the converging bus on the bottom edge", () => {
		const out = dagGraph({
			layers: [["a", "b"], ["c"]],
			nodes: {
				a: { label: "left", status: "completed" },
				b: { label: "right", status: "completed" },
				c: { label: "merge", status: "running" },
			},
			edges: [
				{ from: "a", to: "c" },
				{ from: "b", to: "c" },
			],
			width: 80,
		});
		expect(out.length).toBe(9);
		const bus = out[4];
		// Two-parent fan-in collapsing to one child: `├` at converged column,
		// `┘` at the rightmost parent-only column.
		expect(bus).toContain("├");
		expect(bus).toContain("┘");
		expect(out[7]).toContain("◐ merge");
	});

	test("status glyphs map to the right tier", () => {
		const out = dagGraph({
			layers: [["a", "b", "c", "d", "e"]],
			nodes: {
				a: { label: "a", status: "completed" }, // ● ok
				b: { label: "b", status: "running" }, //   ◐ warn
				c: { label: "c", status: "failed" }, //    ✗ err
				d: { label: "d", status: "skipped" }, //   ○ idle
				e: { label: "e", status: "pending" }, //   ○ idle
			},
			edges: [],
			width: 120,
		});
		const labels = out[1];
		expect(labels).toContain("● a");
		expect(labels).toContain("◐ b");
		expect(labels).toContain("✗ c");
		expect(labels).toContain("○ d");
		expect(labels).toContain("○ e");
	});

	test("wide-layer fallback wraps boxes onto multiple sub-rows", () => {
		const wide = dagGraph({
			layers: [["a"], ["b", "c", "d", "e", "f"], ["g"]],
			nodes: Object.fromEntries(
				["a", "b", "c", "d", "e", "f", "g"].map(
					(id) => [id, { label: id, status: "pending" as const }],
				),
			),
			edges: [
				{ from: "a", to: "b" },
				{ from: "a", to: "c" },
				{ from: "a", to: "d" },
				{ from: "a", to: "e" },
				{ from: "a", to: "f" },
				{ from: "b", to: "g" },
				{ from: "c", to: "g" },
				{ from: "d", to: "g" },
				{ from: "e", to: "g" },
				{ from: "f", to: "g" },
			],
			width: 60,
		});
		// The middle layer wraps because 5 boxes don't fit in width 60. Look for
		// an empty separator line, which only appears between wrap rows.
		const hasEmptySeparator = wide.some((line) => line === "");
		expect(hasEmptySeparator).toBe(true);
	});

	test("selectedId triggers the colorize selectedBg key on that node's label row only", () => {
		const calls: Array<{ key: string; text: string }> = [];
		const colorize: Colorize = (key, text) => {
			calls.push({ key, text });
			return text;
		};
		dagGraph({
			layers: [["a"], ["b"]],
			nodes: {
				a: { label: "alpha", status: "completed" },
				b: { label: "beta", status: "running" },
			},
			edges: [{ from: "a", to: "b" }],
			width: 80,
			selectedId: "b",
			colorize,
		});
		const sel = calls.find((c) => c.key === "selectedBg");
		expect(sel).toBeDefined();
		expect(sel?.text).toContain("beta");
	});

	test("rendering is deterministic for the same input", () => {
		const input = {
			layers: [["a"], ["b"]],
			nodes: {
				a: { label: "one", status: "completed" as const },
				b: { label: "two", status: "running" as const },
			},
			edges: [{ from: "a", to: "b" }],
			width: 80,
		};
		expect(dagGraph(input)).toEqual(dagGraph(input));
	});

	test("badge appears inside the box label row", () => {
		const out = dagGraph({
			layers: [["a"]],
			nodes: { a: { label: "node", status: "completed", badge: "1.2k" } },
			edges: [],
			width: 80,
		});
		expect(out[1]).toContain("1.2k");
	});
});
