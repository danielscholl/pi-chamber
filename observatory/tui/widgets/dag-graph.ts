/**
 * dagGraph — vertical layered ASCII renderer for a procedure run's DAG.
 *
 * Input is the topological-layer view already produced by
 * `procedures/graph.ts:buildTopologicalLayers`. We don't redo layout — we
 * only project layers + edges into a grid of boxes connected by ASCII rules.
 *
 * Layout model
 * ────────────
 * Each layer is a row group of fixed-height boxes (3 rows: top border, label
 * row, bottom border) placed left-to-right with a fixed column gap. Between
 * consecutive layers we emit a connector strip (3 rows: parent-down vertical,
 * bus row, child-down vertical) drawn with ┌ ┐ ┴ ┬ ┘ └ ─ │ glyphs. Crossings
 * (rare in procedure-shaped DAGs) are accepted; we don't optimize them away.
 *
 * Wide-layer fallback
 * ───────────────────
 * If a layer would exceed `width`, its boxes wrap onto multiple sub-rows.
 * Cross-row edges from this layer's parents into the next layer are drawn
 * from the LAST sub-row only, since wrapping is purely a layout concession
 * and doesn't change the underlying topology.
 *
 * Pure: no I/O, no globals, deterministic. Every visible character is
 * produced by this function — callers are responsible for color via the
 * supplied `colorize`.
 */

import { type StatusTier, tierGlyph } from "../status.ts";
import type { Colorize } from "./types.ts";
import { noColorize } from "./types.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "./text.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DagNodeStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped";

export interface DagGraphNodeView {
	label: string;
	status: DagNodeStatus;
	/** Optional inline badge (e.g. compact token count or kind glyph). */
	badge?: string;
}

export interface DagGraphInput {
	/** Node ids grouped by layer (output of buildTopologicalLayers, mapped to ids). */
	layers: string[][];
	nodes: Record<string, DagGraphNodeView>;
	edges: Array<{ from: string; to: string }>;
	/** Available column width — boxes shrink and layers wrap to fit. */
	width: number;
	/** Currently-focused node id; rendered with inverted background. */
	selectedId?: string;
	colorize?: Colorize;
}

// ---------------------------------------------------------------------------
// Box-layout constants
// ---------------------------------------------------------------------------

/** Inner-width minimum for a node box (label + pill + spaces). */
const MIN_BOX_INNER = 10;
/** Inner-width maximum — keeps long ids from blowing the layer width. */
const MAX_BOX_INNER = 24;
/** Spaces between boxes in the same sub-row. */
const COL_GAP = 3;

// ---------------------------------------------------------------------------
// dagGraph
// ---------------------------------------------------------------------------

export function dagGraph(input: DagGraphInput): string[] {
	const { layers, nodes, edges, width, selectedId, colorize = noColorize } = input;
	if (layers.length === 0) return [];

	const boxInner = pickBoxInnerWidth(layers, nodes, width);
	const boxOuter = boxInner + 2;
	const maxColsPerSubRow = Math.max(1, Math.floor((width + COL_GAP) / (boxOuter + COL_GAP)));

	// Wrap each layer into sub-rows if it doesn't fit width.
	const wrappedLayers: string[][][] = layers.map((layer) =>
		chunk(layer, maxColsPerSubRow),
	);

	const rendered: string[] = [];
	for (let i = 0; i < wrappedLayers.length; i++) {
		const subRows = wrappedLayers[i];
		// Layer body: 3 rows per sub-row (top / label / bottom). Multi-sub-row
		// layers stack vertically with an empty separator row between.
		for (let sr = 0; sr < subRows.length; sr++) {
			if (sr > 0) rendered.push(""); // visual breath between wrap rows
			const subRowIds = subRows[sr];
			const layerLines = renderLayerSubRow(
				subRowIds,
				nodes,
				boxInner,
				selectedId,
				colorize,
			);
			rendered.push(...layerLines);
		}

		// Connector strip into the next layer.
		if (i < wrappedLayers.length - 1) {
			const lastSubRowOfThisLayer = subRows[subRows.length - 1];
			const firstSubRowOfNextLayer = wrappedLayers[i + 1][0];
			rendered.push(
				...renderConnectorStrip(
					lastSubRowOfThisLayer,
					firstSubRowOfNextLayer,
					edges,
					boxInner,
					colorize,
				),
			);
		}
	}

	return rendered;
}

// ---------------------------------------------------------------------------
// Layer rendering
// ---------------------------------------------------------------------------

