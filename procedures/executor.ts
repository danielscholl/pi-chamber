/**
 * DAG executor — the orchestrator that turns a parsed WorkflowDefinition into
 * a sequence of node handler invocations, with persistence + event emission.
 *
 * Layered execution mirrors Archon's `executeDagWorkflow`:
 *   1. `buildTopologicalLayers` arranges nodes into independent layers.
 *   2. Each layer is run via `Promise.allSettled` (parallel within a layer).
 *   3. For each node, in order:
 *      a. Check trigger_rule (`all_success` default) against upstream outputs;
 *         if 'skip', persist a skipped NodeOutput and continue.
 *      b. Evaluate `when:` against upstream outputs; if 'skip', persist and
 *         continue. Parse failure → also skip (fail-closed).
 *      c. Build the environment (`ARTIFACTS_DIR`, `BASE_BRANCH`, positional
 *         args, `$ARGUMENTS`, plus per-upstream `$<id>=<output>`).
 *      d. Resolve `resumeSessionId` for AI nodes (sequential single-node layer
 *         && `context !== 'fresh'` → thread the prior session id forward).
 *      e. Dispatch to the right handler via `selectHandler(node)`.
 *      f. Persist NodeOutput to disk and emit `node_completed` /
 *         `node_failed` / `node_skipped` events.
 *   4. After all layers settle, transition the run to one of:
 *        completed  — every node succeeded or skipped cleanly
 *        cancelled  — at least one cancel-node fired
 *        failed     — any other failure
 *
 * Persistence happens through `procedures/store.ts`. The handler contract in
 * `procedures/nodes/types.ts` is the only seam between the executor and the
 * per-node-type code.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { spawn as nodeSpawn } from "node:child_process";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { evaluateCondition } from "./conditions.ts";
import { buildTopologicalLayers } from "./graph.ts";
import { SENTINEL_CANCELLED_BY_NODE, selectHandler } from "./nodes/index.ts";
import type {
	BashSpawnFn,
	BashSpawnInput,
	BashSpawnResult,
	NodeExecuteInput,
	SpawnPiFn,
} from "./nodes/index.ts";
import type {
	DagNode,
	NodeOutput,
	WorkflowDefinition,
	WorkflowRunStatus,
} from "./schema/index.ts";
import { isCancelNode } from "./schema/index.ts";
import {
	type CurrentRunInput,
	refreshProceduresObservatoryLens,
} from "./observatory.ts";
import { spawnPiOnce } from "./spawn.ts";
import {
	appendEvent,
	type RunEvent,
	type RunPaths,
	updateRun,
	writeNodeOutput,
} from "./store.ts";
import { checkTriggerRule } from "./triggers.ts";

/**
 * Side-effecting hook used by the executor to project run state into the
 * observatory. Failures here must NEVER fail a run — call sites wrap in
 * try/catch and swallow.
 */
export type RefreshObservatoryFn = (
	cwd: string,
	current: CurrentRunInput | null,
) => void;

export const defaultRefreshObservatory: RefreshObservatoryFn = (cwd, current) => {
	refreshProceduresObservatoryLens(cwd, current);
};

// ---------------------------------------------------------------------------
// Default spawn implementations
// ---------------------------------------------------------------------------

export const defaultSpawnPi: SpawnPiFn = (options) => spawnPiOnce(options);

