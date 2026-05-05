/**
 * Filesystem-backed store for procedure run state.
 *
 * Layout under `<projectRoot>/.pi/procedures/runs/<id>/`:
 *
 *   run.json           — WorkflowRun JSON (status, metadata, timestamps)
 *   events.ndjson      — append-only event log (one JSON object per line)
 *   nodes/<id>.json    — per-node NodeOutput (mirrored as `<id>.txt` for human-readable inspection)
 *   nodes/<id>.txt     — raw output text (for `cat .../runs/<id>/nodes/foo.txt`)
 *   artifacts/         — $ARTIFACTS_DIR for the run (created on demand)
 *
 * Pure file I/O — no logger, no events back to the caller. Failures throw.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import {
	type NodeOutput,
	nodeOutputSchema,
	type WorkflowRun,
	workflowRunSchema,
	type WorkflowRunStatus,
} from "./schema/index.ts";

// ---------------------------------------------------------------------------
// Run-id generation
// ---------------------------------------------------------------------------

/**
 * Generate a sortable, unique run id: `YYYYMMDD-HHmmss-<6-hex>`.
 *
 * The lexicographic sort matches chronological order, which keeps directory
 * listings tidy and makes "most recent run" trivial to compute.
 */
export function generateRunId(now: Date = new Date(), randomHex = randomHex6()): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	const stamp =
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `${stamp}-${randomHex}`;
}

function randomHex6(): string {
	return Math.floor(Math.random() * 0xffffff)
		.toString(16)
		.padStart(6, "0");
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve all paths needed for a single run inside `runsDir`. The returned
 * `runDir` and its subdirectories are created lazily by the writer functions.
 */
export interface RunPaths {
	readonly runId: string;
	readonly runDir: string;
	readonly runJsonPath: string;
	readonly eventsLogPath: string;
	readonly nodesDir: string;
	readonly artifactsDir: string;
}

export function resolveRunPaths(runsDir: string, runId: string): RunPaths {
	const runDir = path.join(runsDir, runId);
	return {
		runId,
		runDir,
		runJsonPath: path.join(runDir, "run.json"),
		eventsLogPath: path.join(runDir, "events.ndjson"),
		nodesDir: path.join(runDir, "nodes"),
		artifactsDir: path.join(runDir, "artifacts"),
	};
}

// ---------------------------------------------------------------------------
// Run create / load / update
// ---------------------------------------------------------------------------

export interface CreateRunInput {
	runsDir: string;
	workflow_name: string;
	user_message: string;
	working_path?: string;
	conversation_id?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Create a fresh run on disk. Allocates a run id, writes initial run.json with
 * `status: 'pending'`, and creates the empty `nodes/` and `artifacts/`
 * directories so node executors can write into them immediately.
 */
export function createRun(input: CreateRunInput): { paths: RunPaths; run: WorkflowRun } {
	const runId = generateRunId();
	const paths = resolveRunPaths(input.runsDir, runId);
	fs.mkdirSync(paths.runDir, { recursive: true });
	fs.mkdirSync(paths.nodesDir, { recursive: true });
	fs.mkdirSync(paths.artifactsDir, { recursive: true });

	const now = new Date().toISOString();
	const run: WorkflowRun = {
		id: runId,
		workflow_name: input.workflow_name,
		conversation_id: input.conversation_id,
		parent_conversation_id: null,
		codebase_id: null,
		status: "pending",
		user_message: input.user_message,
		metadata: input.metadata ?? {},
		started_at: now,
		completed_at: null,
		last_activity_at: now,
		working_path: input.working_path ?? null,
	};
	writeRun(paths.runJsonPath, run);
	return { paths, run };
}

export function writeRun(runJsonPath: string, run: WorkflowRun): void {
	fs.writeFileSync(runJsonPath, JSON.stringify(run, null, 2), "utf-8");
}

/**
 * Read run.json and validate. Returns `null` if the file does not exist.
 * Throws on a corrupt / schema-incompatible run file (caller decides whether
 * to treat that as fatal).
 */
export function loadRun(runJsonPath: string): WorkflowRun | null {
	if (!fs.existsSync(runJsonPath)) return null;
	const raw = fs.readFileSync(runJsonPath, "utf-8");
	const parsed = JSON.parse(raw);
	const result = workflowRunSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`run.json at ${runJsonPath} failed schema validation: ${result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ")}`,
		);
	}
	return result.data;
}

/**
 * Mutate the on-disk run with a partial update. Always refreshes
 * `last_activity_at`. Use for status transitions and completed_at.
 */
export function updateRun(
	runJsonPath: string,
	patch: Partial<Pick<WorkflowRun, "status" | "completed_at" | "metadata">>,
): WorkflowRun {
	const current = loadRun(runJsonPath);
	if (!current) throw new Error(`updateRun: no run.json at ${runJsonPath}`);
	const next: WorkflowRun = {
		...current,
		...patch,
		last_activity_at: new Date().toISOString(),
	};
	writeRun(runJsonPath, next);
	return next;
}