function renderLayerSubRow(
	ids: string[],
	nodes: Record<string, DagGraphNodeView>,
	boxInner: number,
	selectedId: string | undefined,
	colorize: Colorize,
): string[] {
	const rows: [string, string, string][] = ids.map((id) => {
		const view = nodes[id] ?? { label: id, status: "pending" as DagNodeStatus };
		return renderNodeBox(view, boxInner, id === selectedId, colorize);
	});

	const top = joinSubRow(rows.map((r) => r[0]));
	const mid = joinSubRow(rows.map((r) => r[1]));
	const bot = joinSubRow(rows.map((r) => r[2]));
	return [top, mid, bot];
}

function joinSubRow(parts: string[]): string {
	return parts.join(" ".repeat(COL_GAP));
}

function renderNodeBox(
	view: DagGraphNodeView,
	boxInner: number,
	selected: boolean,
	colorize: Colorize,
): [string, string, string] {
	const tier = mapStatusToTier(view.status);
	const top = `┌${"─".repeat(boxInner)}┐`;
	const bot = `└${"─".repeat(boxInner)}┘`;
	const labelLine = renderLabelLine(view, boxInner, tier);
	const colorizedLabel = selected ? colorize("selectedBg", labelLine) : labelLine;
	return [top, `│${colorizedLabel}│`, bot];
}

/**
 * Compose the label row's CONTENT (no borders). Returns a string of exactly
 * `boxInner` visible columns: ` <glyph> <label-truncated> [<badge>] `.
 */
function renderLabelLine(
	view: DagGraphNodeView,
	boxInner: number,
	tier: StatusTier,
): string {
	const glyph = tierGlyph(tier);
	const badge = view.badge ? ` ${view.badge}` : "";
	// Reserved: 1 leading space + glyph (1) + 1 space + badge tail + 1 trailing space.
	const reserved = 1 + 1 + 1 + visibleWidth(badge) + 1;
	const labelBudget = Math.max(0, boxInner - reserved);
	const label = truncateToWidth(view.label, labelBudget);
	const inner = ` ${glyph} ${label}${badge} `;
	return padToWidth(inner, boxInner);
}

function mapStatusToTier(status: DagNodeStatus): StatusTier {
	switch (status) {
		case "completed":
			return "ok";
		case "running":
			return "warn";
		case "failed":
			return "err";
		case "pending":
		case "skipped":
			return "idle";
	}
}

// ---------------------------------------------------------------------------
// Box-width selection
// ---------------------------------------------------------------------------

