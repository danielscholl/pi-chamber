import { describe, expect, test } from "bun:test";
import { card } from "../card.ts";
import { visibleWidth } from "../text.ts";

describe("card widget", () => {
	test("returns exactly 4 lines (top border, label row, value row, bottom border)", () => {
		const out = card({ label: "Active Minds", value: "3", width: 24 });
		expect(out).toHaveLength(4);
	});

	test("every line is padded to exactly the requested visible width", () => {
		const out = card({ label: "Active Minds", value: "3", width: 24 });
		for (const line of out) {
			expect(visibleWidth(line)).toBe(24);
		}
	});

	test("label and value appear in the rendered output", () => {
		const out = card({ label: "Active Minds", value: "42", width: 30 });
		const joined = out.join("\n");
		expect(joined).toContain("Active Minds");
		expect(joined).toContain("42");
	});

	test("emoji is prefixed to the label when provided", () => {
		const out = card({ label: "Inbox", value: "5", width: 24, emoji: "#" });
		expect(out[1]).toContain("# Inbox");
	});

	test("emphasizeValue triggers colorize('bold', value)", () => {
		const calls: string[] = [];
		card({
			label: "x",
			value: "42",
			width: 16,
			emphasizeValue: true,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("bold");
	});

	test("does not invoke colorize('bold') when emphasizeValue is false", () => {
		const calls: string[] = [];
		card({
			label: "x",
			value: "42",
			width: 16,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).not.toContain("bold");
	});

	test("renders an em dash when value is empty", () => {
		const out = card({ label: "x", value: "", width: 12 });
		expect(out[2]).toContain("—");
	});

	test("does not emit ANSI escapes when no colorize is provided", () => {
		const out = card({ label: "x", value: "y", width: 12 });
		expect(out.some((l) => l.includes("\x1b["))).toBe(false);
	});

	test("long label is truncated to fit inner width", () => {
		const out = card({ label: "x".repeat(50), value: "y", width: 16 });
		expect(visibleWidth(out[1])).toBe(16);
	});
});
