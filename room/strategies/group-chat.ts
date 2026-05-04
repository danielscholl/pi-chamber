/**
 * room-strategies/group-chat — moderator routes the floor.
 *
 * The chairman (or a saved-room `synthesizer` slug) opens the round, picks
 * each next speaker via hidden JSON deliberation, and synthesizes at close.
 * When `speakerAddressing` is on, speakers may emit a tail JSON suggesting
 * who should speak next; the moderator is biased toward honoring it but
 * still enforces repeat-cap and round-floor.
 */

import {
	buildModeratorPrompt,
	buildSpeakerPrompt,
	buildSynthesisPrompt,
	type ModeratorDecision,
	type ModeratorPhase,
	parseModeratorDecision,
	parseSpeakerAddress,
	type SpeakerAddress,
} from "../prompts.ts";
import type { SpawnMindResult } from "../spawn.ts";
import { emptyResult } from "./shared.ts";
import type {
	GroupChatConfig,
	MindSpec,
	StrategyInput,
	StrategyResult,
} from "./types.ts";
import type { ChamberHistoryTurn } from "../prompts.ts";

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_MIN_ROUNDS = 1;
const DEFAULT_REPEAT_CAP = 2;

export async function executeGroupChat(
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
	const endVotes = new Set<string>();
	let aborted = false;
	let pendingSpeakerSuggestion: { slug: string; reason?: string } | undefined;

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
			...(pendingSpeakerSuggestion
				? { speakerSuggestion: pendingSpeakerSuggestion }
				: {}),
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
			const reason = err instanceof Error ? err.message : String(err);
			input.context.notifyWarning?.(
				`Moderator (${moderator.slug}) failed during ${phase}: ${reason}. Falling back to round-robin pick.`,
			);
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
			// `addressablePeers` is the moderator-filtered set so the trailer
			// only advertises slugs that `findSpeaker()` will accept. Without
			// this, a participant-slug synthesizer would appear in the prompt
			// but get discarded as "unknown" when actually addressed.
			...(input.speakerAddressing
				? { addressingEnabled: true, addressablePeers: speakerSlugs }
				: {}),
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

		// Parse the speaker's optional address tail. When `speakerAddressing`
		// is on, the resulting suggestion is surfaced to the moderator on the
		// next decision; an `end` vote after `canClose` triggers an early close
		// without the moderator override.
		pendingSpeakerSuggestion = undefined;
		const speakerTail: SpeakerAddress | null = input.speakerAddressing
			? parseSpeakerAddress(result.finalText)
			: null;
		if (speakerTail?.action === "address" && speakerTail.slug) {
			const target = findSpeaker(speakerTail.slug);
			const targetCount = target
				? (speakerCounts.get(target.slug) ?? 0)
				: 0;
			// Reject self-address, unknown slug, or repeat-cap exhaustion.
			// Falling through to undefined leaves the moderator uninfluenced.
			if (
				target &&
				target.slug !== speaker.slug &&
				targetCount < config.maxSpeakerRepeats
			) {
				pendingSpeakerSuggestion = {
					slug: target.slug,
					...(speakerTail.reason ? { reason: speakerTail.reason } : {}),
				};
			}
		}
		if (speakerTail?.action === "end") {
			endVotes.add(speaker.slug);
		}

		if (input.context.signal.aborted || aborted) break;

		const completedRounds = Math.min(
			...speakers.map((s) => speakerCounts.get(s.slug) ?? 0),
		);
		const canClose =
			completedRounds >= config.minRounds && allHeardInCycle(config.minRounds);
		const phase: ModeratorPhase = canClose ? "may_close" : "moderate";

		// Speaker-side end vote: in `speakerAddressing` rooms, a speaker can
		// vote to close the discussion. We honor a single end vote once
		// `canClose` is met, without spending another moderator deliberation.
		// The moderator still drives synthesis below.
		const speakerEndVoteCloses =
			input.speakerAddressing && canClose && endVotes.has(speaker.slug);

		const decisionMsg = speakerEndVoteCloses
			? null
			: await spawnModerator(phase);
		const decision: ModeratorDecision | null = decisionMsg
			? parseModeratorDecision(decisionMsg.finalText)
			: null;

		const effectiveAction = speakerEndVoteCloses
			? "close"
			: decision?.action ?? "direct";

		input.context.emitModeratorDecision(moderatorSlug, {
			action: effectiveAction,
			phase,
			nextSpeaker: decision?.nextSpeaker ?? "",
			direction:
				decision?.direction ??
				(speakerEndVoteCloses ? "speaker requested close" : ""),
		});

		if ((effectiveAction === "close") && canClose) {
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
