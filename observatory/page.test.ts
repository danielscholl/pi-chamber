// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	isSectionedShape,
	parseBriefingPage,
	parseDetails,
	parseLists,
	parseMetrics,
	parseNarrative,
	parsePriority,
	parseStringArray,
} from "./page.ts";

describe("isSectionedShape", () => {
	test("rejects non-objects", () => {
		expect(isSectionedShape(null)).toBe(false);
		expect(isSectionedShape(undefined)).toBe(false);
		expect(isSectionedShape(42)).toBe(false);
		expect(isSectionedShape("hi")).toBe(false);
		expect(isSectionedShape(true)).toBe(false);
	});

	test("rejects arrays", () => {
		expect(isSectionedShape([])).toBe(false);
		expect(isSectionedShape([{ priority: "x" }])).toBe(false);
	});

	test("rejects flat-only briefings", () => {
		expect(isSectionedShape({ inbox_items: 3, top_priority: "x" })).toBe(false);
		expect(isSectionedShape({})).toBe(false);
	});

	test("accepts any reserved key, even alone", () => {
		expect(isSectionedShape({ summary: "hi" })).toBe(true);
		expect(isSectionedShape({ status: "running" })).toBe(true);
		expect(isSectionedShape({ priority: {} })).toBe(true);
		expect(isSectionedShape({ metrics: [] })).toBe(true);
		expect(isSectionedShape({ activity: [] })).toBe(true);
		expect(isSectionedShape({ lists: [] })).toBe(true);
		expect(isSectionedShape({ narrative: [] })).toBe(true);
		expect(isSectionedShape({ details: {} })).toBe(true);
	});

	test("accepts mixed reserved + flat keys", () => {
		expect(isSectionedShape({ priority: { title: "x", body: "y" }, foo: 1 })).toBe(
			true,
		);
	});
});

describe("parsePriority", () => {
	test("returns null and warns for non-objects", () => {
		const w: string[] = [];
		expect(parsePriority(null, w)).toBeNull();
		expect(parsePriority("hi", w)).toBeNull();
		expect(parsePriority([], w)).toBeNull();
		expect(w.length).toBe(3);
	});

	test("requires non-empty title and body", () => {
		const w: string[] = [];
		expect(parsePriority({ title: "", body: "x" }, w)).toBeNull();
		expect(parsePriority({ title: "x", body: "" }, w)).toBeNull();
		expect(parsePriority({ title: "x" }, w)).toBeNull();
		expect(parsePriority({ body: "x" }, w)).toBeNull();
		expect(w.length).toBe(4);
	});

	test("happy path keeps title trimmed and body verbatim", () => {
		const w: string[] = [];
		const p = parsePriority({ title: "  Top  ", body: "  Ship it." }, w);
		expect(p).toEqual({ title: "Top", body: "  Ship it." });
		expect(w).toEqual([]);
	});

	test("accepts known severities", () => {
		const w: string[] = [];
		expect(parsePriority({ title: "x", body: "y", severity: "warn" }, w)?.severity).toBe(
			"warn",
		);
		expect(parsePriority({ title: "x", body: "y", severity: "ok" }, w)?.severity).toBe(
			"ok",
		);
		expect(w).toEqual([]);
	});

	test("drops unknown severity but keeps priority", () => {
		const w: string[] = [];
		const p = parsePriority({ title: "x", body: "y", severity: "spicy" }, w);
		expect(p).toEqual({ title: "x", body: "y" });
		expect(w[0]).toMatch(/severity/);
	});
});

describe("parseMetrics", () => {
	test("rejects non-arrays with a warning", () => {
		const w: string[] = [];
		expect(parseMetrics({}, w)).toBeNull();
		expect(parseMetrics("hi", w)).toBeNull();
		expect(w.length).toBe(2);
	});

	test("happy path stringifies numbers and keeps strings", () => {
		const w: string[] = [];
		const m = parseMetrics(
			[
				{ label: "inbox", value: 3 },
				{ label: "load", value: "1.2k" },
				{ label: "ok", value: true },
			],
			w,
		);
		expect(m).toEqual([
			{ label: "inbox", value: "3" },
			{ label: "load", value: "1.2k" },
			{ label: "ok", value: "true" },
		]);
		expect(w).toEqual([]);
	});

	test("skips bad entries individually but keeps good ones", () => {
		const w: string[] = [];
		const m = parseMetrics(
			[
				{ label: "good", value: 1 },
				null,
				{ label: "" },
				{ label: "x", value: { foo: "bar" } },
				{ label: "also-good", value: 2 },
			],
			w,
		);
		expect(m).toEqual([
			{ label: "good", value: "1" },
			{ label: "also-good", value: "2" },
		]);
		expect(w.length).toBe(3);
	});

	test("non-finite numbers are unsupported", () => {
		const w: string[] = [];
		expect(parseMetrics([{ label: "n", value: Number.NaN }], w)).toEqual([]);
		expect(parseMetrics([{ label: "n", value: Number.POSITIVE_INFINITY }], w)).toEqual(
			[],
		);
	});

	test("null/undefined values render as em-dash placeholder", () => {
		const w: string[] = [];
		expect(parseMetrics([{ label: "n", value: null }], w)).toEqual([
			{ label: "n", value: "—" },
		]);
	});
});

describe("parseStringArray", () => {
	test("rejects non-arrays", () => {
		const w: string[] = [];
		expect(parseStringArray({}, "activity", w)).toBeNull();
		expect(w[0]).toMatch(/activity/);
	});

	test("filters out non-strings and empty strings", () => {
		const w: string[] = [];
		const out = parseStringArray(["a", "", null, 3, "b"], "activity", w);
		expect(out).toEqual(["a", "b"]);
		expect(w.length).toBe(3);
	});
});

