// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { metricsBody } from "../metrics-body.ts";
import { visibleWidth } from "../text.ts";

describe("metricsBody", () => {
	test("returns empty for no metrics", () => {
		expect(metricsBody({ metrics: [], width: 40 })).toEqual([]);
	});

	test("strip layout: emits 2 lines (labels then values) when fitting", () => {
		const out = metricsBody({
			metrics: [
				{ label: "inbox", value: "3" },
				{ label: "domains", value: "2" },
			],
			width: 60,
		});
		expect(out.length).toBe(2);
		expect(out[0]).toContain("inbox");
		expect(out[0]).toContain("domains");
		expect(out[1]).toContain("3");
		expect(out[1]).toContain("2");
	});

	test("strip layout: aligns values under labels", () => {
		const out = metricsBody({
			metrics: [
				{ label: "inbox", value: "3" },
				{ label: "domains", value: "2" },
			],
			width: 60,
		});
		// Both rows should have the same length and the value should sit
		// at the same column as the label start.
		const inboxAt = out[0].indexOf("inbox");
		const threeAt = out[1].indexOf("3");
		expect(inboxAt).toBe(threeAt);
	});

	test("vertical layout: when too narrow for strip", () => {
		const out = metricsBody({
			metrics: [
				{ label: "inbox items", value: "3" },
				{ label: "active initiatives", value: "5" },
				{ label: "domains", value: "2" },
			],
			width: 24,
		});
		expect(out.length).toBe(3);
	});

	test("vertical layout: when more than 4 metrics", () => {
		const out = metricsBody({
			metrics: [
				{ label: "a", value: "1" },
				{ label: "b", value: "2" },
				{ label: "c", value: "3" },
				{ label: "d", value: "4" },
				{ label: "e", value: "5" },
			],
			width: 80,
		});
		expect(out.length).toBe(5);
	});

	test("each line is padded to width", () => {
		const out = metricsBody({
			metrics: [
				{ label: "inbox", value: "3" },
				{ label: "domains", value: "2" },
			],
			width: 50,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(50);
		}
	});

	test("invokes colorize for dim (labels) and bold (values)", () => {
		const calls: string[] = [];
		metricsBody({
			metrics: [{ label: "x", value: "1" }],
			width: 30,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("dim");
		expect(calls).toContain("bold");
	});
});
