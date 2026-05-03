// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import {
	clearNotification,
	createObservatoryViewState,
	invalidateLensData,
	notificationIsExpired,
	selectionForIndex,
	setEntries,
	setLensData,
	setMode,
	setNotification,
	setSelectedIndex,
	sidebarItemCount,
} from "./state.ts";

function manifestEntry(id: string): DiscoveryEntry {
	return {
		id,
		status: "ok",
		manifest: {
			id,
			name: id,
			kind: "briefing",
			source: "data.json",
		},
	};
}

describe("createObservatoryViewState", () => {
	test("starts at the dashboard with no entries", () => {
		const state = createObservatoryViewState();
		expect(state.selection).toEqual({ kind: "dashboard" });
		expect(state.selectedSidebarIndex).toBe(0);
		expect(state.mode).toBe("list");
		expect(state.entries).toEqual([]);
		expect(state.notification).toBeNull();
		expect(state.pendingG).toBe(false);
		expect(state.lensDataCache.size).toBe(0);
	});

	test("counts the dashboard plus one slot per lens entry", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		expect(sidebarItemCount(state)).toBe(3);
	});
});

describe("setSelectedIndex", () => {
	test("clamps to the dashboard when index is below zero", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, -5);
		expect(state.selectedSidebarIndex).toBe(0);
		expect(state.selection).toEqual({ kind: "dashboard" });
	});

	test("clamps to the last lens when index overshoots", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		setSelectedIndex(state, 99);
		expect(state.selectedSidebarIndex).toBe(2);
		expect(state.selection).toEqual({ kind: "lens", lensId: "room" });
	});

	test("resets body scroll when selection changes", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		state.bodyScrollOffset = 12;
		setSelectedIndex(state, 1);
		expect(state.bodyScrollOffset).toBe(0);
		expect(state.selection).toEqual({ kind: "lens", lensId: "ops" });
	});
});

describe("setEntries", () => {
	test("preserves a still-existing lens selection by id, not by index", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		setSelectedIndex(state, 2); // room
		setEntries(state, [manifestEntry("room"), manifestEntry("ops")]);
		expect(state.selection).toEqual({ kind: "lens", lensId: "room" });
		expect(state.selectedSidebarIndex).toBe(1);
	});

	test("falls back to the dashboard when the selected lens is gone", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 1);
		setEntries(state, []);
		expect(state.selection).toEqual({ kind: "dashboard" });
		expect(state.selectedSidebarIndex).toBe(0);
	});

	test("clamps a stale dashboard index when entries shrink", () => {
		const state = createObservatoryViewState([
			manifestEntry("a"),
			manifestEntry("b"),
		]);
		state.selectedSidebarIndex = 5; // simulate stale
		setEntries(state, [manifestEntry("a")]);
		expect(state.selectedSidebarIndex).toBeLessThanOrEqual(1);
	});
});

describe("selectionForIndex", () => {
	test("returns dashboard for index 0", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		expect(selectionForIndex(state, 0)).toEqual({ kind: "dashboard" });
	});

	test("returns lens selection for valid index", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		expect(selectionForIndex(state, 1)).toEqual({
			kind: "lens",
			lensId: "ops",
		});
	});

	test("returns dashboard for out-of-range index", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		expect(selectionForIndex(state, 99)).toEqual({ kind: "dashboard" });
	});
});

describe("setMode", () => {
	test("switching away from detail clears scroll offset", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		state.bodyScrollOffset = 7;
		state.mode = "detail";
		setMode(state, "list");
		expect(state.bodyScrollOffset).toBe(0);
	});
});

describe("notifications", () => {
	test("set, clear, and expiry tracking", () => {
		const state = createObservatoryViewState();
		setNotification(state, "Hello", "info", 1000);
		expect(state.notification?.message).toBe("Hello");
		expect(notificationIsExpired(state, Date.now() - 1)).toBe(false);
		expect(notificationIsExpired(state, Date.now() + 5000)).toBe(true);
		clearNotification(state);
		expect(state.notification).toBeNull();
	});
});

describe("lens data cache", () => {
	test("set and invalidate", () => {
		const state = createObservatoryViewState();
		setLensData(state, "ops", { ok: true, data: { x: 1 } });
		expect(state.lensDataCache.get("ops")).toEqual({ ok: true, data: { x: 1 } });
		invalidateLensData(state, "ops");
		expect(state.lensDataCache.has("ops")).toBe(false);
	});
});
