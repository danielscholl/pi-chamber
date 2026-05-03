// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	normalizeStatusBoard,
	renderStatusBoard,
	statusTier,
	tierGlyph,
} from "./render-status-board.ts";

describe("statusTier classification", () => {
	test("classifies err keywords first", () => {
		expect(statusTier("Failed to spawn")).toBe("err");
		expect(statusTier("error: stuck")).toBe("err");
		expect(statusTier("DOWN")).toBe("err");
	});

	test("classifies warn keywords", () => {
		expect(statusTier("warning: stale")).toBe("warn");
		expect(statusTier("pending review")).toBe("warn");
		expect(statusTier("DEGRADED state")).toBe("warn");
	});

	test("classifies ok keywords", () => {
		expect(statusTier("running smoothly")).toBe("ok");
		expect(statusTier("Healthy")).toBe("ok");
		expect(statusTier("OK")).toBe("ok");
	});

	test("falls back to idle for unknown text", () => {
		expect(statusTier("thinking")).toBe("idle");
		expect(statusTier("")).toBe("idle");
		expect(statusTier(undefined)).toBe("idle");
	});
});

describe("tierGlyph", () => {
	test("returns one glyph per tier", () => {
		expect(tierGlyph("ok")).toBe("●");
		expect(tierGlyph("warn")).toBe("◐");
		expect(tierGlyph("err")).toBe("✗");
		expect(tierGlyph("idle")).toBe("○");
	});
});

describe("normalizeStatusBoard", () => {
	test("returns empty array for non-object/non-array data", () => {
		expect(normalizeStatusBoard(null)).toEqual([]);
		expect(normalizeStatusBoard("hello")).toEqual([]);
		expect(normalizeStatusBoard(7)).toEqual([]);
	});

	test("wraps a single object as a one-entry list", () => {
		const out = normalizeStatusBoard({ name: "ops", status: "running" });
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe("ops");
		expect(out[0].tier).toBe("ok");
	});

	test("uses title or id when name is missing", () => {
		expect(normalizeStatusBoard([{ title: "From Title", status: "" }])[0].name).toBe(
			"From Title",
		);
		expect(normalizeStatusBoard([{ id: "fallback", status: "" }])[0].name).toBe(
			"fallback",
		);
		expect(normalizeStatusBoard([{ status: "" }])[0].name).toBe("(unnamed)");
	});

	test("caps extras at 4 fields, replaces underscores in keys, and stringifies", () => {
		const entry = normalizeStatusBoard([
			{
				name: "moneypenny",
				status: "thinking",
				role: "speaker",
				turns: 4,
				last_reply: "hi",
				meta: { foo: 1 },
				ignored_a: 1,
				ignored_b: 2,
			},
		])[0];
		expect(entry.extras).toHaveLength(4);
		expect(entry.extras.map((e) => e.key)).toContain("last reply");
		expect(entry.extras.find((e) => e.key === "meta")?.value).toBe('{"foo":1}');
	});
});

describe("renderStatusBoard", () => {
	test("renders an empty-state message when there are no entries", () => {
		const out = renderStatusBoard([], 40);
		expect(out.join("\n")).toMatch(/no entries/);
	});

	test("renders one block per entry with glyph and status badge", () => {
		const out = renderStatusBoard(
			[
				{ name: "ops", status: "running", role: "speaker" },
				{ name: "scribe", status: "thinking" },
			],
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("● ops");
		expect(text).toContain("[running]");
		expect(text).toContain("○ scribe");
		expect(text).toContain("role: speaker");
	});

	test("truncates lines to width", () => {
		const wide = "x".repeat(80);
		const out = renderStatusBoard([{ name: wide, status: "running" }], 20);
		for (const line of out) {
			expect(line.length).toBeLessThanOrEqual(20);
		}
	});
});
