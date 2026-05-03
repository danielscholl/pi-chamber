import { describe, expect, test } from "bun:test";
import { statusPill, tierColorKey } from "../status-pill.ts";

describe("statusPill widget", () => {
	test("returns a single line with glyph + label for each tier", () => {
		expect(statusPill("ok", "ops")).toBe("● ops");
		expect(statusPill("warn", "ops")).toBe("◐ ops");
		expect(statusPill("err", "ops")).toBe("✗ ops");
		expect(statusPill("idle", "ops")).toBe("○ ops");
	});

	test("does not invoke colorize when none provided (default no-color)", () => {
		const out = statusPill("ok", "ops");
		expect(out.includes("\x1b[")).toBe(false);
	});

	test("invokes colorize on the glyph with the tier color key", () => {
		const calls: Array<{ key: string; text: string }> = [];
		statusPill("warn", "ops", (key, text) => {
			calls.push({ key, text });
			return text;
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].key).toBe("warn");
		expect(calls[0].text).toBe("◐");
	});
});

describe("tierColorKey", () => {
	test("maps tiers to color keys", () => {
		expect(tierColorKey("ok")).toBe("success");
		expect(tierColorKey("warn")).toBe("warn");
		expect(tierColorKey("err")).toBe("error");
		expect(tierColorKey("idle")).toBe("muted");
	});
});
