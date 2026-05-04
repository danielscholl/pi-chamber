/**
 * room-strategies/types — shared type contract for room orchestration strategies.
 *
 * Strategies (concurrent / sequential / group-chat / open-floor) consume an
 * `OrchestrationContext` of host-supplied callbacks and emit a `StrategyResult`.
 * The host (turn-orchestration.ts) translates the emitted callbacks into Pi UI
 * messages, observatory mirror writes, and transcript persistence.
 *
 * Keep this file logic-free — it is the seam between strategies and host wiring.
 */

import type { ChamberHistoryTurn, ModeratorPhase } from "../prompts.ts";
import type { SpawnMindResult } from "../spawn.ts";
import type { RoomMode } from "../core.ts";

export type MindSpec = {
	slug: string;
	persona: string;
	paletteIndex: number;
	model?: string;
	fallbackModels?: string[];
	tools?: string[];
};

export type SpeechRole = "speaker" | "synthesis";

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
	/**
	 * Optional hook for surfacing non-fatal failures (e.g. moderator spawn
	 * failure that falls back to a heuristic) as user-visible warnings.
	 * Without this, the strategy must swallow the error to keep the round
	 * alive, which hides config and network problems from the operator.
	 */
	notifyWarning?: (message: string) => void;
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

export type GroupChatConfig = {
	maxTurns: number;
	minRounds: number;
	maxSpeakerRepeats: number;
};

export type OpenFloorConfig = {
	maxTurns: number;
	minRounds: number;
	maxSpeakerRepeats: number;
	endVoteThreshold: number;
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
	 * in `mindsBySlug`. Open-floor reuses the same field as the closing voice. */
	synthesisConfig?: { mode: "off" | "chairman" | string };
	/** Group-chat only. When true, speakers may emit a JSON tail suggesting
	 * the next speaker; the moderator is biased toward honoring it. */
	speakerAddressing?: boolean;
	/** Open-floor only. Tunables for the speaker-routed loop. */
	openFloorConfig?: OpenFloorConfig;
	/** Open-floor only. When set, the named mind opens the discussion before
	 * speakers route the floor among themselves. `"chairman"` uses the
	 * built-in moderator; any other slug must be present in `mindsBySlug`. */
	openerSlug?: string;
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
