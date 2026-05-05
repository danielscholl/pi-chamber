// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import {
	clearNotification,
	createObservatoryViewState,
	currentDrill,
	invalidateLensData,
	notificationIsExpired,
	popDrill,
	pushDrill,
	selectionForIndex,
	setBodyNav,
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
		// Dashboard is at index 1 (after the LENSES group header).
		expect(state.selectedSidebarIndex).toBe(1);
		expect(state.mode).toBe("list");
		expect(state.entries).toEqual([]);
		expect(state.notification).toBeNull();
		expect(state.pendingG).toBe(false);
		expect(state.lensDataCache.size).toBe(0);
	});

	test("counts items including group headers, separator, and room-status row", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		// group LENSES + dashboard + 2 lenses + separator + group ROOM + room-status = 7
		expect(sidebarItemCount(state)).toBe(7);
	});
});

describe("setSelectedIndex", () => {
	test("clamps and finds dashboard when index is below zero", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, -5);
		// items[0] = group (not selectable); walk +1 → dashboard at index 1.
		expect(state.selectedSidebarIndex).toBe(1);
		expect(state.selection).toEqual({ kind: "dashboard" });
	});

	test("clamps to the last selectable lens when index overshoots", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		setSelectedIndex(state, 99);
		// items: group(0), dash(1), ops(2), room(3), sep(4), group(5), rs(6).
		// 99 → clamped to 6 (room-status, not selectable); walk back to 3 (room).
		expect(state.selectedSidebarIndex).toBe(3);
		expect(state.selection).toEqual({ kind: "lens", lensId: "room" });
	});

	test("resets body scroll when selection changes", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		state.bodyScrollOffset = 12;
		// items[2] = ops (lens-ok)
		setSelectedIndex(state, 2);
		expect(state.bodyScrollOffset).toBe(0);
		expect(state.selection).toEqual({ kind: "lens", lensId: "ops" });
	});

	test("skips past group headers when navigating past them", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		// Currently selected: dashboard at index 1.
		// Pressing down via setSelectedIndex(state, 2) — items[2]=ops, selectable.
		setSelectedIndex(state, 2);
		expect(state.selectedSidebarIndex).toBe(2);
		// Now down again into separator (3) → walks to next selectable: nothing
		// past it, so falls back to nearest (still ops at 2).
		setSelectedIndex(state, 3);
		expect(state.selectedSidebarIndex).toBe(2);
	});
});

describe("setEntries", () => {
	test("preserves a still-existing lens selection by id, not by index", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		// items: group(0), dash(1), ops(2), room(3), ...
		setSelectedIndex(state, 3); // room
		setEntries(state, [manifestEntry("room"), manifestEntry("ops")]);
		// New items: group(0), dash(1), room(2), ops(3), ...
		expect(state.selection).toEqual({ kind: "lens", lensId: "room" });
		expect(state.selectedSidebarIndex).toBe(2);
	});

	test("falls back to the dashboard when the selected lens is gone", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2); // ops
		setEntries(state, []);
		// New items: group(0), dash(1), sep(2), group(3), rs(4)
		expect(state.selection).toEqual({ kind: "dashboard" });
		expect(state.selectedSidebarIndex).toBe(1);
	});

	test("clamps a stale dashboard index when entries shrink", () => {
		const state = createObservatoryViewState([
			manifestEntry("a"),
			manifestEntry("b"),
		]);
		state.selectedSidebarIndex = 6; // simulate stale (was at room-status)
		setEntries(state, [manifestEntry("a")]);
		// New items: group(0), dash(1), a(2), sep(3), group(4), rs(5).
		// Selection re-resolves by id; preferred id is "__dashboard__"
		// (state.selection wasn't changed), so lands on dashboard at index 1.
		expect(state.selectedSidebarIndex).toBeLessThanOrEqual(2);
	});
});

describe("selectionForIndex", () => {
	test("returns dashboard for the LENSES group header (non-selectable)", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		// items[0] = group (non-selectable); falls back to dashboard.
		expect(selectionForIndex(state, 0)).toEqual({ kind: "dashboard" });
	});

	test("returns dashboard for the dashboard item index", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		expect(selectionForIndex(state, 1)).toEqual({ kind: "dashboard" });
	});

	test("returns lens selection for a selectable lens index", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		expect(selectionForIndex(state, 2)).toEqual({
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

describe("body drill stack", () => {
	test("starts empty with no body nav", () => {
		const state = createObservatoryViewState();
		expect(state.drillStack).toEqual([]);
		expect(state.bodyNav).toEqual({ kind: "none" });
		expect(state.bodySelectedIndex).toBe(0);
		expect(currentDrill(state)).toBeNull();
	});

	test("pushDrill / popDrill mutate the stack and clear per-page selection", () => {
		const state = createObservatoryViewState();
		state.bodySelectedIndex = 5;
		state.bodyScrollOffset = 12;
		pushDrill(state, { kind: "run", id: "run-1" });
		expect(state.drillStack).toEqual([{ kind: "run", id: "run-1" }]);
		expect(state.bodySelectedIndex).toBe(0);
		expect(state.bodyScrollOffset).toBe(0);
		expect(currentDrill(state)).toEqual({ kind: "run", id: "run-1" });

		pushDrill(state, { kind: "node", id: "summarize" });
		expect(state.drillStack.length).toBe(2);
		expect(currentDrill(state)).toEqual({ kind: "node", id: "summarize" });

		expect(popDrill(state)).toBe(true);
		expect(state.drillStack.length).toBe(1);
		expect(popDrill(state)).toBe(true);
		expect(state.drillStack.length).toBe(0);
		expect(popDrill(state)).toBe(false); // empty pop reports false
	});

	test("setSelectedIndex resets the drill stack when changing lens", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		// items[2] = ops (lens-ok)
		setSelectedIndex(state, 2);
		pushDrill(state, { kind: "run", id: "run-1" });
		expect(state.drillStack.length).toBe(1);
		// Switch back to dashboard.
		setSelectedIndex(state, 1);
		expect(state.drillStack).toEqual([]);
		expect(state.bodyNav).toEqual({ kind: "none" });
	});

	test("setBodyNav clamps bodySelectedIndex to the new list size", () => {
		const state = createObservatoryViewState();
		state.bodySelectedIndex = 9;
		setBodyNav(state, { kind: "list", ids: ["a", "b"], pushKind: "run" });
		expect(state.bodySelectedIndex).toBe(1);

		setBodyNav(state, { kind: "list", ids: [], pushKind: "run" });
		expect(state.bodySelectedIndex).toBe(0);

		setBodyNav(state, { kind: "none" });
		expect(state.bodyNav).toEqual({ kind: "none" });
	});
});