export const defaultSpawnBash: BashSpawnFn = async (
	input: BashSpawnInput,
): Promise<BashSpawnResult> => {
	const start = Date.now();
	const child = nodeSpawn("bash", ["-c", input.script], {
		cwd: input.cwd,
		env: { ...process.env, ...input.env },
		stdio: ["ignore", "pipe", "pipe"],
	}) as ReturnType<typeof nodeSpawn>;

	let aborted = false;
	let timedOut = false;
	let stdout = "";
	let stderr = "";

	// Bash nodes only get a timeout when the workflow author explicitly sets
	// `timeout:`. Matches Archon's behavior — long-running setup, test, or E2E
	// scripts must not be silently killed by a default the author never asked
	// for. (Earlier revisions of this file enforced a 120s default; that was a
	// footgun. See PR review.)
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (input.timeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* already dead */
			}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}, 2000).unref?.();
		}, input.timeoutMs);
		timeoutHandle.unref?.();
	}

	const onAbort = () => {
		aborted = true;
		try {
			child.kill("SIGTERM");
		} catch {
			/* already dead */
		}
	};
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	const stdoutStream = (child as { stdout?: { on: (e: string, fn: (c: Buffer) => void) => void } }).stdout;
	if (stdoutStream) {
		stdoutStream.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
	}
	const stderrStream = (child as { stderr?: { on: (e: string, fn: (c: Buffer) => void) => void } }).stderr;
	if (stderrStream) {
		stderrStream.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
	}

	const exitCode = await new Promise<number>((resolve) => {
		(child as { on: (e: string, fn: (code: number | null) => void) => void }).on(
			"exit",
			(code) => resolve(code ?? 0),
		);
	});
	if (timeoutHandle) clearTimeout(timeoutHandle);
	if (input.signal) input.signal.removeEventListener?.("abort", onAbort);

	return {
		exitCode,
		stdout,
		stderr,
		timedOut,
		aborted,
		durationMs: Date.now() - start,
	};
};

// ---------------------------------------------------------------------------
// Resolver for `command:` nodes
// ---------------------------------------------------------------------------

/**
 * Build a resolver that walks the configured command roots and returns the
 * file body for the first matching `<commandName>.md` (or `.prompt.md`).
 */
export function makeCommandResolver(commandRoots: readonly string[]) {
	return async (commandName: string): Promise<string | null> => {
		for (const root of commandRoots) {
			for (const ext of [".md", ".prompt.md"]) {
				const candidate = path.join(root, `${commandName}${ext}`);
				if (fs.existsSync(candidate)) {
					try {
						return await fs.promises.readFile(candidate, "utf-8");
					} catch {
						return null;
					}
				}
			}
		}
		return null;
	};
}

// ---------------------------------------------------------------------------
// Environment composition (BASE_BRANCH, ARTIFACTS_DIR, $1..$9, ARGUMENTS, upstreams)
// ---------------------------------------------------------------------------

export interface EnvComposeInput {
	artifactsDir: string;
	baseBranch?: string;
	workflowArgs: readonly string[];
	upstreamOutputs: ReadonlyMap<string, NodeOutput>;
}

/**
 * Compose the environment passed to bash nodes (and inherited as-is by spawned
 * pi processes).
 *
 * Note: upstream outputs are exported as `$<id>=<output>`, where the id is
 * sanitized for shell safety (non-alphanumerics become `_`). The bash handler
 * also performs `$nodeId.output[.field]` template substitution before
 * shell-out — these env vars are an additional convenience for users who
 * prefer plain `$id` over the templating.
 */
export function composeEnv(input: EnvComposeInput): Record<string, string> {
	const env: Record<string, string> = {
		ARTIFACTS_DIR: input.artifactsDir,
	};
	if (input.baseBranch) env.BASE_BRANCH = input.baseBranch;

	for (let i = 0; i < input.workflowArgs.length && i < 9; i++) {
		env[String(i + 1)] = input.workflowArgs[i] ?? "";
	}
	env.ARGUMENTS = input.workflowArgs.join(" ");

	for (const [id, out] of input.upstreamOutputs.entries()) {
		const safe = id.replace(/[^a-zA-Z0-9_]/g, "_");
		env[safe] = out.output ?? "";
	}
	return env;
}

// ---------------------------------------------------------------------------
// executeWorkflow — the main entry point
// ---------------------------------------------------------------------------

