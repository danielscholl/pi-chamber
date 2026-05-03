import {
	type StatusTier,
	tierGlyph,
} from "../render-status-board.ts";
import { type Colorize, type ThemeColorKey, noColorize } from "./types.ts";

// Single-line status pill: glyph + label. No padding — caller composes.
export function statusPill(
	tier: StatusTier,
	label: string,
	colorize: Colorize = noColorize,
): string {
	const colorKey = tierColorKey(tier);
	return `${colorize(colorKey, tierGlyph(tier))} ${label}`;
}

export function tierColorKey(tier: StatusTier): ThemeColorKey {
	switch (tier) {
		case "ok":
			return "success";
		case "warn":
			return "warn";
		case "err":
			return "error";
		default:
			return "muted";
	}
}
