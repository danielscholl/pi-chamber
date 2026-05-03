import { padToWidth } from "./text.ts";

// Grid widget: lays out cell factories into N columns based on width.
// Each cell is a factory that takes the assigned column width and returns
// its lines. The grid pads short cells with blank lines (so columns
// align row-wise) and joins cells horizontally with `gap` spaces.
// Returned lines are padded to exactly `width` visible columns.
export interface GridInput {
	cells: Array<(colWidth: number) => string[]>;
	width: number;
	minColWidth?: number; // default 24
	gap?: number; // default 2
}

export function grid(input: GridInput): string[] {
	const { cells, width } = input;
	const minColWidth = input.minColWidth ?? 24;
	const gap = Math.max(0, input.gap ?? 2);

	if (cells.length === 0) return [];
	if (width <= 0) return [];

	const cols = Math.max(
		1,
		Math.min(
			cells.length,
			Math.floor((width + gap) / (minColWidth + gap)),
		),
	);
	const effectiveGap = cols === 1 ? 0 : gap;
	const totalGap = effectiveGap * (cols - 1);
	const colWidth = Math.max(1, Math.floor((width - totalGap) / cols));

	const out: string[] = [];
	for (let i = 0; i < cells.length; i += cols) {
		const rowCells = cells.slice(i, i + cols).map((factory) => factory(colWidth));
		const rowHeight = rowCells.reduce((m, c) => Math.max(m, c.length), 0);
		const blank = " ".repeat(colWidth);
		const padded = rowCells.map((cellLines) => {
			const lines = cellLines.map((line) => padToWidth(line, colWidth));
			while (lines.length < rowHeight) lines.push(blank);
			return lines;
		});
		const sep = effectiveGap > 0 ? " ".repeat(effectiveGap) : "";
		for (let r = 0; r < rowHeight; r++) {
			const rowLine = padded.map((cell) => cell[r]).join(sep);
			out.push(padToWidth(rowLine, width));
		}
	}
	return out;
}
