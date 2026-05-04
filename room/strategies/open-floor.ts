/**
 * room-strategies/open-floor — speakers route the floor among themselves.
 *
 * The chairman (or a named opener slug) optionally sets the topic before the
 * loop. Each speaker receives the addressing trailer and may emit
 * `{action: "address" | "pass" | "end"}` to influence routing. Termination:
 * - hard cap: `maxTurns`
 * - soft close: end-vote ratio ≥ `endVoteThreshold` after `minRounds` met
 * - abort: `/halt` via the AbortSignal
 *
 * An optional synthesizer (named via `input.synthesisConfig.mode`) closes
 * the round with a recap. Routing fallbacks (self-address, unknown slug,
 * repeat-cap) all emit `notifyWarning` so config and modeling problems
 * surface to the operator instead of silently rerouting.
 */

import {
	buildOpenFloorOpenerPrompt,
	buildSpeakerPrompt,
	buildSynthesisPrompt,
	parseModeratorDecision,
	parseSpeakerAddress,
} from "../prompts.ts";
import { emptyResult } from "./shared.ts";
import type {
	MindSpec,
	OpenFloorConfig,
	StrategyInput,
	StrategyResult,
} from "./types.ts";
import type { ChamberHistoryTurn } from "../prompts.ts";

const DEFAULT_OPEN_FLOOR_CONFIG: OpenFloorConfig = {
	maxTurns: 6,
	minRounds: 1,
	maxSpeakerRepeats: 2,
	endVoteThreshold: 0.5,
};

