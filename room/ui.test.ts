// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	ansiBold,
	ansiDim,
	ansiFg,
	colorForMind,
	djb2,
	formatDurationMs,
	formatTokens,
	mindSpeechRenderer,
	MIND_PALETTE,
	moderatorDecisionRenderer,
	paletteIndexForSlug,
	renderParticipantBarLines,
	roundMetricsRenderer,
	userRoomMessageRenderer,
} from "./ui.ts";

const fakeTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	bg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

describe("djb2 + paletteIndexForSlug", () => {
	test("produces stable output for the same slug", () => {
		expect(djb2("ariadne")).toBe(djb2("ariadne"));
		expect(paletteIndexForSlug("ariadne")).toBe(paletteIndexForSlug("ariadne"));
	});

	test("different slugs typically map to different palette indexes", () => {
		const seen = new Set<number>();
		for (const slug of [
			"ariadne",
			"mycroft",
			"jarvis",
			"scout",
			"oracle",
			"reviewer",
		]) {
			seen.add(paletteIndexForSlug(slug));
		}
		// We expect spread across at least a couple of palette slots.
		expect(seen.size).toBeGreaterThan(1);
	});

	test("indexes stay within the palette range", () => {
		for (const slug of ["a", "b", "c", "very-long-slug-name", "x"]) {
			const idx = paletteIndexForSlug(slug);
			expect(idx).toBeGreaterThanOrEqual(0);
			expect(idx).toBeLessThan(MIND_PALETTE.length);
		}
	});
});

describe("ansi helpers", () => {
	test("ansiFg wraps text in true-color escapes", () => {
		const out = ansiFg([10, 20, 30], "x");
		expect(out).toContain("\x1b[38;2;10;20;30m");
		expect(out).toContain("\x1b[39m");
		expect(out).toContain("x");
	});

	test("ansiBold and ansiDim use SGR codes", () => {
		expect(ansiBold("x")).toContain("\x1b[1m");
		expect(ansiBold("x")).toContain("\x1b[22m");
		expect(ansiDim("x")).toContain("\x1b[2m");
	});

	test("colorForMind returns a stable palette entry", () => {
		const a = colorForMind("ariadne");
		const b = colorForMind("ariadne");
		expect(a).toEqual(b);
		expect(a.rgb.length).toBe(3);
	});
});

describe("formatDurationMs and formatTokens", () => {
	test("formatDurationMs formats minutes:seconds", () => {
		expect(formatDurationMs(0)).toBe("0:00");
		expect(formatDurationMs(8000)).toBe("0:08");
		expect(formatDurationMs(70_000)).toBe("1:10");
		expect(formatDurationMs(605_000)).toBe("10:05");
	});

	test("formatTokens uses k and M suffixes", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(2500)).toBe("2.5k");
		expect(formatTokens(15_000)).toBe("15k");
		expect(formatTokens(1_500_000)).toBe("1.5M");
	});
});

