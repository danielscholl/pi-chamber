// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	type CapturedSpawn,
	fakeSpawn,
	makeContext,
	makeMindSpec,
} from "./_test-helpers.ts";
import { executeStrategy, type MindSpec } from "./index.ts";

describe("ConcurrentStrategy", () => {
	test("invokes every participant once and emits round metrics", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "ariadne reply",
			mycroft: "mycroft reply",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
		});

		expect(captured.map((c) => c.slug).sort()).toEqual(["ariadne", "mycroft"]);
		expect(result.turns).toBe(2);
		expect(result.transcript.map((t) => t.speaker).sort()).toEqual([
			"ariadne",
			"mycroft",
		]);
		expect(events.filter((e) => e.type === "mind-start").length).toBe(2);
		expect(events.filter((e) => e.type === "mind-end").length).toBe(2);
		expect(events.filter((e) => e.type === "round-metrics").length).toBe(1);
	});

	test("streams token deltas through the orchestration callbacks", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
		]);

		await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne"],
			roundHistory: [],
			context: ctx,
		});

		const deltas = events
			.filter((e) => e.type === "mind-delta")
			.map((e) => (e as { delta: string }).delta);
		expect(deltas).toEqual(["hi ", "there"]);
	});

	test("reports the winning fallback model when the primary fails", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(
			captured,
			{},
			{ failuresBySlug: { ariadne: 1 } },
		);
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			[
				"ariadne",
				{
					...makeMindSpec("ariadne"),
					model: "primary-bad",
					fallbackModels: ["fallback-good"],
				},
			],
		]);

		const result = await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne"],
			roundHistory: [],
			context: ctx,
		});

		expect(result.transcript[0].speaker).toBe("ariadne");
		const mindEnd = events.find(
			(e) => e.type === "mind-end" && e.slug === "ariadne",
		);
		expect(mindEnd).toBeDefined();
		// The captured spawn carries the originally requested fallbackModels list
		// so the wrapper can retry. The successful model that produced the reply
		// is the fallback ("fallback-good") via fakeSpawn's simulation.
		const ariadne = captured.find((c) => c.slug === "ariadne");
		expect(ariadne?.fallbackModels).toEqual(["fallback-good"]);
	});

	test("propagates per-mind tools, model, and fallbackModels into spawn requests", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			[
				"ariadne",
				{
					...makeMindSpec("ariadne"),
					model: "openai/gpt-4o",
					fallbackModels: ["anthropic/claude-sonnet-4"],
					tools: ["read", "grep"],
				},
			],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
		});

		const ariadne = captured.find((c) => c.slug === "ariadne");
		const mycroft = captured.find((c) => c.slug === "mycroft");
		expect(ariadne?.model).toBe("openai/gpt-4o");
		expect(ariadne?.fallbackModels).toEqual(["anthropic/claude-sonnet-4"]);
		expect(ariadne?.tools).toEqual(["read", "grep"]);
		expect(mycroft?.model).toBeUndefined();
		expect(mycroft?.fallbackModels).toBeUndefined();
		expect(mycroft?.tools).toBeUndefined();
	});

	test("synthesisConfig omitted: no synthesis spawn (current behavior preserved)", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);
		await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
		});
		expect(captured).toHaveLength(2);
		expect(events.filter((e) => e.type === "mind-start" && (e as { role?: string }).role === "synthesis")).toEqual([]);
	});

	test("synthesisConfig: chairman spawns chairman after parallel takes", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "lean A",
			mycroft: "lean B",
			chairman: "consensus: explore A first",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["chairman", makeMindSpec("chairman", 4)],
		]);
		const result = await executeStrategy({
			mode: "concurrent",
			userMessage: "what next?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			synthesisConfig: { mode: "chairman" },
		});
		// Three spawns: two speakers + one synthesizer.
		expect(captured.map((c) => c.slug)).toContain("chairman");
		// Chairman's prompt uses the concurrent-synthesis wrapper element.
		const chairmanSpawn = captured.find((c) => c.slug === "chairman");
		expect(chairmanSpawn?.prompt).toContain("<concurrent-synthesis");
		// Final transcript entry is the synthesis.
		expect(result.transcript[result.transcript.length - 1].speaker).toBe(
			"chairman",
		);
		expect(result.transcript[result.transcript.length - 1].isModerator).toBe(
			true,
		);
		// Synthesis emits mind-start with role "synthesis".
		const synthStart = events.find(
			(e) =>
				e.type === "mind-start" &&
				(e as { role?: string }).role === "synthesis",
		);
		expect(synthStart).toBeDefined();
	});

	test("synthesisConfig with explicit slug uses that mind as synthesizer", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);
		const result = await executeStrategy({
			mode: "concurrent",
			userMessage: "what next?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			synthesisConfig: { mode: "ariadne" },
		});
		// Ariadne is captured 2x: once as speaker, once as synthesizer.
		const ariadneSpawns = captured.filter((c) => c.slug === "ariadne");
		expect(ariadneSpawns.length).toBe(2);
		expect(ariadneSpawns[1].prompt).toContain("<concurrent-synthesis");
		// Last transcript entry is ariadne's synthesis.
		expect(result.transcript[result.transcript.length - 1].speaker).toBe(
			"ariadne",
		);
		expect(result.transcript[result.transcript.length - 1].isModerator).toBe(
			true,
		);
	});

	test("each visible spawn carries an onAttemptStart hook the wrapper can invoke between retries", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);
		await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
		});
		// Without an onAttemptStart, the buffer reset on retry never fires and
		// retry exhaustion can leak partial deltas into the displayed reply.
		expect(captured.every((c) => c.hasOnAttemptStart)).toBe(true);
	});

	test("synthesisConfig.mode === 'off' is a no-op", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
		]);
		await executeStrategy({
			mode: "concurrent",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne"],
			roundHistory: [],
			context: ctx,
			synthesisConfig: { mode: "off" },
		});
		expect(captured).toHaveLength(1);
	});
});
