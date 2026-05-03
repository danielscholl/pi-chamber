import type { NarrativeItem } from "../../page.ts";
import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, wrapTextWithAnsi } from "./text.ts";

// Narrative body: heading + wrapped paragraph for each item, blank line between.
//
//   Audience
//   First-time Pi operator who is technically comfortable but new to
//   the chamber.
//
//   Walkthrough
//   Pre-flight → /chamber picker → room mode warning → ...
export interface NarrativeBodyInput {
	items: NarrativeItem[];
	width: number;
	colorize?: Colorize;
}

export function narrativeBody(input: NarrativeBodyInput): string[] {
	const { items, width, colorize = noColorize } = input;
	const w = Math.max(8, width);
	if (items.length === 0) return [];
	const lines: string[] = [];
	for (let i = 0; i < items.length; i++) {
		if (i > 0) lines.push(padToWidth("", w));
		const heading = colorize("accent", items[i].heading);
		lines.push(padToWidth(heading, w));
		const wrapped = wrapTextWithAnsi(items[i].body, w);
		for (const ln of wrapped) {
			lines.push(padToWidth(ln, w));
		}
	}
	return lines;
}
