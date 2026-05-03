import { type Colorize, noColorize } from "./types.ts";
import { padToWidth } from "./text.ts";

// Inline list: dot-separated single-line list, wraps at width.
//
//   observatory · agents · tooling · docs
//   release-engineering · qa
export interface InlineListInput {
	items: string[];
	width: number;
	colorize?: Colorize;
}

const SEPARATOR = " · ";

export function inlineList(input: InlineListInput): string[] {
	const { items, width, colorize = noColorize } = input;
	const w = Math.max(4, width);
	if (items.length === 0) return [];
	const sepColored = colorize("dim", SEPARATOR);
	const lines: string[] = [];
	let line = "";
	let lineVis = 0;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const piecePlainLen = i === 0 ? item.length : SEPARATOR.length + item.length;
		const pieceColored = i === 0 ? item : `${sepColored}${item}`;
		if (lineVis > 0 && lineVis + piecePlainLen > w) {
			lines.push(padToWidth(line, w));
			line = item;
			lineVis = item.length;
		} else {
			line += pieceColored;
			lineVis += piecePlainLen;
		}
	}
	if (lineVis > 0) lines.push(padToWidth(line, w));
	return lines;
}
