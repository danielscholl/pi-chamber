/**
 * room-strategies — orchestration strategies for chamber rooms.
 *
 * Each strategy receives an OrchestrationContext (host-supplied callbacks) and
 * the user's room message, and drives the per-mind spawn calls. Strategies are
 * pure orchestration: they do not touch Pi UI directly. The host extension
 * subscribes to the emitted events and turns them into TUI output.
 */

import {
	buildConcurrentSynthesisPrompt,
	buildModeratorPrompt,
	buildSpeakerPrompt,
	buildSynthesisPrompt,
	type ChamberHistoryTurn,
	CHAIRMAN_SLUG,
	type ModeratorDecision,
	type ModeratorPhase,
	parseModeratorDecision,
} from "./prompts.ts";
import {
	mapWithConcurrencyLimit,
	type SpawnMindResult,
} from "./spawn.ts";
import type { RoomMode } from "./core.ts";

export const MAX_CONCURRENT_SPAWNS = 4;
export const DEFAULT_MAX_TURNS = 4;
export const DEFAULT_MIN_ROUNDS = 1;
export const DEFAULT_REPEAT_CAP = 2;

export type MindSpec = {
	slug: string;
	persona: string;
	paletteIndex: number;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
};

export type SpeechRole = "speaker" | "moderator" | "synthesis";

export type SpawnRequest = {
	slug: string;
	persona: string;
	prompt: string;
	cwd: string;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
	signal: AbortSignal;
	onDelta: (delta: string) => void;
	/** Optional hook the wrapper calls before each spawn attempt (including
	 * the first). Used to reset streaming buffers so retry exhaustion never
	 * surfaces concatenated deltas from multiple attempts. */
	onAttemptStart?: (modelLabel: string) => void;
};

export type SpawnFn = (req: SpawnRequest) => Promise<SpawnMindResult>;

export type DirectorOverrides = {
	/** Overrides the moderator's next-speaker pick on the next iteration. */
	nextSpeaker?: string;
	/** Prepended to the moderator's direction for the next speaker turn. */
	directionInjection?: string;
};

export type OrchestrationContext = {
	cwd: string;
	signal: AbortSignal;
	spawn: SpawnFn;
	emitMindStart: (
		slug: string,
		role: SpeechRole,
		turnNumber?: number,
	) => string; // returns messageId
	emitMindDelta: (messageId: string, slug: string, delta: string) => void;
	/**
	 * Optional hook the strategy wires up so the host can reset its per-message
	 * streaming buffer when a fallback retry begins. Without this, retry
	 * exhaustion can surface concatenated deltas from multiple attempts as a
	 * single garbled reply.
	 */
	emitMindReset?: (messageId: string, slug: string) => void;
	emitMindEnd: (
		messageId: string,
		slug: string,
		role: SpeechRole,
		result: SpawnMindResult,
		turnNumber?: number,
	) => void;
	emitModeratorDecision: (
		moderatorSlug: string,
		decision: {
			action: "open" | "direct" | "close";
			phase?: ModeratorPhase;
			nextSpeaker?: string;
			direction?: string;
		},
	) => void;
	emitRoundMetrics: (metrics: {
		mode: string;
		turns: number;
		speakers: number;
		durationMs: number;
		usage?: {
			input?: number;
			output?: number;
			cost?: number;
		};
	}) => void;
	/**
	 * Optional callback that returns one-shot director overrides set by the
	 * host (`/next` / `/inject`). Each call returns the current overrides and
	 * the host should clear them so they apply to one turn only.
	 */
	consumeDirectorOverrides?: () => DirectorOverrides | undefined;
};

export type StrategyInput = {
	mode: RoomMode;
	userMessage: string;
	mindsBySlug: Map<string, MindSpec>;
	participantOrder: string[]; // slugs in display order
	moderatorSlug?: string;
	roundHistory: ChamberHistoryTurn[]; // prior rounds (capped externally)
	context: OrchestrationContext;
	groupChatConfig?: GroupChatConfig;
	/** When set and not "off", concurrent mode appends a synthesis turn from
	 * the named mind after the parallel speakers finish. The slug "chairman"
	 * uses the built-in synthetic moderator; any other slug must be present
	 * in `mindsBySlug`. */
	synthesisConfig?: { mode: "off" | "chairman" | string };
};

