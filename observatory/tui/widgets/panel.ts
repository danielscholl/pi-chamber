import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "./text.ts";

// Bordered box widget. Returned lines are padded to exactly `width`
// visible columns so callers (e.g., grid) can stack columns without
// per-cell repad logic.
export interface PanelInput {
	title: string;
	body: string[]; // lines bounded by inner width; widget pads
	width: number; // outer width including borders
	colorize?: Colorize;
	accent?: boolean; // borderAccent vs border
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

export function panel(input: PanelInput): string[] {
	const { title, body, width, colorize = noColorize, accent } = input;
	const w = Math.max(4, width);
	const borderKey = accent ? "borderAccent" : "border";
	const c = (text: string): string => colorize(borderKey, text);

	const innerWidth = w - 2;
	const lines: string[] = [];
	lines.push(buildTopBorder(title, w, c));
	for (const raw of body) {
		const padded = padToWidth(truncateToWidth(raw, innerWidth), innerWidth);
		lines.push(`${c(VERTICAL)}${padded}${c(VERTICAL)}`);
	}
	lines.push(buildBottomBorder(w, c));
	return lines;
}

function buildTopBorder(
	title: string,
	width: number,
	c: (text: string) => string,
): string {
	// Title chip: ╭─ Title ──────╮
	// Reserve: 2 corners + 2 inner spaces + 2 dashes around title = 6
	const titleBudget = Math.max(0, width - 6);
	if (!title || titleBudget < 1) {
		return c(`${TOP_LEFT}${HORIZONTAL.repeat(width - 2)}${TOP_RIGHT}`);
	}
	const truncatedTitle = truncateToWidth(title, titleBudget);
	const titleVis = visibleWidth(truncatedTitle);
	// Layout: ╭ + ─ + " " + title + " " + ─*N + ╮ = total
	// 5 fixed chars + titleVis + N = width
	const fillLen = Math.max(0, width - 5 - titleVis);
	return (
		c(`${TOP_LEFT}${HORIZONTAL} `) +
		truncatedTitle +
		c(` ${HORIZONTAL.repeat(fillLen)}${TOP_RIGHT}`)
	);
}

function buildBottomBorder(
	width: number,
	c: (text: string) => string,
): string {
	return c(`${BOTTOM_LEFT}${HORIZONTAL.repeat(width - 2)}${BOTTOM_RIGHT}`);
}
