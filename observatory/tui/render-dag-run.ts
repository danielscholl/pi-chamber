/**
 * render-dag-run — renderer for the `dag-run` lens kind (procedures).
 *
 * Dispatches based on the body-local drill stack:
 *   []                                  → run history list (selectable rows)
 *   [{ kind:"run", id }]                → run-detail page (header + dagGraph)
 *   [{ kind:"run", id }, { kind:"node", id }] → node-detail page (KV + output)
 *
 * The drill stack itself is owned by `state.ts`; this renderer is pure. To
 * keep the per-feature isolation rule (AGENTS.md), this module duplicates
 * the procedure-shaped DTO types (ProcedureRunSummary etc.) locally rather
 * than importing from `procedures/`. They're JSON over disk so the
 * structural copy is the contract.
 */

import type { BodyDrillFrame, BodyNavState } from "./state.ts";
import { dagGraph, type DagGraphNodeView, type DagNodeStatus } from "./widgets/dag-graph.ts";
import { detailsBody } from "./widgets/details-body.ts";
import { linesBody } from "./widgets/lines-body.ts";
import { panel } from "./widgets/panel.ts";
import { type Colorize, noColorize } from "./widgets/types.ts";
import { padToWidth } from "./widgets/text.ts";

// ---------------------------------------------------------------------------
// Shape DTOs (mirror procedures/observatory.ts; JSON-on-disk is the contract)
// ---------------------------------------------------------------------------

export interface ProcedureNodeUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface ProcedureNodeView {
	id: string;
	kind: string;
	status: DagNodeStatus;
	dependsOn: string[];
	dependents: string[];
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	sessionId?: string;
	error?: string;
	output?: string;
	usage?: ProcedureNodeUsage;
}

export interface ProcedureRunDetail {
	runId: string;
	workflowName: string;
	status: string;
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	layers: string[][];
	nodes: Record<string, ProcedureNodeView>;
	totalTokens?: number;
	totalCostUsd?: number;
}

export interface ProcedureRunSummary {
	runId: string;
	workflowName: string;
	status: string;
	startedAt: string;
	completedAt?: string | null;
	durationMs?: number;
	nodeCount?: number;
	failedCount?: number;
	totalTokens?: number;
	totalCostUsd?: number;
	workingPath?: string | null;
}

export interface DagRunLensData {
	generatedAt: string;
	runs: ProcedureRunSummary[];
	current: ProcedureRunDetail | null;
}

// ---------------------------------------------------------------------------
// Renderer entry
// ---------------------------------------------------------------------------

export interface RenderDagRunInput {
	/** Lens data.json contents (history + current). */
	data: unknown;
	/**
	 * Pre-loaded run detail when drillStack[0] points to a non-current run.
	 * Component does the disk I/O so this renderer stays pure.
	 */
	drilledRunDetail?: ProcedureRunDetail | null;
	drillStack: BodyDrillFrame[];
	bodySelectedIndex: number;
	width: number;
	colorize?: Colorize;
}

export interface RenderDagRunResult {
	bodyLines: string[];
	bodyNav: BodyNavState;
}

export function renderDagRun(input: RenderDagRunInput): RenderDagRunResult {
	const data = parseDagRunData(input.data);
	const colorize = input.colorize ?? noColorize;
	const width = Math.max(20, input.width);

	if (!data) {
		return {
			bodyLines: ["(procedures lens has no data yet — run a procedure with /procedures run)"],
			bodyNav: { kind: "none" },
		};
	}

	const top = input.drillStack[0];
	if (!top) {
		return renderHistoryList(data, width, input.bodySelectedIndex, colorize);
	}
	const runDetail = resolveRunDetail(top.id, data, input.drilledRunDetail ?? null);
	if (!runDetail) {
		return {
			bodyLines: [
				`Run ${top.id} is older than the lens cache.`,
				"",
				"Drill-down for runs that pre-date the procedures lens lands later;",
				"for now use:  /procedures status <runId>",
			],
			bodyNav: { kind: "none" },
		};
	}
	const second = input.drillStack[1];
	if (!second) {
		return renderRunDetail(runDetail, width, input.bodySelectedIndex, colorize);
	}
	return renderNodeDetail(runDetail, second.id, width, colorize);
}

// ---------------------------------------------------------------------------
// History list (drill stack empty)
// ---------------------------------------------------------------------------

