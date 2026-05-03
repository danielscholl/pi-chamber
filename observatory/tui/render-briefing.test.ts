// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { normalizeBriefing, renderBriefing } from "./render-briefing.ts";

describe("normalizeBriefing", () => {
	test("returns empty for non-object data", () => {
		expect(normalizeBriefing(null)).toEqual([]);
		expect(normalizeBriefing("hi")).toEqual([]);
		expect(normalizeBriefing([1, 2])).toEqual([]);
	});

	test("classifies numbers, strings, booleans, null and json blobs", () => {
		const rows = normalizeBriefing({
			active_minds: 3,
			ready: true,
			top_priority: "Ship it",
			notes: null,
			meta: { foo: 1 },
		});
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey["active minds"].tier).toBe("number");
		expect(byKey.ready.tier).toBe("boolean");
		expect(byKey["top priority"].tier).toBe("string");
		expect(byKey.notes.tier).toBe("null");
		expect(byKey.notes.value).toBe("—");
		expect(byKey.meta.tier).toBe("json");
		expect(byKey.meta.value).toBe('{"foo":1}');
	});
});

describe("renderBriefing", () => {
	test("renders an empty-state for non-object data", () => {
		expect(renderBriefing(null, 60).join("\n")).toMatch(/empty briefing/);
		expect(renderBriefing("hi", 60).join("\n")).toMatch(/empty briefing/);
		expect(renderBriefing([1, 2, 3], 60).join("\n")).toMatch(/empty briefing/);
	});

	test("renders a no-fields message for an empty object", () => {
		expect(renderBriefing({}, 60).join("\n")).toMatch(/no fields/);
	});

	test("renders aligned key/value rows", () => {
		const out = renderBriefing(
			{
				active_minds: 3,
				top_priority: "Ship the TUI rewrite",
			},
			60,
		);
		const joined = out.join("\n");
		expect(joined).toContain("active minds");
		expect(joined).toContain("3");
		expect(joined).toContain("top priority");
		expect(joined).toContain("Ship the TUI rewrite");
	});

	test("truncates long values when expandValues is false", () => {
		const long = "a really long sentence ".repeat(20);
		const out = renderBriefing({ note: long }, 40);
		expect(out.length).toBe(1);
		expect(out[0].length).toBeLessThanOrEqual(40);
		expect(out[0].endsWith("…")).toBe(true);
	});

	test("wraps long values when expandValues is true", () => {
		const long = "alpha bravo charlie delta echo foxtrot golf hotel india";
		const out = renderBriefing({ note: long }, 40, true);
		expect(out.length).toBeGreaterThan(1);
		for (const line of out) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});

	test("each line is bounded by width", () => {
		const out = renderBriefing(
			{
				k1: 1,
				k2: "hello",
				k3: true,
			},
			32,
		);
		for (const line of out) {
			expect(line.length).toBeLessThanOrEqual(32);
		}
	});

	test("routes to page renderer when sectioned data + manifest are provided", () => {
		const manifest = { name: "Test", kind: "briefing" as const };
		const out = renderBriefing(
			{
				priority: { title: "Top", body: "ship it" },
				metrics: [{ label: "k", value: 1 }],
			},
			60,
			false,
			undefined,
			manifest,
		);
		const joined = out.join("\n");
		expect(joined).toContain("Test");
		expect(joined).toContain("METRICS");
		expect(joined).toContain("Top");
	});

	test("falls back to flat card grid when sectioned data has no manifest", () => {
		const out = renderBriefing(
			{
				priority: { title: "Top", body: "ship it" },
				metrics: [{ label: "k", value: 1 }],
			},
			60,
		);
		// Without a manifest the flat path runs; priority and metrics become
		// JSON-stringified card values.
		const joined = out.join("\n");
		expect(joined).not.toContain("METRICS");
	});
});