export type GroupChatConfig = {
	maxTurns: number;
	minRounds: number;
	maxSpeakerRepeats: number;
};

export type StrategyResult = {
	mode: string;
	turns: number;
	speakers: number;
	durationMs: number;
	transcript: ChamberHistoryTurn[];
	usage: {
		input: number;
		output: number;
		cost: number;
	};
};

/** Execute the given strategy name against the input. */
export async function executeStrategy(
	input: StrategyInput,
): Promise<StrategyResult> {
	switch (input.mode) {
		case "concurrent":
			return executeConcurrent(input);
		case "sequential":
			return executeSequential(input);
		case "group-chat":
			return executeGroupChat(input);
		default:
			throw new Error(`Unsupported room mode: ${input.mode}`);
	}
}

// ---------------------------------------------------------------------------
// Concurrent
// ---------------------------------------------------------------------------

async function executeConcurrent(
	input: StrategyInput,
): Promise<StrategyResult> {
	const start = Date.now();
	const speakers = input.participantOrder
		.map((slug) => input.mindsBySlug.get(slug))
		.filter((m): m is MindSpec => Boolean(m));
	if (speakers.length === 0) return emptyResult(input.mode, start);

	const usageTotal = { input: 0, output: 0, cost: 0 };
	const transcript: ChamberHistoryTurn[] = [];

	const results = await mapWithConcurrencyLimit(
		speakers,
		MAX_CONCURRENT_SPAWNS,
		async (mind, _index) => {
			const messageId = input.context.emitMindStart(mind.slug, "speaker");
			const prompt = buildSpeakerPrompt({
				mindSlug: mind.slug,
				mode: input.mode,
				participants: input.participantOrder,
				userMessage: input.userMessage,
				history: input.roundHistory,
			});
			const result = await input.context.spawn({
				slug: mind.slug,
				persona: mind.persona,
				prompt,
				cwd: input.context.cwd,
				model: mind.model,
				fallbackModels: mind.fallbackModels,
				tools: mind.tools,
				signal: input.context.signal,
				onDelta: (delta) =>
					input.context.emitMindDelta(messageId, mind.slug, delta),
				onAttemptStart: () =>
					input.context.emitMindReset?.(messageId, mind.slug),
			});
			input.context.emitMindEnd(messageId, mind.slug, "speaker", result);
			return { mind, result };
		},
	);

	for (const { mind, result } of results) {
		usageTotal.input += result.usage.input;
		usageTotal.output += result.usage.output;
		usageTotal.cost += result.usage.cost;
		transcript.push({
			speaker: mind.slug,
			content: result.finalText,
			turnNumber: 1,
		});
	}

	// Optional synthesis turn: a single named mind summarizes the parallel
	// takes. Default off for backward compatibility — set
	// `synthesisConfig.mode` to "chairman" or a participant slug to enable.
	const synthMode = input.synthesisConfig?.mode;
	if (
		synthMode &&
		synthMode !== "off" &&
		!input.context.signal.aborted &&
		transcript.length > 0
	) {
		const synthSlug = synthMode;
		const synthMind = input.mindsBySlug.get(synthSlug);
		if (synthMind) {
			const synthTurnNumber = speakers.length + 1;
			const messageId = input.context.emitMindStart(
				synthMind.slug,
				"synthesis",
				synthTurnNumber,
			);
			const synthPrompt = buildConcurrentSynthesisPrompt({
				moderatorSlug: synthMind.slug,
				participants: input.participantOrder,
				userMessage: input.userMessage,
				transcript,
			});
			const synthResult = await input.context.spawn({
				slug: synthMind.slug,
				persona: synthMind.persona,
				prompt: synthPrompt,
				cwd: input.context.cwd,
				model: synthMind.model,
				fallbackModels: synthMind.fallbackModels,
				tools: synthMind.tools,
				signal: input.context.signal,
				onDelta: (delta) =>
					input.context.emitMindDelta(messageId, synthMind.slug, delta),
				onAttemptStart: () =>
					input.context.emitMindReset?.(messageId, synthMind.slug),
			});
			input.context.emitMindEnd(
				messageId,
				synthMind.slug,
				"synthesis",
				synthResult,
				synthTurnNumber,
			);
			usageTotal.input += synthResult.usage.input;
			usageTotal.output += synthResult.usage.output;
			usageTotal.cost += synthResult.usage.cost;
			transcript.push({
				speaker: synthMind.slug,
				content: synthResult.finalText,
				turnNumber: synthTurnNumber,
				isModerator: true,
			});
		}
	}

	const durationMs = Date.now() - start;
	const metrics = {
		mode: input.mode,
		turns: transcript.length,
		speakers: speakers.length,
		durationMs,
		usage: usageTotal,
	};
	input.context.emitRoundMetrics(metrics);
	return {
		...metrics,
		transcript,
		usage: usageTotal,
	};
}

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

