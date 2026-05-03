import type { LensManifest } from "../core.ts";
import type { BriefingPage, ListSection } from "../page.ts";
import { statusTier } from "./status.ts";
import { detailsBody } from "./widgets/details-body.ts";
import { inlineList } from "./widgets/inline-list.ts";
import { linesBody } from "./widgets/lines-body.ts";
import { metricsBody } from "./widgets/metrics-body.ts";
import { narrativeBody } from "./widgets/narrative-body.ts";
import { priorityCard } from "./widgets/priority-card.ts";
import { sectionHeader } from "./widgets/section.ts";
import { tierColorKey } from "./widgets/status-pill.ts";
import { padToWidth, truncateToWidth } from "./widgets/text.ts";
import { type Colorize, noColorize } from "./widgets/types.ts";

// Sectioned-briefing page renderer.
//
// Pure: takes a parsed BriefingPage plus the manifest (for header chrome) and
// returns the body lines, every line padded to exactly `width`. Section order
// is fixed: priority → metrics → activity → lists → narrative → details.
export interface BriefingPageRenderInput {
	manifest: Pick<LensManifest, "name" | "kind">;
	page: BriefingPage;
	width: number;
	colorize?: Colorize;
}

export function renderBriefingPage(input: BriefingPageRenderInput): string[] {
	const { manifest, page, width, colorize = noColorize } = input;
	const w = Math.max(20, width);
	const lines: string[] = [];

	lines.push(...pageHeader(manifest, page, w, colorize));

	if (page.priority) {
		lines.push(padToWidth("", w));
		lines.push(
			...priorityCard({
				title: page.priority.title,
				body: page.priority.body,
				severity: page.priority.severity,
				width: w,
				colorize,
			}),
		);
	}

	if (page.metrics && page.metrics.length > 0) {
		lines.push(padToWidth("", w));
		lines.push(...sectionHeader({ label: "Metrics", width: w, colorize }));
		lines.push(...metricsBody({ metrics: page.metrics, width: w, colorize }));
	}

	if (page.activity && page.activity.length > 0) {
		lines.push(padToWidth("", w));
		lines.push(
			...sectionHeader({ label: "Recent Changes", width: w, colorize }),
		);
		lines.push(
			...linesBody({
				items: page.activity,
				width: w,
				style: "numbered",
				colorize,
			}),
		);
	}

	if (page.lists && page.lists.length > 0) {
		for (const section of page.lists) {
			lines.push(padToWidth("", w));
			lines.push(
				...sectionHeader({ label: section.title, width: w, colorize }),
			);
			lines.push(...renderListBody(section, w, colorize));
		}
	}

	if (page.narrative && page.narrative.length > 0) {
		lines.push(padToWidth("", w));
		lines.push(...sectionHeader({ label: "Narrative", width: w, colorize }));
		lines.push(
			...narrativeBody({ items: page.narrative, width: w, colorize }),
		);
	}

	if (page.details && page.details.length > 0) {
		lines.push(padToWidth("", w));
		lines.push(...sectionHeader({ label: "Details", width: w, colorize }));
		lines.push(
			...detailsBody({
				rows: page.details,
				width: w,
				colorize,
				expandValues: true,
			}),
		);
	}

	return lines;
}

function pageHeader(
	manifest: Pick<LensManifest, "name" | "kind">,
	page: BriefingPage,
	width: number,
	colorize: Colorize,
): string[] {
	const lines: string[] = [];
	const sepDim = colorize("dim", " · ");

	// Line 1: name · kind
	const name = colorize("accent", truncateToWidth(manifest.name, width));
	const kind = colorize("dim", manifest.kind);
	lines.push(padToWidth(`${name}${sepDim}${kind}`, width));

	// Line 2: summary · status: <tier>
	const piecesColored: string[] = [];
	if (page.summary) {
		piecesColored.push(colorize("dim", page.summary));
	}
	if (page.status) {
		const tier = statusTier(page.status);
		const colorKey = tierColorKey(tier);
		const label = colorize("dim", "status:");
		const value = colorize(colorKey, page.status);
		piecesColored.push(`${label} ${value}`);
	}
	if (piecesColored.length > 0) {
		lines.push(padToWidth(piecesColored.join(sepDim), width));
	}
	return lines;
}

function renderListBody(
	section: ListSection,
	width: number,
	colorize: Colorize,
): string[] {
	if (section.style === "inline") {
		return inlineList({ items: section.items, width, colorize });
	}
	return linesBody({
		items: section.items,
		width,
		style: "bullet",
		colorize,
	});
}
