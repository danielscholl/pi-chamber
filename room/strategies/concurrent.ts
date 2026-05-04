/**
 * room-strategies/concurrent — parallel takes from each participant.
 *
 * Each speaker fires in parallel (capped at MAX_CONCURRENT_SPAWNS) and never
 * sees the others within the round. An optional synthesizer (named via
 * `input.synthesisConfig.mode`) summarizes the parallel takes after they
 * land. Default off; opt in via saved-room `concurrentSynthesis`.
 */

import { buildConcurrentSynthesisPrompt, buildSpeakerPrompt } from "../prompts.ts";
import { mapWithConcurrencyLimit } from "../spawn.ts";
import { emptyResult } from "./shared.ts";
import type {
	MindSpec,
	StrategyInput,
	StrategyResult,
} from "./types.ts";
import type { ChamberHistoryTurn } from "../prompts.ts";

export const MAX_CONCURRENT_SPAWNS = 4;

export async function executeConcurrent(
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
