/**
 * room-strategies/_test-helpers — fixtures shared across the per-strategy
 * test files. The leading underscore signals "module-private to tests" and
 * keeps the file name from matching Bun's `*.test.ts` pattern so it doesn't
 * run as a test itself.
 */

import type { SpawnMindResult } from "../spawn.ts";
import type {
	MindSpec,
	OrchestrationContext,
	SpawnFn,
} from "./index.ts";

export type CapturedSpawn = {
	slug: string;
	prompt: string;
	cwd: string;
	hasModeratorDirection: boolean;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
	hasOnAttemptStart: boolean;
};

export type EmittedEvent =
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

export function makeMindSpec(slug: string, paletteIndex = 0): MindSpec {
	return { slug, persona: `# ${slug}\nIdentity.\n`, paletteIndex };
}

export function makeContext(
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

/**
 * Build a deterministic SpawnFn that returns canned text per slug. The
 * `failuresBySlug` map simulates the spawnMind retry wrapper: the first N
 * entries return error results (consuming fallbackModels in order), and
 * the (N+1)th call returns success with the active model.
 */
export function fakeSpawn(
	captured: CapturedSpawn[],
	textBySlug: Record<string, string>,
	options: {
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
