/**
 * procedures-observatory — write a `dag-run` observatory lens that mirrors
 * procedure run state to disk. Reload-based: the user sees updates by
 * pressing `r` in /observatory.
 *
 * Conforms to the v1 observatory lens schema (kind: "dag-run", source:
 * "data.json") and stays inside the project via `assertInsideProject`.
 *
 * Mirrors `room/observatory.ts` in shape; the data shape is richer because
 * procedures have a DAG topology, per-node artifacts, and run history.
 *
 * Single entry point for the executor: `refreshProceduresObservatoryLens`.
 * All builders below it are pure so they're independently testable.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import path from "node:path";

import { assertInsideProject } from "../genesis/core.ts";
import { loadObservatoryConfig, resolveLensesRoot } from "../observatory/core.ts";
import { buildTopologicalLayers } from "./graph.ts";
import {
	listRuns,
	loadRun,
	type RunPaths,
	type RunSummary,
} from "./store.ts";
import type {
	DagNode,
	NodeOutput,
	NodeState,
	TokenUsage,
	WorkflowDefinition,
	WorkflowRun,
	WorkflowRunStatus,
} from "./schema/index.ts";

export const LENS_ID = "procedures";
export const LENS_DATA_FILE = "data.json";
export const LENS_MANIFEST_FILE = "lens.json";
/** Subdirectory under the lens where per-run full DAG snapshots live. */
export const RUNS_SUBDIR = "runs";

/** Cap on history-list size written into the lens. Older runs stay on disk. */
export const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/**
 * The complete payload written to `data.json`. `runs` is the history slice
 * (newest first, capped at MAX_HISTORY); `current` is the most-recent run's
 * full DAG snapshot. `current` can be null on first call before any run has
 * happened (the lens still renders an empty history page).
 */
export interface ProceduresSnapshot {
	generatedAt: string;
	runs: ProcedureRunSummary[];
	current: ProcedureRunDetail | null;
}

export type ProcedureNodeKind =
	| "prompt"
	| "command"
	| "bash"
	| "loop"
	| "approval"
	| "cancel"
	| "script";

/** Per-node view used by both run-detail and the dagGraph widget. */
export interface ProcedureNodeView {
	id: string;
	kind: ProcedureNodeKind;
	status: NodeState;
	dependsOn: string[];
	dependents: string[];
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	sessionId?: string;
	error?: string;
	output?: string;
	usage?: TokenUsage;
}

export interface ProcedureRunDetail {
	runId: string;
	workflowName: string;
	status: WorkflowRunStatus;
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	/** node ids, grouped by topological layer (output of buildTopologicalLayers) */
	layers: string[][];
	/** keyed by node id, all nodes in the workflow */
	nodes: Record<string, ProcedureNodeView>;
	totalTokens?: number;
	totalCostUsd?: number;
}

export interface ProcedureRunSummary {
	runId: string;
	workflowName: string;
	status: WorkflowRunStatus;
	startedAt: string;
	completedAt?: string | null;
	durationMs?: number;
	nodeCount: number;
	failedCount: number;
	totalTokens?: number;
	totalCostUsd?: number;
	workingPath?: string | null;
}

export interface ResolvedObservatoryPaths {
	lensDir: string;
	manifestPath: string;
	dataPath: string;
}

/** Input the executor passes for the in-progress / just-completed run. */
export interface CurrentRunInput {
	runPaths: RunPaths;
	workflow: WorkflowDefinition;
	outputs: Map<string, NodeOutput>;
}

// ---------------------------------------------------------------------------
// Path / manifest helpers (mirror room/observatory.ts)
// ---------------------------------------------------------------------------

export function resolveProceduresObservatoryPaths(cwd: string): ResolvedObservatoryPaths {
	const config = loadObservatoryConfig(cwd);
	const lensesRoot = resolveLensesRoot(cwd, config);
	const lensDir = path.join(lensesRoot, LENS_ID);
	assertInsideProject(cwd, lensDir, "procedures observatory lensDir");
	return {
		lensDir,
		manifestPath: path.join(lensDir, LENS_MANIFEST_FILE),
		dataPath: path.join(lensDir, LENS_DATA_FILE),
	};
}

export function buildProceduresObservatoryManifest(): Record<string, unknown> {
	return {
		name: "Procedures",
		kind: "dag-run",
		source: LENS_DATA_FILE,
		icon: "git-branch",
		description:
			"Procedure run history. Drill into a run to see its DAG and per-node detail.",
	};
}

// ---------------------------------------------------------------------------
// Pure builders (no I/O)
// ---------------------------------------------------------------------------

/**
 * Discriminator for DagNode → which variant it is. The DagNode union doesn't
 * carry an explicit `type` field; we infer from which mutually-exclusive
 * verb-field is set. Defaults to "prompt" if none match (defensive — should
 * never happen for a workflow that parsed against dagNodeSchema).
 */
