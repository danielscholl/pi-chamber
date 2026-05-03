// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { inlineList } from "../inline-list.ts";
import { visibleWidth } from "../text.ts";

describe("inlineList", () => {
	test("returns empty for no items", () => {
		expect(inlineList({ items: [], width: 40 })).toEqual([]);
	});

	test("single line when items fit", () => {
		const out = inlineList({
			items: ["observatory", "agents", "tooling"],
			width: 60,
		});
		expect(out.length).toBe(1);
		expect(out[0]).toContain("observatory");
		expect(out[0]).toContain("agents");
		expect(out[0]).toContain("tooling");
		expect(out[0]).toContain("·");
	});

	test("wraps when items overflow width", () => {
		const out = inlineList({
			items: [
				"observatory",
				"agents",
				"tooling",
				"docs",
				"release-engineering",
				"qa",
			],
			width: 24,
		});
		expect(out.length).toBeGreaterThan(1);
	});

	test("each line is padded to width", () => {
		const out = inlineList({
			items: ["a", "b", "c"],
			width: 30,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(30);
		}
	});

	test("invokes colorize('dim') for separators", () => {
		const calls: string[] = [];
		inlineList({
			items: ["a", "b"],
			width: 20,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("dim");
	});
});
