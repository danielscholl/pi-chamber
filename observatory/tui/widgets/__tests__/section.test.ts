// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { sectionHeader } from "../section.ts";
import { visibleWidth } from "../text.ts";

describe("sectionHeader", () => {
	test("returns exactly 2 lines", () => {
		expect(sectionHeader({ label: "Metrics", width: 40 }).length).toBe(2);
	});

	test("uppercases the label", () => {
		const out = sectionHeader({ label: "recent changes", width: 40 });
		expect(out[0]).toContain("RECENT CHANGES");
	});

	test("divider matches the visible label width, not full width", () => {
		const out = sectionHeader({ label: "Metrics", width: 40 });
		expect(out[1].trimEnd()).toBe("─".repeat("METRICS".length));
	});

	test("each line is padded to exactly the requested width", () => {
		const out = sectionHeader({ label: "Metrics", width: 40 });
		for (const line of out) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	test("invokes colorize for accent and dim", () => {
		const calls: string[] = [];
		sectionHeader({
			label: "x",
			width: 16,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("accent");
		expect(calls).toContain("dim");
	});

	test("emits no ANSI when no colorize is provided", () => {
		const out = sectionHeader({ label: "x", width: 12 });
		expect(out.some((l) => l.includes("\x1b["))).toBe(false);
	});

	test("truncates an over-long label to fit width", () => {
		const out = sectionHeader({ label: "x".repeat(60), width: 16 });
		expect(visibleWidth(out[0])).toBe(16);
	});
});
