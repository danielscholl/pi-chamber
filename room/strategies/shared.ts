/**
 * room-strategies/shared — helpers used by every strategy.
 *
 * Strategy-specific defaults live with the strategy that consumes them
 * (e.g. concurrent.ts owns MAX_CONCURRENT_SPAWNS, group-chat.ts owns the
 * group-chat default-config consts). Only genuinely cross-strategy helpers
 * land here.
 */

import type { StrategyResult } from "./types.ts";

export function emptyResult(mode: string, start: number): StrategyResult {
	return {
		mode,
		turns: 0,
		speakers: 0,
		durationMs: Date.now() - start,
		transcript: [],
		usage: { input: 0, output: 0, cost: 0 },
	};
}
