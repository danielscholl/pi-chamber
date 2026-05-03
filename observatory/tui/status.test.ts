// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	normalizeStatusBoard,
	statusTier,
	tierGlyph,
} from "./status.ts";

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

	test("classifies room participant verbs", () => {
		expect(statusTier("ready")).toBe("ok");
		expect(statusTier("speaking")).toBe("ok");
		expect(statusTier("done")).toBe("ok");
		expect(statusTier("thinking")).toBe("warn");
		expect(statusTier("aborted")).toBe("warn");
		expect(statusTier("error")).toBe("err");
	});

	test("falls back to idle for unknown text", () => {
		expect(statusTier("")).toBe("idle");
		expect(statusTier(undefined)).toBe("idle");
		expect(statusTier("foo bar")).toBe("idle");
	});

	test("requires a word boundary so short verbs do not collide mid-word", () => {
		// "already" must not classify as ok via "ready"; "undone" must not
		// classify as ok via "done"; "broken" must not classify as ok via "ok".
		expect(statusTier("already queued")).toBe("idle");
		expect(statusTier("undone work")).toBe("idle");
		expect(statusTier("forewarning")).toBe("idle");
		// "broken" must still classify as err, beating the now-stricter ok rule.
		expect(statusTier("broken pipeline")).toBe("err");
	});

	test("still treats classic keywords as prefixes at a word boundary", () => {
		expect(statusTier("warning")).toBe("warn");
		expect(statusTier("failing build")).toBe("err");
		expect(statusTier("running smoothly")).toBe("ok");
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