export function nodeKind(node: DagNode): ProcedureNodeKind {
	if ("command" in node && typeof node.command === "string") return "command";
	if ("prompt" in node && typeof node.prompt === "string") return "prompt";
	if ("bash" in node && typeof node.bash === "string") return "bash";
	if ("script" in node && typeof node.script === "string") return "script";
	if ("loop" in node && node.loop) return "loop";
	if ("approval" in node && node.approval) return "approval";
	if ("cancel" in node && typeof node.cancel === "string") return "cancel";
	return "prompt";
}

/**
 * Build a `parentId → childId[]` adjacency map from the workflow's
 * `depends_on` edges so the run-detail page can show "what runs after X".
 */
export function dependentsByNodeId(nodes: DagNode[]): Record<string, string[]> {
	const dependents: Record<string, string[]> = {};
	for (const node of nodes) dependents[node.id] = [];
	for (const node of nodes) {
		for (const parent of node.depends_on ?? []) {
			if (!dependents[parent]) dependents[parent] = [];
			dependents[parent].push(node.id);
		}
	}
	return dependents;
}

/**
 * Map a DagNode + its NodeOutput (or undefined for not-yet-run) to the lens's
 * per-node view shape.
 */
export function buildProcedureNodeView(
	node: DagNode,
	output: NodeOutput | undefined,
	dependents: string[],
): ProcedureNodeView {
	const base: ProcedureNodeView = {
		id: node.id,
		kind: nodeKind(node),
		status: output?.state ?? "pending",
		dependsOn: [...(node.depends_on ?? [])],
		dependents,
	};
	if (!output) return base;
	if (output.state === "completed" || output.state === "running" || output.state === "failed") {
		if (output.sessionId) base.sessionId = output.sessionId;
		if (output.startedAt) base.startedAt = output.startedAt;
		if (output.completedAt) base.completedAt = output.completedAt;
		if (output.durationMs !== undefined) base.durationMs = output.durationMs;
		if (output.usage) base.usage = output.usage;
	}
	if (output.state === "failed" && output.error) base.error = output.error;
	if (output.output && output.output.length > 0) base.output = output.output;
	return base;
}

/**
 * Pure builder for the in-progress / just-completed run's full DAG snapshot.
 */
export function buildProcedureRunDetail(
	runId: string,
	workflow: WorkflowDefinition,
	outputs: Map<string, NodeOutput>,
	run: WorkflowRun | null,
): ProcedureRunDetail {
	const nodes = workflow.nodes as DagNode[];
	const layers = buildTopologicalLayers(nodes).map((layer) =>
		layer.map((n) => n.id),
	);
	const dependents = dependentsByNodeId(nodes);
	const nodeViews: Record<string, ProcedureNodeView> = {};
	for (const node of nodes) {
		nodeViews[node.id] = buildProcedureNodeView(
			node,
			outputs.get(node.id),
			dependents[node.id] ?? [],
		);
	}
	const totals = sumUsage(outputs);
	const detail: ProcedureRunDetail = {
		runId,
		workflowName: workflow.name,
		status: run?.status ?? "running",
		startedAt: run ? isoOrPassthrough(run.started_at) : new Date().toISOString(),
		layers,
		nodes: nodeViews,
	};
	if (run?.completed_at) detail.completedAt = isoOrPassthrough(run.completed_at);
	if (detail.completedAt) {
		detail.durationMs = Math.max(
			0,
			new Date(detail.completedAt).getTime() - new Date(detail.startedAt).getTime(),
		);
	}
	if (totals.totalTokens > 0) detail.totalTokens = totals.totalTokens;
	if (totals.totalCostUsd > 0) detail.totalCostUsd = totals.totalCostUsd;
	return detail;
}

/**
 * Build a one-line summary for the history list. `outputs` is optional —
 * when missing (loading old runs from disk for the history view) we fall back
 * to the per-run RunSummary fields and compute totals lazily.
 */
export function buildProcedureRunSummary(
	source: RunSummary,
	outputs?: Map<string, NodeOutput>,
): ProcedureRunSummary {
	const summary: ProcedureRunSummary = {
		runId: source.runId,
		workflowName: source.workflow_name,
		status: source.status,
		startedAt: source.started_at,
		nodeCount: outputs ? outputs.size : 0,
		failedCount: 0,
	};
	if (source.completed_at != null) summary.completedAt = source.completed_at;
	if (source.completed_at && source.started_at) {
		summary.durationMs = Math.max(
			0,
			new Date(source.completed_at).getTime() -
				new Date(source.started_at).getTime(),
		);
	}
	if (source.working_path != null) summary.workingPath = source.working_path;
	if (outputs) {
		let failed = 0;
		for (const out of outputs.values()) if (out.state === "failed") failed++;
		summary.failedCount = failed;
		const totals = sumUsage(outputs);
		if (totals.totalTokens > 0) summary.totalTokens = totals.totalTokens;
		if (totals.totalCostUsd > 0) summary.totalCostUsd = totals.totalCostUsd;
	}
	return summary;
}

