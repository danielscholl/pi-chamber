import { type Colorize, noColorize } from "./widgets/types.ts";
import { card } from "./widgets/card.ts";
import { grid } from "./widgets/grid.ts";
import { truncateToWidth } from "./widgets/text.ts";

export interface BriefingRow {
	key: string;
	value: string;
	tier: "string" | "number" | "boolean" | "null" | "json";
}

// Below this width, fall back to the legacy single-line key/value layout.
// Cards need at least ~22 visible cols to read well.
const WIDE_THRESHOLD = 44;

const TIER_EMOJI: Record<BriefingRow["tier"], string> = {
	number: "#",
	boolean: "✓",
	string: "·",
	null: "—",
	json: "{}",
};

export function normalizeBriefing(data: unknown): BriefingRow[] {
	if (!data || typeof data !== "object" || Array.isArray(data)) return [];
	const rows: BriefingRow[] = [];
	for (const key of Object.keys(data)) {
		const value = (data as Record<string, unknown>)[key];
		const label = key.replace(/_/g, " ");
		if (typeof value === "number") {
			rows.push({ key: label, value: String(value), tier: "number" });
		} else if (typeof value === "boolean") {
			rows.push({ key: label, value: String(value), tier: "boolean" });
		} else if (typeof value === "string") {
			rows.push({ key: label, value, tier: "string" });
		} else if (value === null || value === undefined) {
			rows.push({ key: label, value: "—", tier: "null" });
		} else {
			rows.push({ key: label, value: JSON.stringify(value), tier: "json" });
		}
	}
	return rows;
}

export function renderBriefing(
	data: unknown,
	width: number,
	expandValues = false,
	colorize: Colorize = noColorize,
): string[] {
	const w = Math.max(20, width);
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return [truncateToWidth("(empty briefing — data should be a flat object)", w)];
	}
	const rows = normalizeBriefing(data);
	if (!rows.length) {
		return [truncateToWidth("(briefing has no fields yet)", w)];
	}

	if (w >= WIDE_THRESHOLD) {
		return renderAsCards(rows, w, colorize);
	}
	return renderAsKvRows(rows, w, expandValues);
}

function renderAsCards(
	rows: BriefingRow[],
	width: number,
	colorize: Colorize,
): string[] {
	const cells = rows.map((row) => (colWidth: number) =>
		card({
			label: row.key,
			value: row.value,
			width: colWidth,
			emoji: TIER_EMOJI[row.tier],
			emphasizeValue: row.tier === "number",
			colorize,
		}),
	);
	return grid({ cells, width, minColWidth: 22, gap: 2 });
}

// ---- legacy narrow-mode kv-row layout ----------------------------------

function renderAsKvRows(
	rows: BriefingRow[],
	width: number,
	expandValues: boolean,
): string[] {
	const labelWidth = computeLabelWidth(rows, width);
	const gap = 2;
	const valueWidth = Math.max(8, width - labelWidth - gap);

	const lines: string[] = [];
	for (const row of rows) {
		const label = padRight(row.key, labelWidth);
		const valueLines = layoutValue(row.value, valueWidth, expandValues);
		if (valueLines.length === 0) {
			lines.push(truncatePlain(label, width));
			continue;
		}
		lines.push(truncatePlain(`${label}${" ".repeat(gap)}${valueLines[0]}`, width));
		for (let i = 1; i < valueLines.length; i++) {
			const indent = " ".repeat(labelWidth + gap);
			lines.push(truncatePlain(`${indent}${valueLines[i]}`, width));
		}
	}
	return lines;
}

function computeLabelWidth(rows: BriefingRow[], width: number): number {
	const maxLabel = rows.reduce((m, r) => Math.max(m, r.key.length), 0);
	const cap = Math.min(28, Math.max(8, Math.floor(width * 0.35)));
	return Math.min(cap, maxLabel);
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	return text + " ".repeat(width - text.length);
}

// Plain (no-ANSI) truncation so the narrow kv-row tests can keep asserting
// `.length <= width` without false positives from ellipsis-related ANSI.
function truncatePlain(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

function layoutValue(
	value: string,
	width: number,
	expand: boolean,
): string[] {
	if (value === "") return [""];
	if (!expand) {
		return [value.length <= width ? value : truncatePlain(value, width)];
	}
	return wrapToWidth(value, width);
}

function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of paragraph.split(/(\s+)/)) {
			if (word === "") continue;
			if (line.length + word.length <= width) {
				line += word;
			} else if (word.length > width) {
				if (line.length > 0) {
					out.push(line);
					line = "";
				}
				let remaining = word;
				while (remaining.length > width) {
					out.push(remaining.slice(0, width));
					remaining = remaining.slice(width);
				}
				line = remaining;
			} else {
				out.push(line.trimEnd());
				line = /\s/.test(word) ? "" : word;
			}
		}
		if (line.length > 0) out.push(line.trimEnd());
	}
	return out;
}
