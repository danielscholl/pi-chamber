import { describe, expect, test } from "bun:test";
import { grid } from "../grid.ts";
import { visibleWidth } from "../text.ts";

const cell = (lines: string[]) => () => lines;

describe("grid widget", () => {
	test("returns empty array when no cells", () => {
		expect(grid({ cells: [], width: 60 })).toEqual([]);
	});

	test("collapses to 1 column when width < minColWidth*2 + gap", () => {
		const out = grid({
			cells: [cell(["A"]), cell(["B"])],
			width: 40,
			minColWidth: 24,
			gap: 2,
		});
		// 2 cells stacked: 1 line each → 2 rows of output, each width 40
		expect(out).toHaveLength(2);
		expect(out[0].trimEnd()).toBe("A");
		expect(out[1].trimEnd()).toBe("B");
	});

	test("lays out 2 cells side-by-side when width allows", () => {
		const out = grid({
			cells: [cell(["A"]), cell(["B"])],
			width: 60,
			minColWidth: 24,
			gap: 2,
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("A");
		expect(out[0]).toContain("B");
		expect(visibleWidth(out[0])).toBe(60);
	});

	test("equalizes row height with blank-line padding", () => {
		const out = grid({
			cells: [cell(["A1", "A2", "A3"]), cell(["B1"])],
			width: 60,
			minColWidth: 24,
			gap: 2,
		});
		expect(out).toHaveLength(3);
		// First row contains both A1 and B1
		expect(out[0]).toContain("A1");
		expect(out[0]).toContain("B1");
		// Second row contains A2 and B's blank padding
		expect(out[1]).toContain("A2");
		expect(out[2]).toContain("A3");
	});

	test("does not insert gap on single cell", () => {
		const out = grid({
			cells: [cell(["only"])],
			width: 20,
			minColWidth: 10,
			gap: 4,
		});
		expect(out).toHaveLength(1);
		expect(visibleWidth(out[0])).toBe(20);
		expect(out[0].trimEnd()).toBe("only");
	});

	test("returns lines padded to exactly width", () => {
		const out = grid({
			cells: [cell(["x"]), cell(["y"]), cell(["z"])],
			width: 80,
			minColWidth: 20,
			gap: 2,
		});
		for (const line of out) {
			expect(visibleWidth(line)).toBe(80);
		}
	});

	test("flows 5 cells into 2 columns across multiple rows", () => {
		const out = grid({
			cells: [
				cell(["1"]),
				cell(["2"]),
				cell(["3"]),
				cell(["4"]),
				cell(["5"]),
			],
			width: 60,
			minColWidth: 24,
			gap: 2,
		});
		// 5 cells / 2 cols = 3 rows
		expect(out).toHaveLength(3);
	});

	test("never produces more columns than cells", () => {
		const out = grid({
			cells: [cell(["only"])],
			width: 200,
			minColWidth: 10,
			gap: 2,
		});
		expect(out).toHaveLength(1);
	});
});
