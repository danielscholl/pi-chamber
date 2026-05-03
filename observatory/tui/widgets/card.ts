import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, truncateToWidth } from "./text.ts";

// Card widget: emoji + dim label + value, ≥ 4 lines, all width-padded.
// Layout:
//   ╭─────────────────╮
//   │ # active minds  │   ← emoji + dim label
//   │ 3               │   ← value (bold via colorize when emphasizeValue)
//   ╰─────────────────╯
export interface CardInput {
	label: string;
	value: string;
	width: number;
	emoji?: string;
	emphasizeValue?: boolean; // colorize("bold", value) when true
	colorize?: Colorize;
}

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

export function card(input: CardInput): string[] {
	const { label, value, width, emoji, emphasizeValue, colorize = noColorize } =
		input;
	const w = Math.max(6, width);
	const innerWidth = w - 4; // 2 borders + 1 left pad + 1 right pad
	const border = (text: string): string => colorize("border", text);

	const labelText = emoji ? `${emoji} ${label}` : label;
	const labelLine = colorize(
		"dim",
		padToWidth(truncateToWidth(labelText, innerWidth), innerWidth),
	);
	const rawValue = padToWidth(
		truncateToWidth(value || "—", innerWidth),
		innerWidth,
	);
	const valueLine = emphasizeValue ? colorize("bold", rawValue) : rawValue;

	const top = border(`${TOP_LEFT}${HORIZONTAL.repeat(w - 2)}${TOP_RIGHT}`);
	const bottom = border(
		`${BOTTOM_LEFT}${HORIZONTAL.repeat(w - 2)}${BOTTOM_RIGHT}`,
	);
	const labelRow = `${border(VERTICAL)} ${labelLine} ${border(VERTICAL)}`;
	const valueRow = `${border(VERTICAL)} ${valueLine} ${border(VERTICAL)}`;

	return [top, labelRow, valueRow, bottom];
}