async function executeSequential(
	input: StrategyInput,
): Promise<StrategyResult> {
	const start = Date.now();
	const speakers = input.participantOrder
		.map((slug) => input.mindsBySlug.get(slug))
		.filter((m): m is MindSpec => Boolean(m));
	if (speakers.length === 0) return emptyResult(input.mode, start);

	const usageTotal = { input: 0, output: 0, cost: 0 };
	const roundTurns: ChamberHistoryTurn[] = [];

	for (let i = 0; i < speakers.length; i++) {
		if (input.context.signal.aborted) break;
		const mind = speakers[i];
		const messageId = input.context.emitMindStart(mind.slug, "speaker", i + 1);
		const history = [...input.roundHistory, ...roundTurns];
		const prompt = buildSpeakerPrompt({
			mindSlug: mind.slug,
			mode: input.mode,
			participants: input.participantOrder,
			userMessage: input.userMessage,
			history,
		});
		const result = await input.context.spawn({
			slug: mind.slug,
			persona: mind.persona,
			prompt,
			cwd: input.context.cwd,
			model: mind.model,
			fallbackModels: mind.fallbackModels,
			tools: mind.tools,
			signal: input.context.signal,
			onDelta: (delta) =>
				input.context.emitMindDelta(messageId, mind.slug, delta),
			onAttemptStart: () =>
				input.context.emitMindReset?.(messageId, mind.slug),
		});
		input.context.emitMindEnd(messageId, mind.slug, "speaker", result, i + 1);
		usageTotal.input += result.usage.input;
		usageTotal.output += result.usage.output;
		usageTotal.cost += result.usage.cost;
		roundTurns.push({
			speaker: mind.slug,
			content: result.finalText,
			turnNumber: i + 1,
		});
	}

	const durationMs = Date.now() - start;
	const metrics = {
		mode: input.mode,
		turns: roundTurns.length,
		speakers: speakers.length,
		durationMs,
		usage: usageTotal,
	};
	input.context.emitRoundMetrics(metrics);
	return {
		...metrics,
		transcript: roundTurns,
		usage: usageTotal,
	};
}

// ---------------------------------------------------------------------------
// Group-chat
// ---------------------------------------------------------------------------

