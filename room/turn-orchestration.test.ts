import { describe, expect, test } from "bun:test";
import { formatToolActivityLabel } from "./turn-orchestration.ts";

describe("formatToolActivityLabel", () => {
	test("returns bare tool name when args are missing or wrong shape", () => {
		expect(formatToolActivityLabel("bash", undefined)).toBe("bash");
		expect(formatToolActivityLabel("bash", null)).toBe("bash");
		expect(formatToolActivityLabel("bash", "not an object")).toBe("bash");
		expect(formatToolActivityLabel("bash", {})).toBe("bash");
	});

	test("appends path for path-based tools", () => {
		expect(
			formatToolActivityLabel("read", { path: "room/ui.ts" }),
		).toBe("read room/ui.ts");
		expect(
			formatToolActivityLabel("edit", { path: "room/index.ts", edits: [] }),
		).toBe("edit room/index.ts");
		expect(formatToolActivityLabel("ls", { path: "." })).toBe("ls .");
	});

	test("tail-truncates long paths so the filename stays visible", () => {
		const longPath =
			"/Users/danielscholl/source/pi-testing/pi-chamber/room/strategies/open-floor.ts";
		const out = formatToolActivityLabel("read", { path: longPath });
		// The full path is too long; the tail (with the filename) must be
		// preserved with a leading ellipsis.
		expect(out.startsWith("read …")).toBe(true);
		expect(out.endsWith("open-floor.ts")).toBe(true);
	});

	test("appends command for bash, head-truncated and one-line", () => {
		expect(
			formatToolActivityLabel("bash", { command: "bun test" }),
		).toBe("bash bun test");
		// Multi-line commands collapse to the first non-empty line.
		expect(
			formatToolActivityLabel("bash", {
				command: "set -e\nbun install\nbun test",
			}),
		).toBe("bash set -e");
		// Long commands head-truncate (preserve the intent at the start).
		const long = `bun test ${"x".repeat(100)}`;
		const out = formatToolActivityLabel("bash", { command: long });
		expect(out.startsWith("bash bun test")).toBe(true);
		expect(out.endsWith("…")).toBe(true);
	});

	test("appends pattern for grep/find", () => {
		expect(
			formatToolActivityLabel("grep", { pattern: "thinking" }),
		).toBe("grep thinking");
	});

	test("falls back to tool name when known fields are empty strings", () => {
		expect(formatToolActivityLabel("read", { path: "" })).toBe("read");
		expect(formatToolActivityLabel("bash", { command: "" })).toBe("bash");
	});
});