export interface ExecuteWorkflowInput {
	workflow: WorkflowDefinition;
	runId: string;
	paths: RunPaths;
	cwd: string;
	workflowArgs: string[];
	signal: AbortSignal;
	commandRoots: readonly string[];
	baseBranch?: string;
	/** Pre-existing outputs (resume scenario). Map<nodeId, NodeOutput>. */
	priorOutputs?: ReadonlyMap<string, NodeOutput>;
	/** Override spawn implementations (tests). */
	spawnPi?: SpawnPiFn;
	spawnBash?: BashSpawnFn;
	/** Optional stream callback used by handlers (forwarded to spawnPi). */
	onDelta?: (nodeId: string, delta: string) => void;
	/**
	 * Override the observatory lens refresh side-effect (tests). Default is
	 * `defaultRefreshObservatory` which writes `.pi/observatory/lenses/procedures/`.
	 */
	refreshObservatory?: RefreshObservatoryFn;
}

export interface ExecuteWorkflowResult {
	runId: string;
	finalStatus: WorkflowRunStatus;
	durationMs: number;
	nodeOutputs: Map<string, NodeOutput>;
	failedNodes: string[];
	cancelReason?: string;
}

/**
 * Run the workflow end-to-end. Persists every node's output to disk, emits
 * NDJSON events to the run's events log, and finalizes the run status. The
 * returned object is a summary the caller (slash-command UI) can render.
 */