function renderHistoryList(
	data: DagRunLensData,
	width: number,
	selectedIndex: number,
	colorize: Colorize,
): RenderDagRunResult {
	if (data.runs.length === 0) {
		return {
			bodyLines: ["No procedure runs yet.", "", "Run one with:  /procedures run <name>"],
			bodyNav: { kind: "none" },
		};
	}
	const lines: string[] = [];
	const headerLeft = `${data.runs.length} run${data.runs.length === 1 ? "" : "s"}`;
	const headerRight = "j/k navigate · enter open · q quit";
	lines.push(padHeader(headerLeft, headerRight, width, colorize));
	lines.push("");
	for (let i = 0; i < data.runs.length; i++) {
		const run = data.runs[i];
		const row = formatRunSummaryRow(run);
		const isSelected = i === selectedIndex;
		lines.push(isSelected ? colorize("selectedBg", padToWidth(`▶ ${row}`, width)) : `  ${row}`);
	}
	return {
		bodyLines: lines,
		bodyNav: {
			kind: "list",
			ids: data.runs.map((r) => r.runId),
			pushKind: "run",
		},
	};
}

function formatRunSummaryRow(run: ProcedureRunSummary): string {
	const glyph = glyphForStatus(run.status);
	const duration = run.durationMs !== undefined ? `${(run.durationMs / 1000).toFixed(1)}s` : "—";
	const tokens =
		run.totalTokens !== undefined && run.totalTokens > 0
			? ` · ${formatTokens(run.totalTokens)} tok`
			: "";
	const cost =
		run.totalCostUsd !== undefined && run.totalCostUsd > 0
			? ` · $${run.totalCostUsd.toFixed(3)}`
			: "";
	const failed = run.failedCount && run.failedCount > 0 ? ` · ${run.failedCount} failed` : "";
	return `${glyph} ${run.workflowName.padEnd(20)} ${duration.padStart(7)}${tokens}${cost}${failed}`;
}

// ---------------------------------------------------------------------------
// Run detail (drill stack: [run])
// ---------------------------------------------------------------------------

function renderRunDetail(
	run: ProcedureRunDetail,
	width: number,
	selectedIndex: number,
	colorize: Colorize,
): RenderDagRunResult {
	const ids = topologicalOrder(run);
	const selectedId = ids[Math.min(selectedIndex, ids.length - 1)];

	const headerTitle = `${run.workflowName} · ${run.runId}`;
	const headerStatus = `status: ${run.status}${run.durationMs !== undefined ? `  ·  ${(run.durationMs / 1000).toFixed(1)}s` : ""}`;
	const totalsLine = formatTotalsLine(run);

	const summaryRows = [
		{ label: "started", value: run.startedAt },
		{ label: "completed", value: run.completedAt ?? "—" },
		{
			label: "duration",
			value: run.durationMs !== undefined ? `${run.durationMs} ms` : "—",
		},
		{ label: "nodes", value: `${ids.length}` },
	];
	const summaryLines = detailsBody({ rows: summaryRows, width: width - 4, colorize });

	const summaryPanel = panel({
		title: headerTitle,
		body: [headerStatus, ...(totalsLine ? [totalsLine] : []), "", ...summaryLines],
		width,
		colorize,
	});

	const dagInput = {
		layers: run.layers,
		nodes: nodesToGraphView(run),
		edges: edgesFromRun(run),
		width,
		selectedId,
		colorize,
	};
	const dagLines = dagGraph(dagInput);

	const footer = [
		"",
		colorize("dim", "j/k navigate nodes · enter open · esc back"),
	];

	return {
		bodyLines: [...summaryPanel, "", ...dagLines, ...footer],
		bodyNav: { kind: "list", ids, pushKind: "node" },
	};
}

function formatTotalsLine(run: ProcedureRunDetail): string {
	const parts: string[] = [];
	if (run.totalTokens !== undefined && run.totalTokens > 0) {
		parts.push(`${formatTokens(run.totalTokens)} tokens`);
	}
	if (run.totalCostUsd !== undefined && run.totalCostUsd > 0) {
		parts.push(`$${run.totalCostUsd.toFixed(4)}`);
	}
	return parts.length > 0 ? `cost: ${parts.join(" · ")}` : "";
}

// ---------------------------------------------------------------------------
// Node detail (drill stack: [run, node])
// ---------------------------------------------------------------------------

