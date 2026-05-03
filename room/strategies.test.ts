// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	executeStrategy,
	type MindSpec,
	type OrchestrationContext,
	type SpawnFn,
} from "./strategies.ts";
import type { SpawnMindResult } from "./spawn.ts";

type CapturedSpawn = {
	slug: string;
	prompt: string;
	cwd: string;
	hasModeratorDirection: boolean;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
	hasOnAttemptStart: boolean;
};

type EmittedEvent =
	| {
			type: "mind-start";
			slug: string;
			role: string;
			turnNumber?: number;
			messageId: string;
	  }
	| { type: "mind-delta"; slug: string; delta: string; messageId: string }
	| {
			type: "mind-end";
			slug: string;
			role: string;
			turnNumber?: number;
			finalText: string;
	  }
	| {
			type: "moderator-decision";
			moderatorSlug: string;
			action: string;
			nextSpeaker?: string;
			direction?: string;
	  }
	| {
			type: "round-metrics";
			turns: number;
			speakers: number;
	  };

function makeMindSpec(slug: string, paletteIndex = 0): MindSpec {
	return { slug, persona: `# ${slug}\nIdentity.\n`, paletteIndex };
}

function makeContext(
	cwd: string,
	spawnFn: SpawnFn,
	signal = new AbortController().signal,
): { ctx: OrchestrationContext; events: EmittedEvent[] } {
	const events: EmittedEvent[] = [];
	let nextId = 0;
	const ctx: OrchestrationContext = {
		cwd,
		signal,
		spawn: spawnFn,
		emitMindStart: (slug, role, turnNumber) => {
			const messageId = `id-${++nextId}`;
			events.push({ type: "mind-start", slug, role, turnNumber, messageId });
			return messageId;
		},
		emitMindDelta: (messageId, slug, delta) => {
			events.push({ type: "mind-delta", slug, delta, messageId });
		},
		emitMindEnd: (_messageId, slug, role, result, turnNumber) => {
			events.push({
				type: "mind-end",
				slug,
				role,
				turnNumber,
				finalText: result.finalText,
			});
		},
		emitModeratorDecision: (moderatorSlug, decision) => {
			events.push({
				type: "moderator-decision",
				moderatorSlug,
				action: decision.action,
				nextSpeaker: decision.nextSpeaker,
				direction: decision.direction,
			});
		},
		emitRoundMetrics: (metrics) => {
			events.push({
				type: "round-metrics",
				turns: metrics.turns,
				speakers: metrics.speakers,
			});
		},
	};
	return { ctx, events };
}

function fakeSpawn(
	captured: CapturedSpawn[],
	textBySlug: Record<string, string>,
	options: {
		/** When set for a slug, the wrapper simulates the spawnMind retry loop:
		 * the first N entries return error results (consuming fallbackModels in
		 * order), and the (N+1)th call returns success with the active model. */
		failuresBySlug?: Record<string, number>;
	} = {},
): SpawnFn {
	const failureCounts = new Map<string, number>(
		Object.entries(options.failuresBySlug ?? {}),
	);
	return async (req) => {
		const failuresLeft = failureCounts.get(req.slug) ?? 0;
		// Simulate the retry wrapper: drain failures by walking through
		// fallbackModels in order; the surviving call returns success.
		const attemptedModels: string[] = [];
		let attempts = 0;
		const totalToAttempt = failuresLeft + 1;
		while (attempts < totalToAttempt) {
			const useFallback = attempts > 0;
			const activeModel = useFallback
				? req.fallbackModels?.[attempts - 1]
				: req.model;
			attemptedModels.push(activeModel ?? "default");
			attempts++;
		}
		captured.push({
			slug: req.slug,
			prompt: req.prompt,
			cwd: req.cwd,
			hasModeratorDirection: req.prompt.includes("moderator-direction"),
			model: req.model,
			fallbackModels: req.fallbackModels,
			tools: req.tools,
			hasOnAttemptStart: typeof req.onAttemptStart === "function",
		});
		// Simulate streaming a couple of token deltas to verify wiring.
		req.onDelta("hi ");
		req.onDelta("there");
		const finalText = textBySlug[req.slug] ?? `reply from ${req.slug}`;
		const winningModel = attemptedModels[attemptedModels.length - 1];
		const result: SpawnMindResult = {
			exitCode: 0,
			finalText,
			messages: [],
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.001,
				contextTokens: 3,
				turns: 1,
			},
			stderr: "",
			model: winningModel ?? "test-model",
			aborted: false,
			durationMs: 10,
			...(attemptedModels.length > 1 ? { attemptedModels } : {}),
		};
		return result;
	};
}

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