export async function executeOpenFloor(
	input: StrategyInput,
): Promise<StrategyResult> {
	const start = Date.now();
	const config: OpenFloorConfig = input.openFloorConfig ?? DEFAULT_OPEN_FLOOR_CONFIG;
	const speakers = input.participantOrder
		.map((slug) => input.mindsBySlug.get(slug))
		.filter((m): m is MindSpec => Boolean(m));
	if (speakers.length === 0) return emptyResult(input.mode, start);

	const usageTotal = { input: 0, output: 0, cost: 0 };
	const transcript: ChamberHistoryTurn[] = [];
	const speakerCounts = new Map<string, number>();
	const endVotes = new Set<string>();

	const findSpeaker = (name: string): MindSpec | undefined => {
		const lower = name.trim().toLowerCase();
		return speakers.find((s) => s.slug.toLowerCase() === lower);
	};
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
	const allSpokeMinRounds = (): boolean =>
		speakers.every((s) => (speakerCounts.get(s.slug) ?? 0) >= config.minRounds);
	const canCloseByEndVote = (): boolean => {
		if (!allSpokeMinRounds()) return false;
		const ratio = endVotes.size / speakers.length;
		// `>` (not `>=`) so the documented "simple majority" default of 0.5
		// requires *more than* half to close. A 1/2 or 2/4 tie does not
		// truncate the round; the user can still set a lower threshold
		// explicitly if they want tie-closes.
		return ratio > config.endVoteThreshold;
	};

	// ── Optional opener ──
	let openerDirection: string | undefined;
	let nextSpeakerMind: MindSpec = speakers[0];
	if (input.openerSlug) {
		const opener = input.mindsBySlug.get(input.openerSlug);
		if (opener) {
			const prompt = buildOpenFloorOpenerPrompt({
				openerSlug: opener.slug,
				participants: input.participantOrder,
				userMessage: input.userMessage,
				history: input.roundHistory,
			});
			try {
				const result = await input.context.spawn({
					slug: opener.slug,
					persona: opener.persona,
					prompt,
					cwd: input.context.cwd,
					model: opener.model,
					fallbackModels: opener.fallbackModels,
					tools: opener.tools,
					signal: input.context.signal,
					onDelta: () => {
						/* hidden — opener decision is not streamed */
					},
				});
				usageTotal.input += result.usage.input;
				usageTotal.output += result.usage.output;
				usageTotal.cost += result.usage.cost;
				const decision = parseModeratorDecision(result.finalText);
				if (decision?.nextSpeaker) {
					const found = findSpeaker(decision.nextSpeaker);
					if (found) nextSpeakerMind = found;
				}
				openerDirection = decision?.direction || undefined;
				input.context.emitModeratorDecision(opener.slug, {
					action: "open",
					phase: "open",
					nextSpeaker: nextSpeakerMind.slug,
					direction: openerDirection ?? "",
				});
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				input.context.notifyWarning?.(
					`Opener (${opener.slug}) failed: ${reason}. Defaulting to first participant.`,
				);
			}
		}
	}

	let addressedFrom: { slug: string; reason?: string } | undefined;
	let directionForNext: string | undefined = openerDirection;
	let aborted = false;

	for (let turn = 0; turn < config.maxTurns; turn++) {
		if (input.context.signal.aborted || aborted) break;
		const turnNumber = turn + 1;

		// One-shot director overrides — same hook group-chat uses.
		const overrides = input.context.consumeDirectorOverrides?.();
		if (overrides?.nextSpeaker) {
			const found = findSpeaker(overrides.nextSpeaker);
			if (found) {
				nextSpeakerMind = found;
				input.context.emitModeratorDecision(
					input.openerSlug ?? nextSpeakerMind.slug,
					{
						action: "direct",
						phase: "moderate",
						nextSpeaker: found.slug,
						direction: overrides.directionInjection
							? `${overrides.directionInjection} (director)`
							: "(director override)",
					},
				);
			}
		}
		if (overrides?.directionInjection) {
			if (addressedFrom) {
				// A peer already addressed this turn. Don't clobber the peer's
				// `slug` (would misattribute the director's note) or `reason`
				// (would lose the original ask). Route the injection through
				// the moderator-direction channel instead so the speaker still
				// sees it.
				directionForNext = directionForNext
					? `${overrides.directionInjection}\n\n${directionForNext}`
					: overrides.directionInjection;
			} else {
				// No peer address — surface the director's note prominently
				// in the addressed-to-you block.
				addressedFrom = {
					slug: "director",
					reason: overrides.directionInjection,
				};
			}
		}

		const speaker = nextSpeakerMind;
		const messageId = input.context.emitMindStart(
			speaker.slug,
			"speaker",
			turnNumber,
		);
		const prompt = buildSpeakerPrompt({
			mindSlug: speaker.slug,
			mode: input.mode,
			participants: input.participantOrder,
			userMessage: input.userMessage,
			history: [...input.roundHistory, ...transcript],
			moderatorDirection: directionForNext,
			addressingEnabled: true,
			...(addressedFrom ? { addressedFrom } : {}),
		});
		const result = await input.context.spawn({
			slug: speaker.slug,
			persona: speaker.persona,
			prompt,
			cwd: input.context.cwd,
			model: speaker.model,
			fallbackModels: speaker.fallbackModels,
			tools: speaker.tools,
			signal: input.context.signal,
			onDelta: (delta) =>
				input.context.emitMindDelta(messageId, speaker.slug, delta),
			onAttemptStart: () =>
				input.context.emitMindReset?.(messageId, speaker.slug),
		});
		input.context.emitMindEnd(
			messageId,
			speaker.slug,
			"speaker",
			result,
			turnNumber,
		);
		usageTotal.input += result.usage.input;
		usageTotal.output += result.usage.output;
		usageTotal.cost += result.usage.cost;
		if (result.aborted) aborted = true;

		transcript.push({
			speaker: speaker.slug,
			content: result.finalText,
			turnNumber,
		});
		speakerCounts.set(
			speaker.slug,
			(speakerCounts.get(speaker.slug) ?? 0) + 1,
		);

		// Reset per-turn carriers; the next iteration recomputes them from the
		// speaker's tail and any director overrides that arrive.
		addressedFrom = undefined;
		directionForNext = undefined;

		const tail = parseSpeakerAddress(result.finalText);
		if (tail?.action === "end") {
			endVotes.add(speaker.slug);
		}

		if (canCloseByEndVote()) break;

		// Routing.
		let nextPicked: MindSpec | undefined;
		if (tail?.action === "address" && tail.slug) {
			const target = findSpeaker(tail.slug);
			const targetCount = target
				? (speakerCounts.get(target.slug) ?? 0)
				: 0;
			if (!target) {
				input.context.notifyWarning?.(
					`open-floor: ${speaker.slug} addressed unknown slug "${tail.slug}". Falling back to least-spoken.`,
				);
			} else if (target.slug === speaker.slug) {
				input.context.notifyWarning?.(
					`open-floor: ${speaker.slug} addressed themselves. Falling back to least-spoken.`,
				);
			} else if (targetCount >= config.maxSpeakerRepeats) {
				input.context.notifyWarning?.(
					`open-floor: ${target.slug} has hit the repeat cap (${config.maxSpeakerRepeats}). Falling back to least-spoken.`,
				);
			} else {
				nextPicked = target;
				addressedFrom = {
					slug: speaker.slug,
					...(tail.reason ? { reason: tail.reason } : {}),
				};
				input.context.emitModeratorDecision(speaker.slug, {
					action: "direct",
					phase: "moderate",
					nextSpeaker: target.slug,
					direction: tail.reason ?? "",
				});
			}
		}
		if (!nextPicked) {
			nextPicked = leastSpoken();
		}
		nextSpeakerMind = nextPicked;
	}

	// ── Optional synthesis ──
	const synthSpec = input.synthesisConfig?.mode;
	if (
		synthSpec &&
		synthSpec !== "off" &&
		!input.context.signal.aborted &&
		!aborted &&
		transcript.length > 0
	) {
		const synthMind = input.mindsBySlug.get(synthSpec);
		if (synthMind) {
			const synthTurnNumber = transcript.length + 1;
			const synthMsgId = input.context.emitMindStart(
				synthMind.slug,
				"synthesis",
				synthTurnNumber,
			);
			const synthPrompt = buildSynthesisPrompt({
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
					input.context.emitMindDelta(synthMsgId, synthMind.slug, delta),
				onAttemptStart: () =>
					input.context.emitMindReset?.(synthMsgId, synthMind.slug),
			});
			input.context.emitMindEnd(
				synthMsgId,
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
