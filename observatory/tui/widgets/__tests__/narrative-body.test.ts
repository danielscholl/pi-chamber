// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { narrativeBody } from "../narrative-body.ts";
import { visibleWidth } from "../text.ts";

describe("narrativeBody", () => {
	test("returns empty for no items", () => {
		expect(narrativeBody({ items: [], width: 40 })).toEqual([]);
	});

	test("renders heading then wrapped body", () => {
		const out = narrativeBody({
			items: [
				{
					heading: "Audience",
					body: "First-time Pi operator who is technically comfortable but new to the chamber.",
				},
			],
			width: 40,
		});
		expect(out.length).toBeGreaterThan(1);
		expect(out[0]).toContain("Audience");
		const bodyJoined = out.slice(1).join("\n");
		expect(bodyJoined).toContain("First-time Pi operator");
	});

	test("inserts a blank line between items", () => {
		const out = narrativeBody({
			items: [
				{ heading: "A", body: "alpha" },
				{ heading: "B", body: "bravo" },
			],
			width: 30,
		});
		const aIndex = out.findIndex((l) => l.includes("A"));
		const bIndex = out.findIndex((l) => l.includes("B"));
		expect(aIndex).toBeLessThan(bIndex);
		// Between the last A line and the first B line there should be a blank.
		const between = out.slice(aIndex + 1, bIndex);
		expect(between.some((l) => l.trim() === "")).toBe(true);
	});

	test("each line is padded to width", () => {
		const out = narrativeBody({
			items: [{ heading: "H", body: "Some moderately long body text here." }],
			width: 28,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(28);
		}
	});

	test("invokes colorize('accent') for headings", () => {
		const calls: string[] = [];
		narrativeBody({
			items: [{ heading: "x", body: "y" }],
			width: 30,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("accent");
	});
});
