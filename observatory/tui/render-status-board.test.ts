// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { renderStatusBoard } from "./render-status-board.ts";
import { visibleWidth } from "./widgets/text.ts";

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
		expect(text).toContain("◐ scribe");
		expect(text).toContain("role: speaker");
	});

	test("truncates lines to width", () => {
		const wide = "x".repeat(80);
		const out = renderStatusBoard([{ name: wide, status: "running" }], 20);
		for (const line of out) {
			// visibleWidth (not .length) is the terminal-column constraint;
			// truncated text may carry ANSI reset codes around the ellipsis.
			expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		}
	});
});