function sumUsage(outputs: Map<string, NodeOutput>): {
	totalTokens: number;
	totalCostUsd: number;
} {
	let totalTokens = 0;
	let totalCostUsd = 0;
	for (const out of outputs.values()) {
		// Switch on the discriminator so TypeScript narrows reliably — the
		// `||`-on-state pattern doesn't carry narrowing to subsequent reads.
		switch (out.state) {
			case "pending":
			case "skipped":
				continue;
			case "completed":
			case "running":
			case "failed": {
				const u = out.usage;
				if (!u) continue;
				if (typeof u.totalTokens === "number") totalTokens += u.totalTokens;
				if (typeof u.costUsd === "number") totalCostUsd += u.costUsd;
			}
		}
	}
	return { totalTokens, totalCostUsd };
}

function isoOrPassthrough(value: string | Date): string {
	return typeof value === "string" ? value : value.toISOString();
}

// ---------------------------------------------------------------------------
// I/O entry points
// ---------------------------------------------------------------------------

/**
 * Single executor entry point. Builds the full snapshot from disk + the
 * current in-memory run state, then writes it. Idempotent and append-safe —
 * call after every node and at run completion. Errors are the caller's
 * responsibility to swallow (so a write failure can't fail a run).
 */
export function refreshProceduresObservatoryLens(
	cwd: string,
	current: CurrentRunInput | null,
): ResolvedObservatoryPaths {
	const snapshot = collectProceduresSnapshot(current);
	return writeProceduresObservatoryLens(cwd, snapshot);
}

/**
 * Assemble the full snapshot. Reads `current.runPaths.runJsonPath` to pick
 * up the latest status/timestamps, and lists prior runs for the history
 * slice. Pure-ish: still does file I/O but no caller-visible side effects.
 */
export function collectProceduresSnapshot(
	current: CurrentRunInput | null,
): ProceduresSnapshot {
	const generatedAt = new Date().toISOString();
	if (!current) {
		return { generatedAt, runs: [], current: null };
	}
	const run = loadRun(current.runPaths.runJsonPath);
	const detail = buildProcedureRunDetail(
		current.runPaths.runId,
		current.workflow,
		current.outputs,
		run,
	);
	const runsDir = path.dirname(current.runPaths.runDir);
	const summaries = listRuns(runsDir).slice(0, MAX_HISTORY);
	const runs: ProcedureRunSummary[] = summaries.map((s) =>
		// Only the active run gets per-node totals (we have its fresh outputs
		// map in memory). Historical runs ship status + duration only — the
		// detail page lazily loads their nodes/ on drill-in. This keeps each
		// refresh O(1) in history size instead of O(history × nodes).
		s.runId === current.runPaths.runId
			? buildProcedureRunSummary(s, current.outputs)
			: buildProcedureRunSummary(s),
	);
	return { generatedAt, runs, current: detail };
}

export function writeProceduresObservatoryLens(
	cwd: string,
	snapshot: ProceduresSnapshot,
): ResolvedObservatoryPaths {
	const paths = resolveProceduresObservatoryPaths(cwd);
	mkdirSync(paths.lensDir, { recursive: true });
	const manifest = buildProceduresObservatoryManifest();
	writeFileSync(
		paths.manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf-8",
	);
	writeFileSync(
		paths.dataPath,
		`${JSON.stringify(snapshot, null, 2)}\n`,
		"utf-8",
	);
	// Persist a per-run snapshot for the current run so the lens UI can drill
	// into ANY historical run's full DAG without re-loading the workflow YAML.
	if (snapshot.current) {
		writeProcedureRunSnapshot(paths.lensDir, snapshot.current);
	}
	return paths;
}

/**
 * Write the full DAG detail for a single run under the lens's runs/ subdir.
 * Re-written on every refresh while a run is active; once the run is terminal
 * the snapshot stays frozen.
 */
export function writeProcedureRunSnapshot(
	lensDir: string,
	detail: ProcedureRunDetail,
): string {
	const runsDir = path.join(lensDir, RUNS_SUBDIR);
	mkdirSync(runsDir, { recursive: true });
	const filePath = path.join(runsDir, `${detail.runId}.json`);
	writeFileSync(filePath, `${JSON.stringify(detail, null, 2)}\n`, "utf-8");
	return filePath;
}

/**
 * Load the full DAG detail for a run by id. Returns null when the file is
 * missing (older runs that pre-date the lens, or historical runs from a
 * project where procedures were never run with this lens active).
 */
export function loadProcedureRunSnapshot(
	cwd: string,
	runId: string,
): ProcedureRunDetail | null {
	const paths = resolveProceduresObservatoryPaths(cwd);
	const filePath = path.join(paths.lensDir, RUNS_SUBDIR, `${runId}.json`);
	if (!existsSync(filePath)) return null;
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		// Trust the shape — we wrote it ourselves.
		return parsed as ProcedureRunDetail;
	} catch {
		return null;
	}
}

/**
 * Best-effort cleanup. Procedure runs are append-only history by design — the
 * executor never calls this. Provided for symmetry with `room/observatory.ts`
 * and for a future `/observatory clear procedures` operation.
 */
export function clearProceduresObservatoryLens(cwd: string): void {
	let paths: ResolvedObservatoryPaths;
	try {
		paths = resolveProceduresObservatoryPaths(cwd);
	} catch {
		return;
	}
	if (existsSync(paths.lensDir)) {
		try {
			rmSync(paths.lensDir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
}