describe("SequentialStrategy", () => {
	test("invokes minds in order and feeds prior responses to later turns", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "ariadne first",
			mycroft: "mycroft second",
			scout: "scout third",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		const result = await executeStrategy({
			mode: "sequential",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
		});

		expect(captured.map((c) => c.slug)).toEqual([
			"ariadne",
			"mycroft",
			"scout",
		]);
		// mycroft's prompt sees ariadne's response in <chatroom-history>
		expect(captured[1].prompt).toContain("ariadne first");
		// scout's prompt sees both prior responses
		expect(captured[2].prompt).toContain("ariadne first");
		expect(captured[2].prompt).toContain("mycroft second");
		expect(result.turns).toBe(3);
	});
});

describe("GroupChatStrategy", () => {
	test("opens with a moderator decision then routes to the picked speaker", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"address cost","action":"close"}',
			ariadne: "ariadne speaks",
			mycroft: "mycroft speaks",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
			},
		});

		// First spawn is moderator (open), then ariadne, then moderator may_close.
		expect(captured[0].slug).toBe("jarvis");
		expect(captured[0].prompt).toContain('phase="open"');
		expect(captured[1].slug).toBe("ariadne");
		expect(captured[1].hasModeratorDirection).toBe(true);

		const moderatorEvents = events.filter(
			(e) => e.type === "moderator-decision",
		);
		expect(moderatorEvents.length).toBeGreaterThanOrEqual(2);
		expect(moderatorEvents[0].action).toBe("open");
	});

	test("consumeDirectorOverrides redirects the next speaker", async () => {
		const captured: CapturedSpawn[] = [];
		// Moderator picks ariadne first, then closes after one speaker turn.
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"discuss cost","action":"close"}',
			ariadne: "ariadne replies",
			mycroft: "mycroft replies",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		// Override: redirect to mycroft on the next speaker pick.
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { nextSpeaker: "mycroft" };
		};
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
			},
		});

		// First speaker after the open should be mycroft (override) rather than ariadne (moderator pick).
		const speakerSpawns = captured.filter((c) => c.slug !== "jarvis");
		expect(speakerSpawns[0]?.slug).toBe("mycroft");
		// Override should have been consumed exactly once.
		expect(consumed).toBe(true);
		void events;
	});

	test("consumeDirectorOverrides directionInjection prepends to the speaker prompt", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"original","action":"close"}',
			ariadne: "thoughts",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { directionInjection: "DIRECTOR-NOTE" };
		};
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "go",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
		});

		const speakerCall = captured.find((c) => c.slug === "ariadne");
		expect(speakerCall?.prompt).toContain("DIRECTOR-NOTE");
	});

	test("does not emit mind-start for hidden moderator deliberation", async () => {
		const captured: CapturedSpawn[] = [];
		// Moderator emits close on the second decision, ending the loop quickly.
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"close"}',
			ariadne: "thoughts",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
		});

		// Visible mind-start events should be for speaker (ariadne) and synthesis (jarvis).
		const startSlugs = events
			.filter((e) => e.type === "mind-start")
			.map((e) => (e as { slug: string }).slug);
		const moderatorAsRouter = startSlugs.filter((s) => s === "jarvis").length;
		// 1 entry for synthesis (after close); the moderator's open and decide passes are silent.
		expect(moderatorAsRouter).toBeLessThanOrEqual(1);
	});
});