function pickBoxInnerWidth(
	layers: string[][],
	nodes: Record<string, DagGraphNodeView>,
	width: number,
): number {
	let longestLabel = 0;
	let longestBadge = 0;
	for (const layer of layers) {
		for (const id of layer) {
			const view = nodes[id];
			if (!view) continue;
			longestLabel = Math.max(longestLabel, visibleWidth(view.label));
			if (view.badge) longestBadge = Math.max(longestBadge, visibleWidth(view.badge));
		}
	}
	// Reserved for ` <glyph> <label> <badge> `.
	const desired = Math.max(MIN_BOX_INNER, 1 + 1 + 1 + longestLabel + (longestBadge ? 1 + longestBadge : 0) + 1);
	const widestLayer = Math.max(...layers.map((l) => l.length), 1);
	const fit = Math.floor((width + COL_GAP - widestLayer * COL_GAP) / widestLayer) - 2;
	return clamp(Math.min(desired, MAX_BOX_INNER), MIN_BOX_INNER, Math.max(MIN_BOX_INNER, fit));
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

function chunk<T>(arr: T[], size: number): T[][] {
	if (size <= 0) return [arr.slice()];
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

// ---------------------------------------------------------------------------
// Connector strip
// ---------------------------------------------------------------------------

/**
 * Draw the 3-row connector between two horizontally-adjacent sub-rows. We
 * compute each box's anchor column (its mid-x) and then:
 *   row A: `│` under every parent that has a child in the next sub-row
 *   row B: a horizontal bus from min(anchor) to max(anchor), with `┴` at
 *          parent anchors and `┬` at child anchors; `┼` if both
 *   row C: `│` above every child that has a parent in this sub-row
 * Anchor column is computed against the COMBINED width so both rows align in
 * the rendered output.
 */
function renderConnectorStrip(
	parents: string[],
	children: string[],
	edges: Array<{ from: string; to: string }>,
	boxInner: number,
	_colorize: Colorize,
): string[] {
	const boxOuter = boxInner + 2;
	const stride = boxOuter + COL_GAP;
	const parentAnchorByID = new Map<string, number>();
	const childAnchorByID = new Map<string, number>();
	const halfBox = Math.floor(boxOuter / 2);
	for (let i = 0; i < parents.length; i++) {
		parentAnchorByID.set(parents[i], i * stride + halfBox);
	}
	for (let i = 0; i < children.length; i++) {
		childAnchorByID.set(children[i], i * stride + halfBox);
	}

	// Filter edges to ones that connect this parent sub-row to this child sub-row.
	const liveEdges = edges.filter(
		(e) => parentAnchorByID.has(e.from) && childAnchorByID.has(e.to),
	);
	if (liveEdges.length === 0) {
		// No edges crossing this seam (rare — usually means the next layer has
		// no incoming edges from this layer's last sub-row). Render a blank
		// line so the layers don't visually fuse.
		return [""];
	}

	const activeParents = new Set(liveEdges.map((e) => e.from));
	const activeChildren = new Set(liveEdges.map((e) => e.to));
	const parentCols = new Set<number>();
	const childCols = new Set<number>();
	for (const p of activeParents) parentCols.add(parentAnchorByID.get(p) ?? 0);
	for (const c of activeChildren) childCols.add(childAnchorByID.get(c) ?? 0);
	const allAnchors = [...parentCols, ...childCols];
	const minCol = Math.min(...allAnchors);
	const maxCol = Math.max(...allAnchors);
	const totalWidth = Math.max(
		parents.length * stride - COL_GAP,
		children.length * stride - COL_GAP,
		maxCol + 1,
	);

	// Special case: a single edge whose parent + child anchors align — collapse
	// to a single `│` row so linear chains look clean.
	if (liveEdges.length === 1 && minCol === maxCol) {
		return [drawAt(totalWidth, [{ col: minCol, glyph: "│" }])];
	}

	// Row A: parent-down `│` at every active parent's anchor.
	const rowA = drawAt(
		totalWidth,
		[...parentCols].map((col) => ({ col, glyph: "│" })),
	);

	// Row B: horizontal bus from minCol..maxCol with corner glyphs at anchors.
	const busChars = new Array(totalWidth).fill(" ");
	for (let c = minCol; c <= maxCol; c++) busChars[c] = "─";
	const cols = new Set<number>([...parentCols, ...childCols]);
	for (const col of cols) {
		const isP = parentCols.has(col);
		const isC = childCols.has(col);
		if (isP && isC) busChars[col] = stackedCorner(col, minCol, maxCol);
		else if (isP) busChars[col] = cornerForParent(col, minCol, maxCol);
		else busChars[col] = cornerForChild(col, minCol, maxCol);
	}
	const rowB = busChars.join("");

	// Row C: child-down `│` above every active child's anchor.
	const rowC = drawAt(
		totalWidth,
		[...childCols].map((col) => ({ col, glyph: "│" })),
	);

	return [rowA, rowB, rowC];
}

/** Return a string of width `width` with the named glyphs at their cols. */
function drawAt(
	width: number,
	marks: Array<{ col: number; glyph: string }>,
): string {
	const chars = new Array(width).fill(" ");
	for (const { col, glyph } of marks) {
		if (col >= 0 && col < width) chars[col] = glyph;
	}
	return chars.join("");
}

function cornerForParent(col: number, minCol: number, maxCol: number): string {
	if (col === minCol && minCol === maxCol) return "│";
	if (col === minCol) return "└";
	if (col === maxCol) return "┘";
	return "┴";
}

function cornerForChild(col: number, minCol: number, maxCol: number): string {
	if (col === minCol && minCol === maxCol) return "│";
	if (col === minCol) return "┌";
	if (col === maxCol) return "┐";
	return "┬";
}

/**
 * Glyph for a column that has BOTH a parent above and a child below. The bus
 * extends sideways depending on whether this column is at the bus boundary.
 */
function stackedCorner(col: number, minCol: number, maxCol: number): string {
	if (col === minCol && col === maxCol) return "│"; // bus is just this column
	if (col === minCol) return "├"; // bus extends right only
	if (col === maxCol) return "┤"; // bus extends left only
	return "┼"; // bus on both sides
}

// ---------------------------------------------------------------------------
// Known limitations (worth knowing — fast-follow polish)
// ---------------------------------------------------------------------------
//
// 1. Wrap-row edges. When a layer wraps onto multiple sub-rows, only edges
//    from the LAST sub-row into the next layer are drawn. Edges from earlier
//    sub-rows (e.g. b→g, c→g, d→g, e→g when [b,c,d,e] is sub-row 1 of layer
//    L and [f] is sub-row 2 of layer L, with g in layer L+1) are silently
//    dropped from the visualization. The footnote-marker fallback noted in
//    the design doc is deferred — wide layers in real procedure workflows
//    are rare enough to leave as a known visual loss for v1.
//
// 2. Crossing edges. When two edges between non-adjacent layers cross, they
//    just overlap. We don't optimize ordering within a layer to minimize
//    crossings (that's a layered-graph-drawing dissertation). Accepted.

