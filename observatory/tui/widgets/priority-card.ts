import type { Severity } from "../../page.ts";
import { type Colorize, noColorize, type ThemeColorKey } from "./types.ts";
import { padToWidth, truncateToWidth, wrapTextWithAnsi } from "./text.ts";

// Priority card: the only bordered widget on a sectioned briefing page.
// Title sits inside on its own line, body wraps and is never truncated.
//
//   ╭──────────────────────────────────────────────╮
//   │ Top Priority                                 │
//   │ Ship the observatory dashboard controls      │
//   │ before expanding the lens catalog.           │
//   ╰──────────────────────────────────────────────╯
export interface PriorityCardInput {
	title: string;
	body: string;
	severity?: Severity;
	width: number;
	colorize?: Colorize;
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

export function priorityCard(input: PriorityCardInput): string[] {
	const { title, body, severity, width, colorize = noColorize } = input;
	const w = Math.max(10, width);
	const innerWidth = w - 4; // 2 borders + 2 inner padding
	const borderKey = severityBorderKey(severity);
	const c = (text: string): string => colorize(borderKey, text);

	const lines: string[] = [];
	lines.push(c(`${TOP_LEFT}${HORIZONTAL.repeat(w - 2)}${TOP_RIGHT}`));

	const titleColored = colorize("accent", truncateToWidth(title, innerWidth));
	lines.push(
		`${c(VERTICAL)} ${padToWidth(titleColored, innerWidth)} ${c(VERTICAL)}`,
	);

	const wrapped = wrapTextWithAnsi(body, innerWidth);
	for (const ln of wrapped) {
		lines.push(`${c(VERTICAL)} ${padToWidth(ln, innerWidth)} ${c(VERTICAL)}`);
	}

	lines.push(c(`${BOTTOM_LEFT}${HORIZONTAL.repeat(w - 2)}${BOTTOM_RIGHT}`));
	return lines;
}

function severityBorderKey(severity: Severity | undefined): ThemeColorKey {
	switch (severity) {
		case "warn":
			return "warn";
		case "err":
			return "error";
		case "ok":
			return "success";
		case "info":
			return "border";
		default:
			return "borderAccent";
	}
}