function renderNodeDetail(
	run: ProcedureRunDetail,
	nodeId: string,
	width: number,
	colorize: Colorize,
): RenderDagRunResult {
	const node = run.nodes[nodeId];
	if (!node) {
		return {
			bodyLines: [`Node ${nodeId} not found in run ${run.runId}.`],
			bodyNav: { kind: "none" },
		};
	}

	const headerTitle = `${node.id} · ${node.kind} · ${node.status}`;
	const rows: Array<{ label: string; value: string }> = [
		{ label: "kind", value: node.kind },
		{ label: "status", value: node.status },
		{ label: "depends on", value: node.dependsOn.length > 0 ? node.dependsOn.join(", ") : "—" },
		{ label: "dependents", value: node.dependents.length > 0 ? node.dependents.join(", ") : "—" },
	];
	if (node.startedAt) rows.push({ label: "started", value: node.startedAt });
	if (node.completedAt) rows.push({ label: "completed", value: node.completedAt });
	if (node.durationMs !== undefined) rows.push({ label: "duration", value: `${node.durationMs} ms` });
	if (node.usage) {
		const u = node.usage;
		const tokens = `in ${u.input ?? 0} · out ${u.output ?? 0}${u.cacheRead ? ` · cacheR ${u.cacheRead}` : ""}${u.cacheWrite ? ` · cacheW ${u.cacheWrite}` : ""} · total ${u.totalTokens ?? 0}`;
		rows.push({ label: "tokens", value: tokens });
		if (u.costUsd !== undefined && u.costUsd > 0) {
			rows.push({ label: "cost", value: `$${u.costUsd.toFixed(6)}` });
		}
	}
	if (node.sessionId) rows.push({ label: "session", value: node.sessionId });
	if (node.error) rows.push({ label: "error", value: node.error });

	const detailLines = detailsBody({ rows, width: width - 4, colorize, expandValues: true });
	const detailPanel = panel({
		title: headerTitle,
		body: detailLines,
		width,
		colorize,
	});

	const lines: string[] = [...detailPanel];
	if (node.output && node.output.trim().length > 0) {
		const outputItems = node.output.split("\n").filter((l) => l.length > 0 || true);
		const outputPanel = panel({
			title: "output",
			body: linesBody({
				items: outputItems,
				width: width - 4,
				style: "numbered",
				colorize,
			}),
			width,
			colorize,
		});
		lines.push("", ...outputPanel);
	}
	lines.push("", colorize("dim", "esc back"));

	return { bodyLines: lines, bodyNav: { kind: "none" } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topologicalOrder(run: ProcedureRunDetail): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const layer of run.layers) {
		for (const id of layer) {
			if (!seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
		}
	}
	return out;
}

function nodesToGraphView(run: ProcedureRunDetail): Record<string, DagGraphNodeView> {
	const out: Record<string, DagGraphNodeView> = {};
	for (const id of Object.keys(run.nodes)) {
		const n = run.nodes[id];
		const badge = n.usage?.totalTokens && n.usage.totalTokens > 0
			? formatTokens(n.usage.totalTokens)
			: undefined;
		out[id] = {
			label: id,
			status: n.status,
			...(badge ? { badge } : {}),
		};
	}
	return out;
}

function edgesFromRun(run: ProcedureRunDetail): Array<{ from: string; to: string }> {
	const edges: Array<{ from: string; to: string }> = [];
	for (const id of Object.keys(run.nodes)) {
		for (const dep of run.nodes[id].dependsOn) {
			edges.push({ from: dep, to: id });
		}
	}
	return edges;
}

function resolveRunDetail(
	runId: string,
	data: DagRunLensData,
	drilledHistorical: ProcedureRunDetail | null,
): ProcedureRunDetail | null {
	if (data.current && data.current.runId === runId) return data.current;
	return drilledHistorical;
}

function padHeader(
	left: string,
	right: string,
	width: number,
	colorize: Colorize,
): string {
	const gap = Math.max(1, width - left.length - right.length);
	return `${left}${" ".repeat(gap)}${colorize("dim", right)}`;
}

function glyphForStatus(status: string): string {
	switch (status) {
		case "completed":
			return "✓";
		case "running":
			return "◐";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
		default:
			return "○";
	}
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseDagRunData(raw: unknown): DagRunLensData | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.runs)) return null;
	return {
		generatedAt: typeof obj.generatedAt === "string" ? obj.generatedAt : "",
		runs: obj.runs.filter(isRunRow),
		current: parseRunDetail(obj.current),
	};
}

function isRunRow(row: unknown): row is ProcedureRunSummary {
	if (!row || typeof row !== "object") return false;
	const r = row as Record<string, unknown>;
	return (
		typeof r.runId === "string" &&
		typeof r.workflowName === "string" &&
		typeof r.status === "string" &&
		typeof r.startedAt === "string"
	);
}

function parseRunDetail(raw: unknown): ProcedureRunDetail | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.runId !== "string" || typeof r.workflowName !== "string") return null;
	if (!Array.isArray(r.layers) || typeof r.nodes !== "object" || r.nodes === null) return null;
	// Trust the shape — we wrote it ourselves.
	return r as unknown as ProcedureRunDetail;
}
