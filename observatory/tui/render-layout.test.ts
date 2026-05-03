// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	computeColumnLayout,
	renderObservatoryFrame,
} from "./render-layout.ts";
import { visibleWidth } from "./widgets/text.ts";

describe("computeColumnLayout", () => {
	test("clamps to a minimum sidebar width", () => {
		const layout = computeColumnLayout(40, 10);
		expect(layout.sidebarWidth).toBeGreaterThanOrEqual(18);
		expect(layout.sidebarWidth + layout.bodyWidth + 3).toBe(layout.width);
	});

	test("caps the sidebar width on wide terminals", () => {
		const layout = computeColumnLayout(200, 30);
		expect(layout.sidebarWidth).toBeLessThanOrEqual(30);
	});

	test("body height accounts for title, divider, and footer rows", () => {
		const layout = computeColumnLayout(60, 20);
		expect(layout.bodyHeight).toBe(17);
	});
});

describe("renderObservatoryFrame", () => {
	test("emits title, separator, body rows, and footer", () => {
		const out = renderObservatoryFrame({
			title: "Observatory",
			subtitle: "Dashboard",
			sidebar: ["▶ Dashboard", "  ✓ ops"],
			body: ["── Lenses", "✓ 1 ok"],
			footer: "j/k navigate · q quit",
			width: 60,
			height: 10,
		});
		expect(out[0]).toContain("Observatory");
		expect(out[0]).toContain("Dashboard");
		expect(out[1]).toMatch(/^─+$/);
		expect(out.some((line) => line.includes("Dashboard") && line.includes("Lenses"))).toBe(
			true,
		);
		expect(out[out.length - 1]).toContain("q quit");
	});

	test("renders notification line above the footer when present", () => {
		const out = renderObservatoryFrame({
			title: "Observatory",
			sidebar: [],
			body: [],
			footer: "footer",
			notification: { message: "Refreshed", type: "info" },
			width: 60,
			height: 6,
		});
		const footerLine = out[out.length - 1];
		const notifLine = out[out.length - 2];
		expect(footerLine).toContain("footer");
		expect(notifLine).toContain("Refreshed");
	});

	test("each emitted line stays within the width budget", () => {
		const out = renderObservatoryFrame({
			title: "Observatory",
			sidebar: ["a".repeat(80)],
			body: ["b".repeat(120)],
			footer: "c".repeat(120),
			width: 50,
			height: 8,
		});
		for (const line of out) {
			// visibleWidth is the terminal-column constraint; truncation may add ANSI.
			expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		}
	});
});