describe("renderParticipantBarLines", () => {
	test("returns no lines when room is inactive", () => {
		expect(
			renderParticipantBarLines({
				active: false,
				mode: "concurrent",
				participants: [],
			}),
		).toEqual([]);
	});

	test("returns a single labelled line with all participants", () => {
		const lines = renderParticipantBarLines({
			active: true,
			mode: "concurrent",
			participants: [
				{
					slug: "ariadne",
					role: "speaker",
					status: "ready",
					paletteIndex: 0,
				},
				{
					slug: "mycroft",
					role: "speaker",
					status: "speaking",
					paletteIndex: 1,
				},
			],
		});
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("ariadne");
		expect(lines[0]).toContain("mycroft");
		expect(lines[0]).toContain("room");
		expect(lines[0]).toContain("concurrent");
	});

	test("annotates the moderator slot", () => {
		const lines = renderParticipantBarLines({
			active: true,
			mode: "group-chat",
			participants: [
				{
					slug: "jarvis",
					role: "moderator",
					status: "thinking",
					paletteIndex: 2,
				},
				{
					slug: "ariadne",
					role: "speaker",
					status: "ready",
					paletteIndex: 0,
				},
			],
		});
		expect(lines[0]).toContain("(mod)");
	});

	test("renders an animated spinner glyph for active participants", () => {
		const frameZero = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{
					slug: "ariadne",
					role: "speaker",
					status: "speaking",
					paletteIndex: 0,
				},
			],
			spinnerFrame: 0,
		});
		const frameOne = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{
					slug: "ariadne",
					role: "speaker",
					status: "speaking",
					paletteIndex: 0,
				},
			],
			spinnerFrame: 1,
		});
		// Different frame indices must produce different rendered glyphs so
		// the bar visibly animates while a mind is working.
		expect(frameZero[0]).not.toBe(frameOne[0]);
		// Both contain the slug, identifying which mind is working.
		expect(frameZero[0]).toContain("ariadne");
		expect(frameOne[0]).toContain("ariadne");
	});

	test("appends current tool name only while a participant is active", () => {
		const active = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{
					slug: "jarvis",
					role: "speaker",
					status: "speaking",
					paletteIndex: 0,
					elapsedMs: 23_000,
					currentTool: "bash",
				},
			],
			spinnerFrame: 5,
		});
		expect(active[0]).toContain("0:23");
		expect(active[0]).toContain("bash");

		// A done participant must not show currentTool even if leaked in the
		// view — defensive against stale state.
		const done = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{
					slug: "jarvis",
					role: "speaker",
					status: "done",
					paletteIndex: 0,
					currentTool: "bash",
				},
			],
		});
		expect(done[0]).not.toContain("bash");
	});

	test("appends elapsed time only for active participants", () => {
		const lines = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{
					slug: "ariadne",
					role: "speaker",
					status: "speaking",
					paletteIndex: 0,
					elapsedMs: 8_000,
				},
				{
					slug: "mycroft",
					role: "speaker",
					status: "done",
					paletteIndex: 1,
					elapsedMs: 12_000, // ignored for done
				},
			],
			spinnerFrame: 3,
		});
		// Active speaker shows mm:ss elapsed
		expect(lines[0]).toContain("0:08");
		// Done speaker does NOT include elapsed (would be 0:12 if leaked)
		expect(lines[0]).not.toContain("0:12");
	});

	test("uses distinct glyphs for done vs ready vs error states", () => {
		const done = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{ slug: "a", role: "speaker", status: "done", paletteIndex: 0 },
			],
		});
		const ready = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{ slug: "a", role: "speaker", status: "ready", paletteIndex: 0 },
			],
		});
		const errored = renderParticipantBarLines({
			active: true,
			mode: "open-floor",
			participants: [
				{ slug: "a", role: "speaker", status: "error", paletteIndex: 0 },
			],
		});
		// Each state uses a different glyph character so the eye reads state
		// without parsing color alone.
		expect(stripAnsi(done[0])).toContain("✓");
		expect(stripAnsi(ready[0])).toContain("◌");
		expect(stripAnsi(errored[0])).toContain("✕");
	});
});

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip helper.
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("message renderers", () => {
	test("userRoomMessageRenderer wraps content in a Box", () => {
		const component = userRoomMessageRenderer(
			{ content: "hello room" },
			{ expanded: false },
			fakeTheme as never,
		);
		expect(component).toBeDefined();
		expect((component as { children?: unknown[] }).children?.length ?? 0).toBeGreaterThan(0);
	});

	test("mindSpeechRenderer returns a Container with header + body", () => {
		const component = mindSpeechRenderer(
			{
				content: "hello there, this is a short reply.",
				details: {
					slug: "ariadne",
					mode: "concurrent",
					role: "speaker",
					paletteIndex: 0,
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		const children = (component as { children?: unknown[] }).children;
		expect(Array.isArray(children)).toBe(true);
		expect((children as unknown[]).length).toBeGreaterThanOrEqual(2);
	});

	test("mindSpeechRenderer collapses long unexpanded completed messages", () => {
		const longBody = "first sentence.\n" + "filler ".repeat(120);
		const component = mindSpeechRenderer(
			{
				content: longBody,
				details: {
					slug: "ariadne",
					mode: "concurrent",
					role: "speaker",
					paletteIndex: 0,
					// durationMs marks the turn as completed; in-flight turns
					// auto-expand so the operator can read the live stream.
					durationMs: 1234,
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		const children = (component as { children?: { children?: unknown[] }[] })
			.children;
		expect(children?.length).toBeGreaterThan(0);
		const rendered = JSON.stringify(children);
		expect(rendered).toContain("Ctrl+O to expand");
	});

	test("mindSpeechRenderer auto-expands in-flight (still streaming) messages", () => {
		const longBody = "first sentence.\n" + "filler ".repeat(120);
		const component = mindSpeechRenderer(
			{
				content: longBody,
				details: {
					slug: "ariadne",
					mode: "concurrent",
					role: "speaker",
					paletteIndex: 0,
					// no durationMs — turn is in-flight
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		const rendered = JSON.stringify(
			(component as { children?: unknown[] }).children,
		);
		expect(rendered).not.toContain("Ctrl+O to expand");
		expect(rendered).toContain("filler filler");
	});

	test("mindSpeechRenderer always renders synthesis turns fully (no collapse)", () => {
		const longBody =
			"### Synthesis — Jarvis\n\n" + "filler ".repeat(120);
		const component = mindSpeechRenderer(
			{
				content: longBody,
				details: {
					slug: "jarvis",
					mode: "group-chat",
					role: "synthesis",
					paletteIndex: 1,
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		const children = (component as { children?: unknown[] }).children;
		const rendered = JSON.stringify(children);
		expect(rendered).not.toContain("Ctrl+O to expand");
		expect(rendered).toContain("─");
	});

	test("moderatorDecisionRenderer returns a single-line Text component", () => {
		const component = moderatorDecisionRenderer(
			{
				content: "decision summary",
				details: {
					moderatorSlug: "jarvis",
					moderatorPaletteIndex: 1,
					action: "direct",
					nextSpeaker: "ariadne",
					direction: "address the cost angle",
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		expect(component).toBeDefined();
	});

	test("roundMetricsRenderer returns a Text component", () => {
		const component = roundMetricsRenderer(
			{
				details: {
					mode: "concurrent",
					turns: 2,
					speakers: 2,
					durationMs: 5000,
					usage: { input: 100, output: 200, cost: 0.01 },
				},
			},
			{ expanded: false },
			fakeTheme as never,
		);
		expect(component).toBeDefined();
	});
});
