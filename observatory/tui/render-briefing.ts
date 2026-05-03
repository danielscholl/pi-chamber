import type { LensManifest } from "../core.ts";
import { isSectionedShape, parseBriefingPage } from "../page.ts";
import { renderBriefingPage } from "./render-briefing-page.ts";
import { type Colorize, noColorize } from "./widgets/types.ts";
import { card } from "./widgets/card.ts";
import { detailsBody } from "./widgets/details-body.ts";
import { grid } from "./widgets/grid.ts";
import { truncateToWidth } from "./widgets/text.ts";

export interface BriefingRow {
	key: string;
	value: string;
	tier: "string" | "number" | "boolean" | "null" | "json";
}

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
	manifest?: Pick<LensManifest, "name" | "kind">,
): string[] {
	const w = Math.max(20, width);
	if (manifest && isSectionedShape(data)) {
		const { page } = parseBriefingPage(data);
		return renderBriefingPage({ manifest, page, width: w, colorize });
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return [truncateToWidth("(empty briefing — data should be a flat object)", w)];
	}
	const rows = normalizeBriefing(data);
	if (!rows.length) {
		return [truncateToWidth("(briefing has no fields yet)", w)];
	}
	// Default: card grid. Truncates long values but reads at a glance.
	// Expanded (`e`): wrapped key/value rows so authors can inspect the full
	// content of long string or stringified-JSON fields.
	if (expandValues) {
		return detailsBody({
			rows: rows.map((r) => ({ label: r.key, value: r.value })),
			width: w,
			colorize,
			expandValues: true,
		});
	}
	return renderAsCards(rows, w, colorize);
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
