import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "./text.ts";

// Section header used by every non-priority page section
// (METRICS, RECENT CHANGES, DOMAINS, NARRATIVE, DETAILS).
//
// Layout:
//   METRICS       <-- accent, uppercased
//   ─────         <-- dim, sized to label
//
// The body lines that follow are composed by the caller.
export interface SectionHeaderInput {
	label: string;
	width: number;
	colorize?: Colorize;
}

export function sectionHeader(input: SectionHeaderInput): string[] {
	const { label, width, colorize = noColorize } = input;
	const w = Math.max(2, width);
	const upper = label.toUpperCase();
	const truncated = truncateToWidth(upper, w);
	const labelLine = colorize("accent", truncated);
	const dashes = "─".repeat(visibleWidth(truncated));
	const dividerLine = colorize("dim", dashes);
	return [padToWidth(labelLine, w), padToWidth(dividerLine, w)];
}
