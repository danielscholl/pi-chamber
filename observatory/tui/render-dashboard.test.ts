// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
import type { DiscoveryEntry } from "../core.ts";
import {
	formatRelativeTime,
	lensesActivitySummary,
	renderDashboard,
} from "./render-dashboard.ts";
import { visibleWidth } from "./widgets/text.ts";

function entry(id: string, kind: "briefing" | "status-board" = "briefing"): DiscoveryEntry {
	return {
		id,
		status: "ok",
		manifest: { id, name: id, kind, source: "data.json" },
	};
}

describe("renderDashboard", () => {
	test("includes all four panel headers", () => {
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				minds: [],
				activity: null,
				now: Date.now(),
			},
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("Lenses");
		expect(text).toContain("Room");
		expect(text).toContain("Minds");
		expect(text).toContain("Activity");
	});

	test("Lenses panel shows ok and invalid counts", () => {
		const out = renderDashboard(
			{
				entries: [
					entry("ops"),
					entry("room", "status-board"),
					{ id: "broken", status: "invalid", reason: "missing lens.json" },
				],
				roomData: null,
				minds: [],
				activity: null,
				now: Date.now(),
			},
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("✓ 2 ok");
		expect(text).toContain("⚠ 1 invalid");
	});

	test("Room panel summarises participant snapshots", () => {
		const now = Date.now();
		const out = renderDashboard(
			{
				entries: [],
				roomData: [
					{ name: "moneypenny", status: "thinking" },
					{ name: "scribe", status: "ready" },
				],
				minds: [],
				activity: null,
				now,
			},
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("2 participants");
		expect(text).toContain("moneypenny");
		expect(text).toContain("scribe");
	});

	test("Room panel falls back to inactive when no participants", () => {
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				minds: [],
				activity: null,
				now: Date.now(),
			},
			60,
		);
		expect(out.join("\n")).toContain("inactive");
	});

	test("Minds panel lists count and slugs", () => {
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				minds: ["scribe", "ops", "moneypenny"],
				activity: null,
				now: Date.now(),
			},
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("3 available");
		expect(text).toContain("scribe");
		expect(text).toContain("ops");
	});

	test("Activity panel shows relative time when available", () => {
		const now = Date.now();
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				minds: [],
				activity: { lensId: "room", mtimeMs: now - 4 * 60_000 },
				now,
			},
			60,
		);
		const text = out.join("\n");
		expect(text).toContain("4m ago");
		expect(text).toContain("room");
	});

	test("each line respects the width budget", () => {
		const out = renderDashboard(
			{
				entries: [entry("ops")],
				roomData: null,
				minds: ["a", "b", "c", "d"],
				activity: null,
				now: Date.now(),
			},
			32,
		);
		for (const line of out) {
			// visibleWidth (not .length) is the terminal-column constraint;
			// truncated body text may carry ANSI reset codes around the ellipsis.
			expect(visibleWidth(line)).toBeLessThanOrEqual(32);
		}
	});
});

describe("formatRelativeTime", () => {
	test("buckets seconds, minutes, hours and days", () => {
		expect(formatRelativeTime(2_000)).toBe("just now");
		expect(formatRelativeTime(20_000)).toBe("20s ago");
		expect(formatRelativeTime(2 * 60_000)).toBe("2m ago");
		expect(formatRelativeTime(2 * 60 * 60_000)).toBe("2h ago");
		expect(formatRelativeTime(2 * 24 * 60 * 60_000)).toBe("2d ago");
	});

	test("clamps negative deltas", () => {
		expect(formatRelativeTime(-5_000)).toBe("just now");
	});
});

describe("lensesActivitySummary", () => {
	test("returns null when the root does not exist", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-activity-"));
		try {
			expect(lensesActivitySummary(path.join(tmp, "missing"))).toBeNull();
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("returns the most recently modified non-manifest file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-activity-"));
		try {
			const lensesRoot = path.join(tmp, "lenses");
			fs.mkdirSync(path.join(lensesRoot, "ops"), { recursive: true });
			fs.mkdirSync(path.join(lensesRoot, "room"), { recursive: true });
			fs.writeFileSync(path.join(lensesRoot, "ops", "lens.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "ops", "data.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "room", "lens.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "room", "data.json"), "{}");

			const opsData = path.join(lensesRoot, "ops", "data.json");
			const roomData = path.join(lensesRoot, "room", "data.json");
			fs.utimesSync(opsData, new Date(2025, 0, 1), new Date(2025, 0, 1));
			fs.utimesSync(roomData, new Date(2026, 0, 1), new Date(2026, 0, 1));

			const summary = lensesActivitySummary(lensesRoot);
			expect(summary?.lensId).toBe("room");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