export async function executeWorkflow(
	input: ExecuteWorkflowInput,
): Promise<ExecuteWorkflowResult> {
	const start = Date.now();
	const spawnPi = input.spawnPi ?? defaultSpawnPi;
	const spawnBash = input.spawnBash ?? defaultSpawnBash;
	const refreshObservatory = input.refreshObservatory ?? defaultRefreshObservatory;
	const resolveCommand = makeCommandResolver(input.commandRoots);

	/**
	 * Refresh the observatory lens after a node persists or at run end.
	 * Wrapped so a failed write can't fail the run. Takes the outputs Map
	 * explicitly so callers in parallel layers can pass a SNAPSHOT instead
	 * of mutating the shared `outputs` reference (sibling handlers still
	 * substitute against `upstreamOutputs`, so polluting that mid-layer
	 * would let nodes nondeterministically observe non-dependency siblings).
	 */
	const safeRefreshObservatory = (outputsForLens: Map<string, NodeOutput>) => {
		try {
			refreshObservatory(input.cwd, {
				runPaths: input.paths,
				workflow: input.workflow,
				outputs: outputsForLens,
			});
		} catch {
			/* observatory writes are best-effort */
		}
	};

	const layers = buildTopologicalLayers(input.workflow.nodes);
	const outputs = new Map<string, NodeOutput>(input.priorOutputs ?? []);

	updateRun(input.paths.runJsonPath, { status: "running" });
	emit(input.paths.eventsLogPath, {
		timestamp: new Date().toISOString(),
		type: "run_started",
		runId: input.runId,
	});

	// Sequential single-node session threading. Reset whenever we enter a
	// parallel layer (we cannot share a single session across two nodes
	// running concurrently against the same conversation).
	let lastSequentialSessionId: string | undefined;
	let cancelReason: string | undefined;
	const failedNodes: string[] = [];

	for (const layer of layers) {
		const isParallel = layer.length > 1;
		if (isParallel) lastSequentialSessionId = undefined;

		const layerResults = await Promise.allSettled(
			layer.map(async (node) => {
				if (input.signal.aborted) {
					return { nodeId: node.id, output: skippedOutput() };
				}

				// Resume path: skip nodes already completed in a prior run.
				if (input.priorOutputs?.has(node.id)) {
					emit(input.paths.eventsLogPath, {
						timestamp: new Date().toISOString(),
						type: "node_skipped",
						runId: input.runId,
						nodeId: node.id,
						data: { reason: "prior_success" },
					});
					return { nodeId: node.id, output: input.priorOutputs.get(node.id) as NodeOutput };
				}

				// 1. Trigger rule
				if (checkTriggerRule(node, outputs) === "skip") {
					const out = skippedOutput();
					writeNodeOutput(input.paths.nodesDir, node.id, out);
					emit(input.paths.eventsLogPath, {
						timestamp: new Date().toISOString(),
						type: "node_skipped",
						runId: input.runId,
						nodeId: node.id,
						data: { reason: "trigger_rule" },
					});
					return { nodeId: node.id, output: out };
				}

				// 2. when: condition (only when present)
				if (node.when) {
					const { result, parsed } = evaluateCondition(node.when, outputs);
					if (!parsed || !result) {
						const out = skippedOutput();
						writeNodeOutput(input.paths.nodesDir, node.id, out);
						emit(input.paths.eventsLogPath, {
							timestamp: new Date().toISOString(),
							type: "node_skipped",
							runId: input.runId,
							nodeId: node.id,
							data: {
								reason: parsed ? "when_false" : "when_unparseable",
								expression: node.when,
							},
						});
						return { nodeId: node.id, output: out };
					}
				}

				// 3. Compose env + resume session id
				const env = composeEnv({
					artifactsDir: input.paths.artifactsDir,
					baseBranch: input.baseBranch,
					workflowArgs: input.workflowArgs,
					upstreamOutputs: outputs,
				});
				const resumeSessionId =
					!isParallel && node.context !== "fresh" ? lastSequentialSessionId : undefined;

				const nodeStartedAtIso = new Date().toISOString();
				const nodeStartedAtMs = Date.now();
				emit(input.paths.eventsLogPath, {
					timestamp: nodeStartedAtIso,
					type: "node_started",
					runId: input.runId,
					nodeId: node.id,
				});

				// 4. Dispatch
				const handler = selectHandler(node);
				const handlerInput: NodeExecuteInput = {
					node,
					cwd: input.cwd,
					env,
					workflowArgs: input.workflowArgs,
					upstreamOutputs: outputs,
					signal: input.signal,
					resumeSessionId,
					onDelta: input.onDelta ? (delta) => input.onDelta?.(node.id, delta) : undefined,
					spawnPi,
					spawnBash,
					resolveCommand,
				};
				let output: NodeOutput;
				try {
					output = await handler(handlerInput);
				} catch (err) {
					output = {
						state: "failed",
						output: "",
						error: `handler threw: ${(err as Error).message ?? String(err)}`,
					};
				}
				output = withTiming(output, nodeStartedAtIso, Date.now() - nodeStartedAtMs);

				// 5. Persist + emit terminal event for this node
				writeNodeOutput(input.paths.nodesDir, node.id, output);
				// Refresh the observatory from a SNAPSHOT — never mutate the
				// shared `outputs` map mid-layer. Sibling handlers in a
				// parallel layer hold a reference to it and substitute against
				// it (sometimes after an async hop, e.g. commandHandler awaits
				// resolveCommand before substitution); polluting it here could
				// let one sibling nondeterministically observe another's
				// `$node.output`. The post-layer merge at the bottom of the
				// loop is the correct propagation point for the next layer.
				const lensOutputs = new Map(outputs);
				lensOutputs.set(node.id, output);
				safeRefreshObservatory(lensOutputs);
				if (output.state === "failed") {
					emit(input.paths.eventsLogPath, {
						timestamp: new Date().toISOString(),
						type: "node_failed",
						runId: input.runId,
						nodeId: node.id,
						data: { error: output.error },
					});
				} else {
					emit(input.paths.eventsLogPath, {
						timestamp: new Date().toISOString(),
						type: "node_completed",
						runId: input.runId,
						nodeId: node.id,
					});
				}
				return { nodeId: node.id, output };
			}),
		);

		// Merge layer results into the outputs map and update threading.
		let sessionIdsThisLayer: (string | undefined)[] = [];
		for (let i = 0; i < layerResults.length; i++) {
			const settled = layerResults[i];
			const node = layer[i];
			const summary =
				settled.status === "fulfilled"
					? settled.value
					: {
							nodeId: node.id,
							output: {
								state: "failed",
								output: "",
								error: `executor promise rejected: ${(settled.reason as Error)?.message ?? String(settled.reason)}`,
							} as NodeOutput,
						};
			outputs.set(summary.nodeId, summary.output);

			if (summary.output.state === "failed") {
				if (
					typeof summary.output.error === "string" &&
					summary.output.error.startsWith(SENTINEL_CANCELLED_BY_NODE) &&
					isCancelNode(node)
				) {
					cancelReason = node.cancel;
				} else {
					failedNodes.push(summary.nodeId);
				}
			}
			if (summary.output.state === "completed" || summary.output.state === "running") {
				sessionIdsThisLayer.push(summary.output.sessionId);
			}
		}

		// Thread the session id forward only when this layer was sequential
		// (single node) AND the node returned a session id.
		if (!isParallel && sessionIdsThisLayer.length === 1) {
			lastSequentialSessionId = sessionIdsThisLayer[0] ?? lastSequentialSessionId;
		}

		// A cancel-node fires immediately; abandon remaining layers.
		if (cancelReason !== undefined) break;
	}

	// 6. Finalize run status
	const completedAt = new Date().toISOString();
	let finalStatus: WorkflowRunStatus;
	if (cancelReason !== undefined) finalStatus = "cancelled";
	else if (failedNodes.length > 0) finalStatus = "failed";
	else finalStatus = "completed";

	updateRun(input.paths.runJsonPath, { status: finalStatus, completed_at: completedAt });
	// At run end the post-layer merge has populated `outputs` with every
	// settled node, so passing it directly is correct (and cheap).
	safeRefreshObservatory(outputs);

	const eventType: RunEvent["type"] =
		finalStatus === "completed"
			? "run_completed"
			: finalStatus === "cancelled"
				? "run_cancelled"
				: "run_failed";
	emit(input.paths.eventsLogPath, {
		timestamp: completedAt,
		type: eventType,
		runId: input.runId,
		data: cancelReason ? { reason: cancelReason } : { failedNodes },
	});

	return {
		runId: input.runId,
		finalStatus,
		durationMs: Date.now() - start,
		nodeOutputs: outputs,
		failedNodes,
		cancelReason,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stamp a NodeOutput with start/complete/duration timing. No-op for the
 * pending/skipped variant, which doesn't carry timing fields. Called once per
 * handler-driven node (skipped-by-condition nodes get their own untimed
 * skippedOutput()).
 *
 * Constructs each variant explicitly because TypeScript's discriminated-union
 * narrowing across `||` on the discriminator doesn't carry through to a later
 * spread literal — switching on `state` exhausts the union cleanly.
 */
function withTiming(output: NodeOutput, startedAt: string, durationMs: number): NodeOutput {
	const completedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
	switch (output.state) {
		case "pending":
		case "skipped":
			return output;
		case "failed":
			return {
				state: "failed",
				output: output.output,
				error: output.error,
				...(output.sessionId !== undefined ? { sessionId: output.sessionId } : {}),
				...(output.usage !== undefined ? { usage: output.usage } : {}),
				startedAt,
				completedAt,
				durationMs,
			};
		case "completed":
		case "running":
			return {
				state: output.state,
				output: output.output,
				...(output.sessionId !== undefined ? { sessionId: output.sessionId } : {}),
				...(output.usage !== undefined ? { usage: output.usage } : {}),
				startedAt,
				completedAt,
				durationMs,
			};
	}
}

function emit(eventsLogPath: string, event: RunEvent): void {
	try {
		appendEvent(eventsLogPath, event);
	} catch {
		/* event-log writes are best-effort */
	}
}

function skippedOutput(): NodeOutput {
	return { state: "skipped", output: "" };
}
