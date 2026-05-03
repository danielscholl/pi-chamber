// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { priorityCard } from "../priority-card.ts";
import { visibleWidth } from "../text.ts";

describe("priorityCard", () => {
	test("title and body appear in the rendered output", () => {
		const out = priorityCard({
			title: "Top Priority",
			body: "Ship the dashboard controls.",
			width: 50,
		});
		const joined = out.join("\n");
		expect(joined).toContain("Top Priority");
		expect(joined).toContain("Ship the dashboard controls.");
	});

	test("emits a 4-line minimum: top, title, one body line, bottom", () => {
		const out = priorityCard({
			title: "T",
			body: "short",
			width: 30,
		});
		expect(out.length).toBeGreaterThanOrEqual(4);
	});

	test("body wraps at narrow width and is never truncated", () => {
		const longBody =
			"Ship the observatory dashboard controls before expanding the lens catalog and adding more authoring helpers.";
		const out = priorityCard({
			title: "T",
			body: longBody,
			width: 32,
		});
		const joined = out.join("\n");
		// Body words appear; they may be wrapped onto separate lines.
		expect(joined).toContain("authoring");
		expect(joined).toContain("helpers");
		expect(out.length).toBeGreaterThan(4);
	});

	test("each line is padded to exact width", () => {
		const out = priorityCard({
			title: "Top Priority",
			body: "Ship the dashboard controls before expanding the catalog.",
			width: 40,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	test("default severity invokes colorize('borderAccent')", () => {
		const calls: string[] = [];
		priorityCard({
			title: "x",
			body: "y",
			width: 24,
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("borderAccent");
		expect(calls).toContain("accent");
	});

	test("severity warn maps border to 'warn'", () => {
		const calls: string[] = [];
		priorityCard({
			title: "x",
			body: "y",
			width: 24,
			severity: "warn",
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("warn");
		expect(calls).not.toContain("borderAccent");
	});

	test("severity err maps border to 'error'", () => {
		const calls: string[] = [];
		priorityCard({
			title: "x",
			body: "y",
			width: 24,
			severity: "err",
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("error");
	});

	test("severity ok maps border to 'success'", () => {
		const calls: string[] = [];
		priorityCard({
			title: "x",
			body: "y",
			width: 24,
			severity: "ok",
			colorize: (key, text) => {
				calls.push(key);
				return text;
			},
		});
		expect(calls).toContain("success");
	});

	test("emits no ANSI when no colorize is provided", () => {
		const out = priorityCard({
			title: "x",
			body: "y",
			width: 24,
		});
		expect(out.some((l) => l.includes("\x1b["))).toBe(false);
	});
});
