/**
 * room-strategies/sequential — ordered critique / refinement chain.
 *
 * Speakers go in `participantOrder`; each later speaker sees the prior
 * speakers' turns within the round (via the growing `roundTurns` history
 * fed into the prompt). No moderator; no routing. Used when the user wants
 * a deterministic refinement chain rather than parallel or moderated debate.
 */

import { buildSpeakerPrompt } from "../prompts.ts";
import { emptyResult } from "./shared.ts";
import type {
	MindSpec,
	StrategyInput,
	StrategyResult,
} from "./types.ts";
import type { ChamberHistoryTurn } from "../prompts.ts";

export async function executeSequential(
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
