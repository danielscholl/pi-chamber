// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import {
	buildSidebarItems,
	clampSidebarScroll,
	findSelectableIndex,
	isSelectableItem,
	renderSidebar,
} from "./render-sidebar.ts";
import { visibleWidth } from "./widgets/text.ts";

function ok(
	id: string,
	kind: "briefing" | "status-board" = "briefing",
): DiscoveryEntry {
	return {
		id,
		status: "ok",
		manifest: { id, name: id, kind, source: "data.json" },
	};
}

describe("buildSidebarItems", () => {
	test("LENSES group is the first item, dashboard follows immediately", () => {
		const items = buildSidebarItems([]);
		expect(items[0].kind).toBe("group");
		expect(items[0].kind === "group" && items[0].label).toBe("Lenses");
		expect(items[1].kind).toBe("dashboard");
		expect(items[1].kind === "dashboard" && items[1].label).toBe("Dashboard");
	});

	test("ok entries use the manifest name; invalid use the id", () => {
		const items = buildSidebarItems([
			ok("ops"),
			{ id: "broken", status: "invalid", reason: "bad json" },
		]);
		// group(0), dashboard(1), ops(2), broken(3), separator(4), group ROOM(5), room-status(6)
		expect(items[2].kind).toBe("lens-ok");
		if (items[2].kind === "lens-ok") expect(items[2].label).toBe("ops");
		expect(items[3].kind).toBe("lens-invalid");
		if (items[3].kind === "lens-invalid") {
			expect(items[3].label).toBe("broken");
			expect(items[3].reason).toBe("bad json");
		}
	});

	test("includes ROOM group with inactive room-status when no room entries", () => {
		const items = buildSidebarItems([]);
		const roomGroupIdx = items.findIndex(
			(i) => i.kind === "group" && i.label === "Room",
		);
		expect(roomGroupIdx).toBeGreaterThan(0);
		const roomStatus = items[roomGroupIdx + 1];
		expect(roomStatus.kind).toBe("room-status");
	});

	test("includes MINDS group only when minds are provided", () => {
		const without = buildSidebarItems([]);
		expect(
			without.some((i) => i.kind === "group" && i.label === "Minds"),
		).toBe(false);
		const withMinds = buildSidebarItems([], ["jarvis", "moneypenny"]);
		expect(
			withMinds.some((i) => i.kind === "group" && i.label === "Minds"),
		).toBe(true);
		const minds = withMinds.filter((i) => i.kind === "mind-status");
		expect(minds.length).toBe(2);
	});
});

describe("isSelectableItem", () => {
	test("dashboard, lens-ok, lens-invalid are selectable", () => {
		expect(
			isSelectableItem({
				kind: "dashboard",
				id: "__dashboard__",
				label: "x",
				suffix: "y",
			}),
		).toBe(true);
		expect(
			isSelectableItem({
				kind: "lens-ok",
				id: "x",
				label: "x",
				suffix: "y",
			}),
		).toBe(true);
		expect(
			isSelectableItem({
				kind: "lens-invalid",
				id: "x",
				label: "x",
				suffix: "y",
			}),
		).toBe(true);
	});

	test("group, separator, mind-status, room-status are not selectable", () => {
		expect(isSelectableItem({ kind: "group", label: "x" })).toBe(false);
		expect(isSelectableItem({ kind: "separator" })).toBe(false);
		expect(
			isSelectableItem({ kind: "mind-status", label: "j", status: "ready" }),
		).toBe(false);
		expect(
			isSelectableItem({
				kind: "room-status",
				label: "i",
				status: "",
				tier: "idle",
			}),
		).toBe(false);
	});
});

describe("findSelectableIndex", () => {
	test("returns the start index when it is already selectable", () => {
		const items = buildSidebarItems([ok("ops")]);
		// items[1] = dashboard
		expect(findSelectableIndex(items, 1)).toBe(1);
	});

	test("walks past a group header to the first selectable", () => {
		const items = buildSidebarItems([ok("ops")]);
		// items[0] = group, walks +1 to dashboard
		expect(findSelectableIndex(items, 0, 1)).toBe(1);
	});

	test("walks back when forward direction has nothing", () => {
		const items = buildSidebarItems([ok("ops")]);
		// items: group(0), dash(1), ops(2), sep(3), group(4), rs(5)
		// findSelectableIndex(items, 5, +1) — start at room-status, walk +1: nothing.
		// Walk -1: group(4)→sep(3)→ops(2). Returns 2.
		expect(findSelectableIndex(items, 5, 1)).toBe(2);
	});

	test("returns -1 for empty items", () => {
		expect(findSelectableIndex([], 0)).toBe(-1);
	});
});

describe("renderSidebar", () => {
	test("highlights the selected dashboard row", () => {
		const items = buildSidebarItems([ok("ops")]);
		// dashboard is at index 1
		const lines = renderSidebar(items, 1, 24, 5, 0);
		// items[0]=group LENSES, items[1]=dashboard. Line 0 is group label (no cursor).
		expect(lines[0].includes("▶")).toBe(false);
		expect(lines[1].includes("▶")).toBe(true);
	});

	test("highlights the selected lens row", () => {
		const items = buildSidebarItems([ok("ops"), ok("room")]);
		// items: group(0), dash(1), ops(2), room(3)
		const lines = renderSidebar(items, 3, 24, 7, 0);
		expect(lines[3].includes("▶")).toBe(true);
		expect(lines[3]).toContain("room");
	});

	test("group label rows have no cursor and are uppercase", () => {
		const items = buildSidebarItems([ok("ops")]);
		const lines = renderSidebar(items, 1, 24, 7, 0);
		expect(lines[0]).toContain("LENSES");
		expect(lines[0].includes("▶")).toBe(false);
	});

	test("each visible row is bounded by width", () => {
		const items = buildSidebarItems([ok("ops")]);
		const lines = renderSidebar(items, 1, 12, 3, 0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		}
	});
});

describe("clampSidebarScroll", () => {
	test("returns 0 when items fit", () => {
		expect(clampSidebarScroll(2, 5, 3, 0)).toBe(0);
	});

	test("scrolls down when the selection passes the visible bottom", () => {
		expect(clampSidebarScroll(5, 3, 10, 0)).toBe(3);
	});

	test("scrolls up when the selection rises above current scroll", () => {
		expect(clampSidebarScroll(1, 3, 10, 5)).toBe(1);
	});

	test("clamps to 0 and to maximum bound", () => {
		expect(clampSidebarScroll(0, 3, 10, 7)).toBe(0);
		expect(clampSidebarScroll(9, 3, 10, 0)).toBe(7);
	});
});