async function executeGroupChat(
	input: StrategyInput,
): Promise<StrategyResult> {
	const start = Date.now();
	const config: GroupChatConfig = input.groupChatConfig ?? {
		maxTurns: DEFAULT_MAX_TURNS,
		minRounds: DEFAULT_MIN_ROUNDS,
		maxSpeakerRepeats: DEFAULT_REPEAT_CAP,
	};
	const moderatorSlug =
		input.moderatorSlug ?? input.participantOrder[0] ?? "";
	const moderator = input.mindsBySlug.get(moderatorSlug);
	if (!moderator) {
		throw new Error(
			`group-chat moderator "${moderatorSlug}" is not in mindsBySlug`,
		);
	}
	const speakers = input.participantOrder
		.filter((slug) => slug !== moderatorSlug)
		.map((slug) => input.mindsBySlug.get(slug))
		.filter((m): m is MindSpec => Boolean(m));
	if (speakers.length === 0) {
		return emptyResult(input.mode, start);
	}

	const usageTotal = { input: 0, output: 0, cost: 0 };
	const transcript: ChamberHistoryTurn[] = [];
	const speakerCounts = new Map<string, number>();
	const spokenSlugs = new Set<string>();
	let aborted = false;

	const speakerSlugs = speakers.map((s) => s.slug);

	const findSpeaker = (name: string): MindSpec | undefined => {
		const lower = name.trim().toLowerCase();
		return speakers.find((s) => s.slug.toLowerCase() === lower);
	};

	const nextUnheard = (): MindSpec =>
		speakers.find((s) => !spokenSlugs.has(s.slug)) ?? speakers[0];

	const leastSpoken = (): MindSpec => {
		let min = Infinity;
		let pick = speakers[0];
		for (const s of speakers) {
			const c = speakerCounts.get(s.slug) ?? 0;
			if (c < min) {
				min = c;
				pick = s;
			}
		}
		return pick;
	};

	const allHeardInCycle = (round: number): boolean =>
		speakers.every((s) => (speakerCounts.get(s.slug) ?? 0) >= round);

	const spawnModerator = async (
		phase: ModeratorPhase,
	): Promise<SpawnMindResult | null> => {
		if (input.context.signal.aborted) return null;
		const prompt = buildModeratorPrompt({
			moderatorSlug,
			speakers: speakerSlugs,
			userMessage: input.userMessage,
			transcript,
			phase,
			spokenSlugs,
		});
		// Moderator JSON deliberation is hidden from the user transcript view —
		// we DO NOT emit mind-start/mind-end for it. Only the routing chip via
		// emitModeratorDecision is visible.
		try {
			const result = await input.context.spawn({
				slug: moderator.slug,
				persona: moderator.persona,
				prompt,
				cwd: input.context.cwd,
				model: moderator.model,
				fallbackModels: moderator.fallbackModels,
				tools: moderator.tools,
				signal: input.context.signal,
				onDelta: () => {
					/* hidden — no streaming */
				},
			});
			usageTotal.input += result.usage.input;
			usageTotal.output += result.usage.output;
			usageTotal.cost += result.usage.cost;
			return result;
		} catch (err) {
			void err;
			return null;
		}
	};

	const spawnSpeaker = async (
		mind: MindSpec,
		turnNumber: number,
		direction: string | undefined,
	): Promise<SpawnMindResult> => {
		const messageId = input.context.emitMindStart(
			mind.slug,
			"speaker",
			turnNumber,
		);
		const prompt = buildSpeakerPrompt({
			mindSlug: mind.slug,
			mode: input.mode,
			participants: input.participantOrder,
			userMessage: input.userMessage,
			history: [...input.roundHistory, ...transcript],
			moderatorDirection: direction || undefined,
		});
		const result = await input.context.spawn({
			slug: mind.slug,
			persona: mind.persona,
			prompt,
			cwd: input.context.cwd,
			model: mind.model,
			fallbackModels: mind.fallbackModels,
			tools: mind.tools,
			signal: input.context.signal,
			onDelta: (delta) =>
				input.context.emitMindDelta(messageId, mind.slug, delta),
			onAttemptStart: () =>
				input.context.emitMindReset?.(messageId, mind.slug),
		});
		input.context.emitMindEnd(
			messageId,
			mind.slug,
			"speaker",
			result,
			turnNumber,
		);
		usageTotal.input += result.usage.input;
		usageTotal.output += result.usage.output;
		usageTotal.cost += result.usage.cost;
		if (result.aborted) aborted = true;
		return result;
	};

	// ── Opening ──
	const opening = await spawnModerator("open");
	const openingDecision = opening
		? parseModeratorDecision(opening.finalText)
		: null;
	let nextSpeakerMind: MindSpec;
	let nextDirection = openingDecision?.direction ?? "";
	if (openingDecision?.nextSpeaker) {
		nextSpeakerMind = findSpeaker(openingDecision.nextSpeaker) ?? speakers[0];
	} else {
		nextSpeakerMind = speakers[0];
	}
	input.context.emitModeratorDecision(moderatorSlug, {
		action: "open",
		phase: "open",
		nextSpeaker: openingDecision?.nextSpeaker || nextSpeakerMind.slug,
		direction: openingDecision?.direction || "",
	});

	// ── Main loop ──
	for (let turn = 0; turn < config.maxTurns; turn++) {
		if (input.context.signal.aborted || aborted) break;
		const turnNumber = turn + 1;

		// Apply one-shot director overrides BEFORE the speaker turn. The host
		// should clear the override on consume so it applies once only.
		const overrides = input.context.consumeDirectorOverrides?.();
		if (overrides?.nextSpeaker) {
			const found = findSpeaker(overrides.nextSpeaker);
			if (found) {
				nextSpeakerMind = found;
				input.context.emitModeratorDecision(moderatorSlug, {
					action: "direct",
					phase: "moderate",
					nextSpeaker: found.slug,
					direction: overrides.directionInjection
						? `${overrides.directionInjection} (director)`
						: "(director override)",
				});
			}
		}
		if (overrides?.directionInjection) {
			nextDirection = nextDirection
				? `${overrides.directionInjection}\n\n${nextDirection}`
				: overrides.directionInjection;
		}

		const speaker = nextSpeakerMind;
		const result = await spawnSpeaker(speaker, turnNumber, nextDirection);
		transcript.push({
			speaker: speaker.slug,
			content: result.finalText,
			turnNumber,
		});
		speakerCounts.set(speaker.slug, (speakerCounts.get(speaker.slug) ?? 0) + 1);
		spokenSlugs.add(speaker.slug);

		if (input.context.signal.aborted || aborted) break;

		const completedRounds = Math.min(
			...speakers.map((s) => speakerCounts.get(s.slug) ?? 0),
		);
		const canClose =
			completedRounds >= config.minRounds && allHeardInCycle(config.minRounds);
		const phase: ModeratorPhase = canClose ? "may_close" : "moderate";

		const decisionMsg = await spawnModerator(phase);
		const decision: ModeratorDecision | null = decisionMsg
			? parseModeratorDecision(decisionMsg.finalText)
			: null;

		input.context.emitModeratorDecision(moderatorSlug, {
			action: decision?.action ?? "direct",
			phase,
			nextSpeaker: decision?.nextSpeaker ?? "",
			direction: decision?.direction ?? "",
		});

		if (decision?.action === "close" && canClose) {
			// Synthesis step
			if (input.context.signal.aborted || aborted) break;
			const synthMsgId = input.context.emitMindStart(
				moderatorSlug,
				"synthesis",
				turnNumber + 1,
			);
			const synthPrompt = buildSynthesisPrompt({
				moderatorSlug,
				participants: input.participantOrder,
				userMessage: input.userMessage,
				transcript,
			});
			const synthResult = await input.context.spawn({
				slug: moderator.slug,
				persona: moderator.persona,
				prompt: synthPrompt,
				cwd: input.context.cwd,
				model: moderator.model,
				fallbackModels: moderator.fallbackModels,
				tools: moderator.tools,
				signal: input.context.signal,
				onDelta: (delta) =>
					input.context.emitMindDelta(synthMsgId, moderatorSlug, delta),
				onAttemptStart: () =>
					input.context.emitMindReset?.(synthMsgId, moderatorSlug),
			});
			input.context.emitMindEnd(
				synthMsgId,
				moderatorSlug,
				"synthesis",
				synthResult,
				turnNumber + 1,
			);
			usageTotal.input += synthResult.usage.input;
			usageTotal.output += synthResult.usage.output;
			usageTotal.cost += synthResult.usage.cost;
			transcript.push({
				speaker: moderatorSlug,
				content: synthResult.finalText,
				turnNumber: turnNumber + 1,
				isModerator: true,
			});
			break;
		}

		// Pick next speaker
		nextDirection = decision?.direction ?? "";
		if (decision?.nextSpeaker) {
			const found = findSpeaker(decision.nextSpeaker);
			if (found) {
				const count = speakerCounts.get(found.slug) ?? 0;
				nextSpeakerMind =
					count >= config.maxSpeakerRepeats ? leastSpoken() : found;
			} else {
				nextSpeakerMind = nextUnheard();
			}
		} else {
			nextSpeakerMind = nextUnheard();
		}
	}

	const durationMs = Date.now() - start;
	const metrics = {
		mode: input.mode,
		turns: transcript.length,
		speakers: speakers.length,
		durationMs,
		usage: usageTotal,
	};
	input.context.emitRoundMetrics(metrics);
	return {
		...metrics,
		transcript,
		usage: usageTotal,
	};
}

function emptyResult(mode: string, start: number): StrategyResult {
	return {
		mode,
		turns: 0,
		speakers: 0,
		durationMs: Date.now() - start,
		transcript: [],
		usage: { input: 0, output: 0, cost: 0 },
	};
}
