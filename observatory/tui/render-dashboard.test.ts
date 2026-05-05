// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import { formatRelativeTime, renderDashboard } from "./render-dashboard.ts";
import { visibleWidth } from "./widgets/text.ts";

function entry(id: string, kind: "briefing" | "status-board" = "briefing"): DiscoveryEntry {
	return {
		id,
		status: "ok",
		manifest: { id, name: id, kind, source: "data.json" },
	};
}

describe("renderDashboard", () => {
	test("includes all five panel headers", () => {
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				proceduresData: null,
				minds: [],
				activity: null,
				now: Date.now(),
			},
			120,
		);
		const text = out.join("\n");
		expect(text).toContain("Lenses");
		expect(text).toContain("Room");
		expect(text).toContain("Procedures");
		expect(text).toContain("Minds");
		expect(text).toContain("Activity");
	});

	test("Procedures panel falls back to a hint when no runs are present", () => {
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				proceduresData: null,
				minds: [],
				activity: null,
				now: Date.now(),
			},
			120,
		);
		expect(out.join("\n")).toContain("no runs yet");
	});

	test("Procedures panel summarises last 3 runs from the lens data", () => {
		const now = Date.now();
		const out = renderDashboard(
			{
				entries: [],
				roomData: null,
				proceduresData: {
					generatedAt: new Date(now).toISOString(),
					runs: [
						{
							runId: "r1",
							workflowName: "demo",
							status: "completed",
							startedAt: new Date(now - 30_000).toISOString(),
							durationMs: 4100,
						},
						{
							runId: "r2",
							workflowName: "smoke",
							status: "failed",
							startedAt: new Date(now - 5 * 60_000).toISOString(),
							durationMs: 1200,
						},
					],
					current: null,
				},
				minds: [],
				activity: null,
				now,
			},
			200,
		);
		const text = out.join("\n");
		expect(text).toContain("2 recent runs");
		expect(text).toContain("demo");
		expect(text).toContain("smoke");
		expect(text).toContain("✓");
		expect(text).toContain("✗");
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
				proceduresData: null,
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
				proceduresData: null,
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
				proceduresData: null,
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
				proceduresData: null,
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
				proceduresData: null,
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
				proceduresData: null,
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