describe("parseLists", () => {
	test("requires array", () => {
		const w: string[] = [];
		expect(parseLists({}, w)).toBeNull();
	});

	test("defaults style to bullet, accepts inline", () => {
		const w: string[] = [];
		const ls = parseLists(
			[
				{ title: "Domains", items: ["a", "b"] },
				{ title: "Tags", items: ["x"], style: "inline" },
			],
			w,
		);
		expect(ls).toEqual([
			{ title: "Domains", items: ["a", "b"], style: "bullet" },
			{ title: "Tags", items: ["x"], style: "inline" },
		]);
		expect(w).toEqual([]);
	});

	test("warns and defaults bad style", () => {
		const w: string[] = [];
		const ls = parseLists([{ title: "T", items: ["x"], style: "weird" }], w);
		expect(ls).toEqual([{ title: "T", items: ["x"], style: "bullet" }]);
		expect(w[0]).toMatch(/style/);
	});

	test("skips entries missing title or items", () => {
		const w: string[] = [];
		const ls = parseLists(
			[
				{ title: "", items: ["x"] },
				{ title: "ok", items: "not-array" },
				{ title: "ok", items: ["a", 3, ""] },
			],
			w,
		);
		expect(ls).toEqual([{ title: "ok", items: ["a"], style: "bullet" }]);
		expect(w.length).toBeGreaterThanOrEqual(3);
	});
});

describe("parseNarrative", () => {
	test("requires array", () => {
		const w: string[] = [];
		expect(parseNarrative({}, w)).toBeNull();
	});

	test("happy path trims heading, keeps body verbatim", () => {
		const w: string[] = [];
		const n = parseNarrative(
			[{ heading: "  H  ", body: "Multi-paragraph body.\n\nAnother." }],
			w,
		);
		expect(n).toEqual([
			{ heading: "H", body: "Multi-paragraph body.\n\nAnother." },
		]);
	});

	test("skips items missing heading or body", () => {
		const w: string[] = [];
		const n = parseNarrative(
			[
				{ heading: "", body: "x" },
				{ heading: "h", body: "" },
				{ heading: "h", body: "b" },
			],
			w,
		);
		expect(n).toEqual([{ heading: "h", body: "b" }]);
		expect(w.length).toBe(2);
	});
});

describe("parseDetails", () => {
	test("rejects non-objects", () => {
		const w: string[] = [];
		expect(parseDetails([], w)).toBeNull();
		expect(parseDetails(null, w)).toBeNull();
	});

	test("preserves order, snakecases labels, stringifies values", () => {
		const w: string[] = [];
		const d = parseDetails(
			{
				audience: "first-timers",
				active_minds: 3,
				ready: true,
				notes: null,
				meta: { foo: 1 },
			},
			w,
		);
		expect(d).toEqual([
			{ label: "audience", value: "first-timers" },
			{ label: "active minds", value: "3" },
			{ label: "ready", value: "true" },
			{ label: "notes", value: "—" },
			{ label: "meta", value: '{"foo":1}' },
		]);
		expect(w).toEqual([]);
	});
});

describe("parseBriefingPage", () => {
	test("returns empty page with warning for non-objects", () => {
		const r = parseBriefingPage("hi");
		expect(r.page).toEqual({});
		expect(r.warnings.length).toBe(1);
	});

	test("composes a full page from a well-formed input", () => {
		const r = parseBriefingPage({
			summary: "Last updated 38m ago",
			status: "running",
			priority: {
				title: "Top Priority",
				body: "Ship the controls.",
				severity: "warn",
			},
			metrics: [
				{ label: "inbox items", value: 3 },
				{ label: "domains", value: 2 },
			],
			activity: ["a", "b"],
			lists: [{ title: "Domains", items: ["x"], style: "inline" }],
			narrative: [{ heading: "H", body: "B" }],
			details: { audience: "ops" },
		});
		expect(r.warnings).toEqual([]);
		expect(r.page.summary).toBe("Last updated 38m ago");
		expect(r.page.status).toBe("running");
		expect(r.page.priority?.severity).toBe("warn");
		expect(r.page.metrics?.length).toBe(2);
		expect(r.page.activity).toEqual(["a", "b"]);
		expect(r.page.lists?.[0].style).toBe("inline");
		expect(r.page.narrative?.[0]).toEqual({ heading: "H", body: "B" });
		expect(r.page.details?.[0]).toEqual({ label: "audience", value: "ops" });
	});

	test("partial input only fills present sections", () => {
		const r = parseBriefingPage({ status: "running", activity: ["a"] });
		expect(r.page.status).toBe("running");
		expect(r.page.activity).toEqual(["a"]);
		expect(r.page.priority).toBeUndefined();
		expect(r.page.metrics).toBeUndefined();
	});

	test("bad fields warn but do not block sibling sections", () => {
		const r = parseBriefingPage({
			summary: "",
			priority: { title: "ok", body: "b", severity: "spicy" },
			metrics: "not-an-array",
			activity: ["good", 3],
		});
		expect(r.page.summary).toBeUndefined();
		expect(r.page.priority).toEqual({ title: "ok", body: "b" });
		expect(r.page.metrics).toBeUndefined();
		expect(r.page.activity).toEqual(["good"]);
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	test("ignores unknown top-level keys", () => {
		const r = parseBriefingPage({
			status: "running",
			some_future_field: { foo: 1 },
		});
		expect(r.page.status).toBe("running");
		expect(r.warnings).toEqual([]);
	});
});
