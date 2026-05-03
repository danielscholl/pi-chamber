import type { DetailRow } from "../../page.ts";
import { type Colorize, noColorize } from "./types.ts";
import { padToWidth } from "./text.ts";

// Details body: dim key/value rows. Used as the lowest-priority section
// on a sectioned page for fields that don't fit elsewhere.
//
//   audience    First-time Pi operator
//   guardrails  Run from repo root with plain pi
export interface DetailsBodyInput {
	rows: DetailRow[];
	width: number;
	colorize?: Colorize;
	expandValues?: boolean; // wrap (true) vs truncate (false)
}

const GAP = 2;

export function detailsBody(input: DetailsBodyInput): string[] {
	const { rows, width, colorize = noColorize, expandValues = false } = input;
	const w = Math.max(8, width);
	if (rows.length === 0) return [];
	const labelWidth = computeLabelWidth(rows, w);
	const valueWidth = Math.max(8, w - labelWidth - GAP);

	const lines: string[] = [];
	for (const row of rows) {
		const label = padRight(row.label, labelWidth);
		const labelText = colorize("dim", label);
		const valueLines = layoutValue(row.value, valueWidth, expandValues);
		if (valueLines.length === 0) {
			lines.push(padToWidth(labelText, w));
			continue;
		}
		lines.push(
			padToWidth(`${labelText}${" ".repeat(GAP)}${valueLines[0]}`, w),
		);
		for (let i = 1; i < valueLines.length; i++) {
			const indent = " ".repeat(labelWidth + GAP);
			lines.push(padToWidth(`${indent}${valueLines[i]}`, w));
		}
	}
	return lines;
}

function computeLabelWidth(rows: DetailRow[], width: number): number {
	const maxLabel = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
	const cap = Math.min(28, Math.max(8, Math.floor(width * 0.35)));
	return Math.min(cap, maxLabel);
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	return text + " ".repeat(width - text.length);
}

function layoutValue(
	value: string,
	width: number,
	expand: boolean,
): string[] {
	if (value === "") return [""];
	if (!expand) {
		return [value.length <= width ? value : truncatePlain(value, width)];
	}
	return wrapToWidth(value, width);
}

function truncatePlain(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}

function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of paragraph.split(/(\s+)/)) {
			if (word === "") continue;
			if (line.length + word.length <= width) {
				line += word;
			} else if (word.length > width) {
				if (line.length > 0) {
					out.push(line);
					line = "";
				}
				let remaining = word;
				while (remaining.length > width) {
					out.push(remaining.slice(0, width));
					remaining = remaining.slice(width);
				}
				line = remaining;
			} else {
				out.push(line.trimEnd());
				line = /\s/.test(word) ? "" : word;
			}
		}
		if (line.length > 0) out.push(line.trimEnd());
	}
	return out;
}
