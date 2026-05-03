import {
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

// Pad a single line out to exactly `width` visible columns.
// Uses visibleWidth so ANSI escapes and wide chars are accounted for.
export function padToWidth(line: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(line);
	if (w >= width) return line;
	return line + " ".repeat(width - w);
}
