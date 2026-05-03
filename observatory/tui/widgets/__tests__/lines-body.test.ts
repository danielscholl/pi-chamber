// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { linesBody } from "../lines-body.ts";
import { visibleWidth } from "../text.ts";

describe("linesBody numbered", () => {
	test("returns empty for no items", () => {
		expect(linesBody({ items: [], width: 40, style: "numbered" })).toEqual(
			[],
		);
	});

	test("emits one line per item with two-digit padding", () => {
		const out = linesBody({
			items: ["alpha", "bravo", "charlie"],
			width: 40,
			style: "numbered",
		});
		expect(out.length).toBe(3);
		expect(out[0]).toContain("01");
		expect(out[0]).toContain("alpha");
		expect(out[2]).toContain("03");
	});

	test("expands prefix width to fit large item counts", () => {
		const items: string[] = [];
		for (let i = 0; i < 12; i++) items.push(`item${i}`);
		const out = linesBody({ items, width: 40, style: "numbered" });
		// 12 items so prefix should still be 2 cols (max(2, len("12")=2))
		expect(out[0]).toMatch(/^01\s/);
		expect(out[11]).toMatch(/^12\s/);
	});

	test("each line is padded to width", () => {
		const out = linesBody({
			items: ["a", "b"],
			width: 32,
			style: "numbered",
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(32);
		}
	});

	test("invokes colorize('dim') for the prefix", () => {
		const calls: string[] = [];
		linesBody({
			items: ["a"],
			width: 20,
			style: "numbered",
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("dim");
	});
});

describe("linesBody bullet", () => {
	test("uses bullet glyph", () => {
		const out = linesBody({
			items: ["alpha"],
			width: 20,
			style: "bullet",
		});
		expect(out[0]).toContain("•");
		expect(out[0]).toContain("alpha");
	});

	test("each line is padded to width", () => {
		const out = linesBody({
			items: ["a", "bb", "ccc"],
			width: 24,
			style: "bullet",
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(24);
		}
	});
});
