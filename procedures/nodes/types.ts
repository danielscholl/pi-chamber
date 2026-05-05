/**
 * Shared type contract between the executor and the per-node-type handlers.
 *
 * The executor is responsible for orchestration (DAG layering, trigger rules,
 * persistence, event emission). Node handlers receive a fully resolved input
 * (substitutions already applied, env enriched) and return a NodeOutput.
 *
 * Each handler:
 *   - performs no I/O against the run store (the executor persists)
 *   - performs no DAG-level reasoning (no upstream lookups)
 *   - is testable in isolation by stubbing the spawn / shell call
 */

import type { DagNode, NodeOutput } from "../schema/index.ts";
import type { SpawnPiOptions, SpawnPiResult } from "../spawn.ts";

/** Spawn function injected by the executor. Tests provide a stub. */
export type SpawnPiFn = (options: SpawnPiOptions) => Promise<SpawnPiResult>;

/**
 * Run a bash command. Default implementation uses `Bun.spawn`, but the
 * executor can inject a stub for tests.
 */
export interface BashSpawnInput {
	script: string;
	cwd: string;
	env: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}
export interface BashSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
}
export type BashSpawnFn = (input: BashSpawnInput) => Promise<BashSpawnResult>;

/**
 * Inputs handed to a node handler. The executor pre-resolves everything the
 * handler needs so the handler stays single-purpose.
 */
export interface NodeExecuteInput<N extends DagNode = DagNode> {
	node: N;
	/** Working directory for the run. */
	cwd: string;
	/**
	 * The fully composed environment for bash nodes (and as inherited
	 * environment for prompt/command spawns). Contains `$ARTIFACTS_DIR`,
	 * `$BASE_BRANCH`, `$1`–`$9`, `$ARGUMENTS`, plus
	 * `$<upstreamId>=<output>` entries.
	 */
	env: Record<string, string>;
	/** Workflow positional args. */
	workflowArgs: string[];
	/** Map of upstream node outputs already produced this run. */
	upstreamOutputs: Map<string, NodeOutput>;
	/** Abort propagation. */
	signal: AbortSignal;
	/** When `context: 'shared'`, the prior layer's session id is threaded here. */
	resumeSessionId?: string;
	/** Optional streaming callback for AI nodes. */
	onDelta?: (delta: string) => void;
	/** Spawn helpers (defaults provided by the executor). */
	spawnPi: SpawnPiFn;
	spawnBash: BashSpawnFn;
	/** Resolves a `command:` reference to its prompt body, or null if missing. */
	resolveCommand: (commandName: string) => Promise<string | null>;
}

export type NodeHandler<N extends DagNode = DagNode> = (
	input: NodeExecuteInput<N>,
) => Promise<NodeOutput>;
