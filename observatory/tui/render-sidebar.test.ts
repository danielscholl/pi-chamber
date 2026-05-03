// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import {
	buildSidebarItems,
	clampSidebarScroll,
	renderSidebar,
} from "./render-sidebar.ts";

function ok(id: string, kind: "briefing" | "status-board" = "briefing"): DiscoveryEntry {
	return { id, status: "ok", manifest: { id, name: id, kind, source: "data.json" } };
}

describe("buildSidebarItems", () => {
	test("dashboard is always first", () => {
		const items = buildSidebarItems([]);
		expect(items[0].kind).toBe("dashboard");
		expect(items[0].label).toBe("Dashboard");
	});

	test("ok entries use the manifest name; invalid use the id", () => {
		const items = buildSidebarItems([
			ok("ops"),
			{ id: "broken", status: "invalid", reason: "bad json" },
		]);
		expect(items[1].kind).toBe("lens-ok");
		expect(items[1].label).toBe("ops");
		expect(items[2].kind).toBe("lens-invalid");
		expect(items[2].label).toBe("broken");
		expect(items[2].reason).toBe("bad json");
	});
});

describe("renderSidebar", () => {
	test("highlights the selected dashboard row", () => {
		const lines = renderSidebar([ok("ops")], { kind: "dashboard" }, 24, 5, 0);
		expect(lines[0].startsWith("▶")).toBe(true);
		expect(lines[1].startsWith("▶")).toBe(false);
	});

	test("highlights the selected lens row", () => {
		const lines = renderSidebar(
			[ok("ops"), ok("room")],
			{ kind: "lens", lensId: "room" },
			24,
			5,
			0,
		);
		expect(lines[2].startsWith("▶")).toBe(true);
		expect(lines[2]).toContain("room");
	});

	test("each visible row is bounded by width", () => {
		const lines = renderSidebar([ok("ops")], { kind: "dashboard" }, 12, 3, 0);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(12);
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