// ---------------------------------------------------------------------------
// Per-node output read/write
// ---------------------------------------------------------------------------

/**
 * Serialize a node's NodeOutput to disk. Two files are written:
 * - `<nodesDir>/<safeId>.json` — full NodeOutput (state, output, sessionId, error)
 * - `<nodesDir>/<safeId>.txt`  — raw output text (for human inspection)
 *
 * `safeId` strips any path separators so a malformed node id can't escape the
 * nodes/ directory.
 */
export function writeNodeOutput(
	nodesDir: string,
	nodeId: string,
	output: NodeOutput,
): void {
	fs.mkdirSync(nodesDir, { recursive: true });
	const safe = sanitizeNodeId(nodeId);
	fs.writeFileSync(path.join(nodesDir, `${safe}.json`), JSON.stringify(output, null, 2), "utf-8");
	fs.writeFileSync(path.join(nodesDir, `${safe}.txt`), output.output ?? "", "utf-8");
}

export function readNodeOutput(nodesDir: string, nodeId: string): NodeOutput | null {
	const safe = sanitizeNodeId(nodeId);
	const file = path.join(nodesDir, `${safe}.json`);
	if (!fs.existsSync(file)) return null;
	const raw = fs.readFileSync(file, "utf-8");
	const parsed = JSON.parse(raw);
	const result = nodeOutputSchema.safeParse(parsed);
	return result.success ? result.data : null;
}

/**
 * Load every node output present under `nodesDir` into a `Map<nodeId, NodeOutput>`
 * for use as the upstream-output context when resuming a workflow.
 */
export function loadAllNodeOutputs(nodesDir: string): Map<string, NodeOutput> {
	const map = new Map<string, NodeOutput>();
	if (!fs.existsSync(nodesDir)) return map;
	for (const entry of fs.readdirSync(nodesDir)) {
		if (!entry.endsWith(".json")) continue;
		const nodeId = entry.slice(0, -".json".length);
		const output = readNodeOutput(nodesDir, nodeId);
		if (output) map.set(nodeId, output);
	}
	return map;
}

function sanitizeNodeId(nodeId: string): string {
	// Defense in depth — schema already restricts to safe strings, but a
	// downstream call site could pass arbitrary input. Replace anything that
	// isn't word/dot/dash with underscore.
	return nodeId.replace(/[^\w.-]/g, "_");
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

export interface RunEvent {
	readonly timestamp: string;
	readonly type:
		| "run_started"
		| "run_completed"
		| "run_failed"
		| "run_cancelled"
		| "run_paused"
		| "node_started"
		| "node_completed"
		| "node_failed"
		| "node_skipped";
	readonly runId: string;
	readonly nodeId?: string;
	readonly data?: Record<string, unknown>;
}

export function appendEvent(eventsLogPath: string, event: RunEvent): void {
	fs.mkdirSync(path.dirname(eventsLogPath), { recursive: true });
	fs.appendFileSync(eventsLogPath, `${JSON.stringify(event)}\n`, "utf-8");
}

/**
 * Read the entire event log. Lines that fail to parse are silently dropped —
 * the log is best-effort and not the source of truth for run state.
 */
export function readEvents(eventsLogPath: string): RunEvent[] {
	if (!fs.existsSync(eventsLogPath)) return [];
	const content = fs.readFileSync(eventsLogPath, "utf-8");
	const events: RunEvent[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as RunEvent);
		} catch {
			/* drop malformed line */
		}
	}
	return events;
}

// ---------------------------------------------------------------------------
// Run listing (/procedures status)
// ---------------------------------------------------------------------------

export interface RunSummary {
	readonly runId: string;
	readonly workflow_name: string;
	readonly status: WorkflowRunStatus;
	readonly started_at: string;
	readonly completed_at?: string | null;
	readonly working_path?: string | null;
}

/**
 * List all runs under `runsDir` newest-first. Runs whose `run.json` is missing
 * or invalid are skipped silently — the directory listing isn't authoritative.
 */
export function listRuns(runsDir: string): RunSummary[] {
	if (!fs.existsSync(runsDir)) return [];
	const entries = fs
		.readdirSync(runsDir)
		.filter((name) => {
			try {
				return fs.statSync(path.join(runsDir, name)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort()
		.reverse();
	const summaries: RunSummary[] = [];
	for (const name of entries) {
		try {
			const run = loadRun(path.join(runsDir, name, "run.json"));
			if (!run) continue;
			summaries.push({
				runId: run.id,
				workflow_name: run.workflow_name,
				status: run.status,
				started_at: typeof run.started_at === "string" ? run.started_at : run.started_at.toISOString(),
				completed_at:
					run.completed_at == null
						? null
						: typeof run.completed_at === "string"
							? run.completed_at
							: run.completed_at.toISOString(),
				working_path: run.working_path,
			});
		} catch {
			/* skip corrupt entry */
		}
	}
	return summaries;
}
