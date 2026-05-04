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
 * The operator's user message also shapes routing. `detectUserAddressMentions`
 * returns an ordered list of named participants and the loop selects one of
 * three sub-policies:
 * - `broadcast` (no slugs named) — full discussion loop with the leastSpoken
 *   fallback and end-vote gate.
 * - `single` (one slug named) — lead speaks, round closes unless they
 *   explicitly hand off via `{action:"address"}`.
 * - `chain` (two+ slugs named) — lead first, then the queued slugs each
 *   speak with an `<addressed-to-you>` block; round closes when the queue
 *   drains. End votes close all non-broadcast intents immediately.
 *
 * An optional synthesizer (named via `input.synthesisConfig.mode`) closes
 * the round with a recap. Routing fallbacks (self-address, unknown slug,
 * repeat-cap) all emit `notifyWarning` so config and modeling problems
 * surface to the operator instead of silently rerouting.
 */

import {
	detectUserAddressMentions,
	inheritedAddressMentions,
	isExplicitBroadcast,
} from "../core.ts";
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
	endVoteThreshold: 0.49,
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

	// ── Routing intent + optional opener ──
	let openerDirection: string | undefined;
	let nextSpeakerMind: MindSpec = speakers[0];

	// Pull the named-participant set out of the user message and pick a
	// sub-policy. Empty set = broadcast (current open-floor behavior). One
	// name = single (close after lead unless they hand off). Two or more =
	// chain (lead first, then drain the queue with `addressed-to-you`
	// framing on each handoff).
	//
	// Stickiness: a blank follow-up ("what about Y?" after "moneypenny, X")
	// inherits the prior round's intent — without this, the leastSpoken
	// fallback would pull other minds in just because the operator's reply
	// didn't repeat the slug. An explicit broadcast token in the current
	// message ("team, …" / "everyone, …") forces broadcast and breaks the
	// inheritance, so the operator always has an escape hatch.
	type RoutingIntent = "broadcast" | "single" | "chain";
	const currentMentions = detectUserAddressMentions(
		input.userMessage,
		speakers,
	);
	const explicitBroadcast = isExplicitBroadcast(input.userMessage);
	let userMentions: string[];
	let intentInherited = false;
	if (currentMentions.length > 0 || explicitBroadcast) {
		userMentions = currentMentions;
	} else {
		const inherited = inheritedAddressMentions(input.roundHistory, speakers);
		userMentions = inherited;
		intentInherited = inherited.length > 0;
	}
	const intent: RoutingIntent =
		userMentions.length === 0
			? "broadcast"
			: userMentions.length === 1
				? "single"
				: "chain";
	const chainQueue: string[] = userMentions.slice(1);

	const userLead =
		userMentions.length > 0 ? findSpeaker(userMentions[0]) : undefined;
	if (userLead) {
		nextSpeakerMind = userLead;
		const base =
			intent === "single"
				? `Routed: single → ${userLead.slug}`
				: `Routed: chain → ${userMentions.join(" → ")}`;
		const direction = intentInherited ? `${base} (continued).` : `${base}.`;
		input.context.emitModeratorDecision(input.openerSlug ?? userLead.slug, {
			action: "open",
			phase: "open",
			nextSpeaker: userLead.slug,
			direction,
		});
	} else if (input.openerSlug) {
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
			// Single & chain rounds aren't running a consensus loop — one
			// explicit "done" is enough. Broadcast still tallies and waits
			// for the threshold via `canCloseByEndVote`.
			if (intent !== "broadcast") break;
		}

		if (canCloseByEndVote()) break;

		// Single intent: close after the lead's turn unless they explicitly
		// hand off to a peer. This is the core fix for the "I asked
		// Moneypenny but Jarvis chimed in too" pattern — without it, the
		// leastSpoken fallback would force an unrequested second speaker.
		if (intent === "single" && tail?.action !== "address") break;

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

		// Chain intent: drain the operator-named queue when the speaker
		// didn't explicitly hand off elsewhere. The just-finished speaker is
		// surfaced as the addresser so the next mind engages with what was
		// just said. Respects the repeat cap.
		if (!nextPicked && intent === "chain" && chainQueue.length > 0) {
			const queuedSlug = chainQueue.shift() as string;
			const target = findSpeaker(queuedSlug);
			const targetCount = target
				? (speakerCounts.get(target.slug) ?? 0)
				: 0;
			if (target && targetCount < config.maxSpeakerRepeats) {
				nextPicked = target;
				addressedFrom = { slug: speaker.slug };
				input.context.emitModeratorDecision(speaker.slug, {
					action: "direct",
					phase: "moderate",
					nextSpeaker: target.slug,
					direction: "operator-named chain",
				});
			} else if (target) {
				input.context.notifyWarning?.(
					`open-floor: chain target ${target.slug} hit the repeat cap (${config.maxSpeakerRepeats}). Closing chain.`,
				);
			}
		}

		if (!nextPicked) {
			// Non-broadcast intents close here instead of forcing another
			// speaker via leastSpoken — that fallback is what was pulling
			// unaddressed minds into targeted asks.
			if (intent !== "broadcast") break;
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
