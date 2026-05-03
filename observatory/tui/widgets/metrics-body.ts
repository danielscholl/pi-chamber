import type { Metric } from "../../page.ts";
import { type Colorize, noColorize } from "./types.ts";
import { padToWidth, truncateToWidth } from "./text.ts";

// Metrics body: auto-layout based on width.
//
// Strip layout (preferred when ≤4 metrics fit horizontally):
//   inbox     initiatives     domains
//   3         5               2
//
// Vertical layout (fallback):
//   inbox items         3
//   active initiatives  5
//   domains             2
export interface MetricsBodyInput {
	metrics: Metric[];
	width: number;
	colorize?: Colorize;
}

const STRIP_MIN_GAP = 4;
const STRIP_MAX_GAP = 8;
const VERTICAL_GAP = 2;
const STRIP_MAX_COLS = 4;

export function metricsBody(input: MetricsBodyInput): string[] {
	const { metrics, width, colorize = noColorize } = input;
	const w = Math.max(8, width);
	if (metrics.length === 0) return [];

	const strip = tryStripLayout(metrics, w, colorize);
	if (strip) return strip;
	return verticalLayout(metrics, w, colorize);
}

function tryStripLayout(
	metrics: Metric[],
	width: number,
	colorize: Colorize,
): string[] | null {
	if (metrics.length === 0 || metrics.length > STRIP_MAX_COLS) return null;
	const colWidths = metrics.map((m) =>
		Math.max(m.label.length, m.value.length),
	);
	const totalContent = colWidths.reduce((s, c) => s + c, 0);
	const minTotal =
		totalContent + STRIP_MIN_GAP * Math.max(0, metrics.length - 1);
	if (minTotal > width) return null;

	let gap = STRIP_MIN_GAP;
	if (metrics.length > 1) {
		const slack = width - totalContent;
		const candidate = Math.floor(slack / (metrics.length - 1));
		gap = Math.max(STRIP_MIN_GAP, Math.min(STRIP_MAX_GAP, candidate));
	}
	const labelRow = metrics
		.map((m, i) => padRight(m.label, colWidths[i]))
		.join(" ".repeat(gap));
	const valueRow = metrics
		.map((m, i) => padRight(m.value, colWidths[i]))
		.join(" ".repeat(gap));
	return [
		padToWidth(colorize("dim", labelRow), width),
		padToWidth(colorize("bold", valueRow), width),
	];
}

function verticalLayout(
	metrics: Metric[],
	width: number,
	colorize: Colorize,
): string[] {
	const maxLabel = metrics.reduce((m, x) => Math.max(m, x.label.length), 0);
	const labelCol = Math.min(maxLabel, Math.max(8, Math.floor(width * 0.6)));
	const lines: string[] = [];
	for (const m of metrics) {
		const label = padRight(truncateToWidth(m.label, labelCol), labelCol);
		const labelText = colorize("dim", label);
		const valueText = colorize("bold", m.value);
		const composed = `${labelText}${" ".repeat(VERTICAL_GAP)}${valueText}`;
		lines.push(padToWidth(composed, width));
	}
	return lines;
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
}
