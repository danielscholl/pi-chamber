/**
 * room-strategies — public entry. Re-exports strategy types and the
 * `executeStrategy` dispatcher so callers can `import { ... } from "./strategies/index.ts"`.
 *
 * The strategy implementations live in sibling files (concurrent.ts,
 * sequential.ts, group-chat.ts, open-floor.ts) and share an
 * `OrchestrationContext` of host-supplied callbacks defined in `types.ts`.
 * Strategies are pure orchestration: they do not touch Pi UI directly.
 */

import { executeConcurrent } from "./concurrent.ts";
import { executeGroupChat } from "./group-chat.ts";
import { executeOpenFloor } from "./open-floor.ts";
import { executeSequential } from "./sequential.ts";
import type { StrategyInput, StrategyResult } from "./types.ts";

export * from "./types.ts";
export { MAX_CONCURRENT_SPAWNS } from "./concurrent.ts";
export { emptyResult } from "./shared.ts";

/** Dispatch the per-mode strategy. Throws on unsupported modes. */
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
		case "open-floor":
			return executeOpenFloor(input);
		default:
			throw new Error(`Unsupported room mode: ${input.mode}`);
	}
}
