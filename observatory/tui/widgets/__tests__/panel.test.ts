import { describe, expect, test } from "bun:test";
import { panel } from "../panel.ts";
import { visibleWidth } from "../text.ts";

describe("panel widget", () => {
	test("returns body length + 2 lines (top border + body + bottom border)", () => {
		const out = panel({ title: "Hello", body: ["one", "two", "three"], width: 30 });
		expect(out).toHaveLength(5);
	});

	test("every line is padded to exactly the requested visible width", () => {
		const out = panel({ title: "Lenses", body: ["✓ 2 ok"], width: 24 });
		for (const line of out) {
			expect(visibleWidth(line)).toBe(24);
		}
	});

	test("top border embeds the title with leading dash and surrounding spaces", () => {
		const out = panel({ title: "Lenses", body: [], width: 20 });
		expect(out[0]).toContain("Lenses");
		expect(out[0].startsWith("╭─")).toBe(true);
		expect(out[0].endsWith("╮")).toBe(true);
	});

	test("empty body still emits top + bottom border (2-line panel)", () => {
		const out = panel({ title: "x", body: [], width: 16 });
		expect(out).toHaveLength(2);
		expect(out[0].startsWith("╭")).toBe(true);
		expect(out[1].startsWith("╰")).toBe(true);
	});

	test("very long title is truncated so panel still fits its width", () => {
		const out = panel({ title: "x".repeat(80), body: [], width: 20 });
		expect(visibleWidth(out[0])).toBe(20);
	});

	test("does not invoke colorize when none is provided (default no-color)", () => {
		const out = panel({ title: "t", body: ["b"], width: 12 });
		// No ANSI escape codes from colorize itself (truncation may inject some)
		expect(out.some((l) => l.includes("\x1b[31m"))).toBe(false);
	});

	test("invokes colorize with border key for borders by default", () => {
		const calls: string[] = [];
		panel({
			title: "t",
			body: ["b"],
			width: 12,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls.every((k) => k === "border")).toBe(true);
		expect(calls.length).toBeGreaterThan(0);
	});

	test("uses borderAccent key when accent is true", () => {
		const calls: string[] = [];
		panel({
			title: "t",
			body: ["b"],
			width: 12,
			accent: true,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls.every((k) => k === "borderAccent")).toBe(true);
	});

	test("body lines are truncated to inner width and padded", () => {
		const out = panel({ title: "x", body: ["x".repeat(50)], width: 12 });
		expect(visibleWidth(out[1])).toBe(12);
	});
});
