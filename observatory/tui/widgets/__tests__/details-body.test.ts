// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { detailsBody } from "../details-body.ts";
import { visibleWidth } from "../text.ts";

describe("detailsBody", () => {
	test("returns empty for no rows", () => {
		expect(detailsBody({ rows: [], width: 40 })).toEqual([]);
	});

	test("renders aligned label/value rows", () => {
		const out = detailsBody({
			rows: [
				{ label: "audience", value: "first-timers" },
				{ label: "guardrails", value: "run from repo root" },
			],
			width: 50,
		});
		expect(out.length).toBe(2);
		expect(out[0]).toContain("audience");
		expect(out[0]).toContain("first-timers");
		expect(out[1]).toContain("guardrails");
	});

	test("each line is padded to width", () => {
		const out = detailsBody({
			rows: [
				{ label: "k1", value: "v1" },
				{ label: "k2", value: "v2" },
			],
			width: 40,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	test("truncates long values when expandValues is false", () => {
		const long = "really long value text ".repeat(10);
		const out = detailsBody({
			rows: [{ label: "note", value: long }],
			width: 40,
		});
		expect(out.length).toBe(1);
		expect(out[0].endsWith("…")).toBe(true);
	});

	test("wraps long values when expandValues is true", () => {
		const long =
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
		const out = detailsBody({
			rows: [{ label: "note", value: long }],
			width: 40,
			expandValues: true,
		});
		expect(out.length).toBeGreaterThan(1);
	});

	test("invokes colorize('dim') for labels", () => {
		const calls: string[] = [];
		detailsBody({
			rows: [{ label: "k", value: "v" }],
			width: 30,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("dim");
	});
});
