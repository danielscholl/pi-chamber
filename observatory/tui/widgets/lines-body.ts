import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, truncateToWidth } from "./text.ts";

// Lines body: numbered or bulleted list of single-line items.
// Used for activity (numbered) and lists with style="bullet".
//
//   01  Genesis seeded jarvis newspaper lens
//   02  Activity panel now reports last write
//
//   • observatory tour
//   • mind direct chat
export interface LinesBodyInput {
	items: string[];
	width: number;
	style: "numbered" | "bullet";
	colorize?: Colorize;
}

const PREFIX_GAP = 2;

export function linesBody(input: LinesBodyInput): string[] {
	const { items, width, style, colorize = noColorize } = input;
	const w = Math.max(4, width);
	if (items.length === 0) return [];
	const numCols =
		style === "numbered" ? Math.max(2, String(items.length).length) : 1;
	const bodyOffset = numCols + PREFIX_GAP;
	const bodyWidth = Math.max(1, w - bodyOffset);
	const lines: string[] = [];
	for (let i = 0; i < items.length; i++) {
		const prefixRaw =
			style === "numbered" ? String(i + 1).padStart(numCols, "0") : "•";
		const prefix = colorize("dim", prefixRaw);
		const body = truncateToWidth(items[i], bodyWidth);
		const composed = `${prefix}${" ".repeat(PREFIX_GAP)}${body}`;
		lines.push(padToWidth(composed, w));
	}
	return lines;
}
