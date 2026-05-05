import type { DashboardActivity, DiscoveryEntry } from "../core.ts";
import { normalizeStatusBoard, statusTier, tierGlyph } from "./status.ts";
import { type Colorize, noColorize } from "./widgets/types.ts";
import { grid } from "./widgets/grid.ts";
import { panel } from "./widgets/panel.ts";

export type { DashboardActivity };

export interface DashboardData {
	entries: DiscoveryEntry[];
	roomData: unknown;
	proceduresData: unknown;
	minds: string[];
	activity: DashboardActivity | null;
	now: number;
}

export function renderDashboard(
	data: DashboardData,
	width: number,
	colorize: Colorize = noColorize,
): string[] {
	const w = Math.max(30, width);
	const cells = [
		(colWidth: number) =>
			panel({
				title: "Lenses",
				body: lensesPanel(data.entries),
				width: colWidth,
				colorize,
			}),
		(colWidth: number) =>
			panel({
				title: "Room",
				body: roomPanel(data.roomData),
				width: colWidth,
				colorize,
			}),
		(colWidth: number) =>
			panel({
				title: "Procedures",
				body: proceduresPanel(data.proceduresData, data.now),
				width: colWidth,
				colorize,
			}),
		(colWidth: number) =>
			panel({
				title: "Minds",
				// inner width = colWidth - 2 (left + right border).
				body: mindsPanel(data.minds, Math.max(10, colWidth - 2)),
				width: colWidth,
				colorize,
			}),
		(colWidth: number) =>
			panel({
				title: "Activity",
				body: activityPanel(data.activity, data.now),
				width: colWidth,
				colorize,
			}),
	];
	return grid({ cells, width: w, minColWidth: 22, gap: 2 });
}

function lensesPanel(entries: DiscoveryEntry[]): string[] {
	if (entries.length === 0) {
		return ["(none yet — ask a mind to author one)"];
	}
	let ok = 0;
	let invalid = 0;
	for (const e of entries) {
		if (e.status === "ok") ok++;
		else invalid++;
	}
	const summary =
		invalid === 0
			? `✓ ${ok} ok`
			: `✓ ${ok} ok · ⚠ ${invalid} invalid`;
	const lines = [summary];
	for (const entry of entries) {
		if (entry.status === "ok") {
			lines.push(`  ✓ ${entry.id} (${entry.manifest.kind})`);
		} else {
			lines.push(`  ⚠ ${entry.id} — ${entry.reason}`);
		}
	}
	return lines;
}

function roomPanel(data: unknown): string[] {
	const entries = normalizeStatusBoard(data);
	if (entries.length === 0) {
		return ["inactive (no live participants)"];
	}
	const lines: string[] = [];
	lines.push(`${entries.length} participant${entries.length === 1 ? "" : "s"}`);
	for (const e of entries.slice(0, 4)) {
		const tier = e.tier ?? statusTier(e.status);
		lines.push(`  ${tierGlyph(tier)} ${e.name} — ${e.status || "(no status)"}`);
	}
	if (entries.length > 4) {
		lines.push(`  … and ${entries.length - 4} more`);
	}
	return lines;
}

function mindsPanel(minds: string[], innerWidth: number): string[] {
	if (minds.length === 0) return ["(no Genesis minds in .pi/minds yet)"];
	const joined = minds.join(" · ");
	const fullLine = `${minds.length} available: ${joined}`;
	const inner = Math.max(10, innerWidth);
	if (fullLine.length <= inner) return [fullLine];
	// Wrap as a comma-separated list to fit the inner width.
	const lines: string[] = [`${minds.length} available:`];
	let line = "  ";
	for (let i = 0; i < minds.length; i++) {
		const piece = i === minds.length - 1 ? minds[i] : `${minds[i]} · `;
		if (line.length + piece.length > inner && line.trim().length > 0) {
			lines.push(line.trimEnd());
			line = "  ";
		}
		line += piece;
	}
	if (line.trim().length > 0) lines.push(line.trimEnd());
	return lines;
}

function activityPanel(
	activity: DashboardActivity | null,
	now: number,
): string[] {
	if (!activity) return ["No lens writes yet."];
	return [`Last write: ${formatRelativeTime(now - activity.mtimeMs)} (${activity.lensId})`];
}

interface ProceduresPanelRunRow {
	runId?: unknown;
	workflowName?: unknown;
	status?: unknown;
	startedAt?: unknown;
	durationMs?: unknown;
}

/**
 * Surface the most-recent 3 procedure runs from the procedures lens data.
 * Tolerates a missing or malformed payload — the lens may not exist yet.
 */
function proceduresPanel(data: unknown, now: number): string[] {
	const runs = extractProcedureRuns(data);
	if (runs.length === 0) {
		return ["(no runs yet — try /procedures run hello-world)"];
	}
	const lines: string[] = [];
	lines.push(`${runs.length} recent run${runs.length === 1 ? "" : "s"}`);
	for (const run of runs.slice(0, 3)) {
		const glyph = procStatusGlyph(typeof run.status === "string" ? run.status : "");
		const name =
			typeof run.workflowName === "string" ? run.workflowName : "(unknown)";
		const ageMs =
			typeof run.startedAt === "string"
				? Math.max(0, now - new Date(run.startedAt).getTime())
				: null;
		const age = ageMs !== null ? formatRelativeTime(ageMs) : "—";
		const durationLabel =
			typeof run.durationMs === "number"
				? `${(run.durationMs / 1000).toFixed(1)}s`
				: "";
		lines.push(`  ${glyph} ${name} · ${age}${durationLabel ? ` · ${durationLabel}` : ""}`);
	}
	return lines;
}

function extractProcedureRuns(data: unknown): ProceduresPanelRunRow[] {
	if (!data || typeof data !== "object") return [];
	const obj = data as { runs?: unknown };
	if (!Array.isArray(obj.runs)) return [];
	return obj.runs.filter(
		(r): r is ProceduresPanelRunRow => r !== null && typeof r === "object",
	);
}

function procStatusGlyph(status: string): string {
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

export function formatRelativeTime(deltaMs: number): string {
	if (deltaMs < 0) deltaMs = 0;
	const sec = Math.floor(deltaMs / 1000);
	if (sec < 5) return "just now";
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	return `${day}d ago`;
}
