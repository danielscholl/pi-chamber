// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
import {
	type ObservatoryRoomSnapshot,
	buildChamberObservatoryData,
	buildChamberObservatoryManifest,
	clearChamberObservatoryLens,
	paletteNameForIndex,
	resolveChamberObservatoryPaths,
	writeChamberObservatoryLens,
} from "./observatory.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chamber-observatory-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function activeSnapshot(): ObservatoryRoomSnapshot {
	return {
		active: true,
		mode: "concurrent",
		roomLabel: "Standup",
		startedAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:01.000Z",
		participants: [
			{
				name: "ariadne",
				status: "speaking",
				role: "speaker",
				color: "pink",
				turns: 1,
				lastReply: "I think the rollout looks good.",
			},
			{
				name: "mycroft",
				status: "ready",
				role: "speaker",
				color: "cyan",
				turns: 0,
			},
		],
	};
}

describe("buildChamberObservatoryManifest", () => {
	test("returns a valid v1 status-board manifest", () => {
		const manifest = buildChamberObservatoryManifest();
		expect(manifest).toEqual(
			expect.objectContaining({
				name: "Chamber Room",
				kind: "status-board",
				source: "data.json",
			}),
		);
	});
});

describe("buildChamberObservatoryData", () => {
	test("returns participant cards when active", () => {
		const data = buildChamberObservatoryData(activeSnapshot());
		expect(data.length).toBe(2);
		expect(data[0]).toEqual(
			expect.objectContaining({
				name: "ariadne",
				status: "speaking",
				role: "speaker",
				color: "pink",
				turns: 1,
				lastReply: "I think the rollout looks good.",
			}),
		);
		expect(data[1].lastReply).toBeUndefined();
	});

	test("returns an empty array when inactive", () => {
		const data = buildChamberObservatoryData({
			active: false,
			mode: "concurrent",
			updatedAt: "2026-05-01T00:00:00.000Z",
			participants: [],
		});
		expect(data).toEqual([]);
	});

	test("truncates very long lastReply text", () => {
		const data = buildChamberObservatoryData({
			active: true,
			mode: "concurrent",
			updatedAt: "x",
			participants: [
				{
					name: "ariadne",
					status: "done",
					role: "speaker",
					color: "pink",
					turns: 1,
					lastReply: "x".repeat(1000),
				},
			],
		});
		expect((data[0].lastReply as string).length).toBeLessThanOrEqual(280);
		expect((data[0].lastReply as string).endsWith("…")).toBe(true);
	});
});

describe("paletteNameForIndex", () => {
	test("returns a palette color name for a valid index", () => {
		expect(typeof paletteNameForIndex(0)).toBe("string");
	});

	test("falls back gracefully for invalid indexes", () => {
		expect(typeof paletteNameForIndex(999)).toBe("string");
	});
});

describe("writeChamberObservatoryLens / clearChamberObservatoryLens", () => {
	test("writes manifest and data files at the resolved lens path", () => {
		withTempProject((cwd) => {
			const paths = writeChamberObservatoryLens(cwd, activeSnapshot());
			expect(fs.existsSync(paths.manifestPath)).toBe(true);
			expect(fs.existsSync(paths.dataPath)).toBe(true);
			const manifest = JSON.parse(
				fs.readFileSync(paths.manifestPath, "utf-8"),
			);
			expect(manifest.kind).toBe("status-board");
			const data = JSON.parse(fs.readFileSync(paths.dataPath, "utf-8"));
			expect(Array.isArray(data)).toBe(true);
			expect(data[0].name).toBe("ariadne");
		});
	});

	test("clear removes the lens directory", () => {
		withTempProject((cwd) => {
			writeChamberObservatoryLens(cwd, activeSnapshot());
			const paths = resolveChamberObservatoryPaths(cwd);
			expect(fs.existsSync(paths.lensDir)).toBe(true);
			clearChamberObservatoryLens(cwd);
			expect(fs.existsSync(paths.lensDir)).toBe(false);
		});
	});

	test("inactive snapshot writes an empty data array", () => {
		withTempProject((cwd) => {
			writeChamberObservatoryLens(cwd, {
				active: false,
				mode: "concurrent",
				updatedAt: "x",
				participants: [],
			});
			const paths = resolveChamberObservatoryPaths(cwd);
			const data = JSON.parse(fs.readFileSync(paths.dataPath, "utf-8"));
			expect(data).toEqual([]);
		});
	});
});

describe("resolveChamberObservatoryPaths", () => {
	test("places the lens under .pi/observatory/lenses/room", () => {
		withTempProject((cwd) => {
			const paths = resolveChamberObservatoryPaths(cwd);
			expect(paths.lensDir.endsWith("/.pi/observatory/lenses/room")).toBe(
				true,
			);
			expect(paths.manifestPath.endsWith("lens.json")).toBe(true);
			expect(paths.dataPath.endsWith("data.json")).toBe(true);
		});
	});

	test("respects observatory.lensesPath in .pi/settings.json", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify(
					{ observatory: { lensesPath: "./.pi/observatory/custom-lenses" } },
					null,
					2,
				),
			);
			const paths = resolveChamberObservatoryPaths(cwd);
			expect(
				paths.lensDir.endsWith("/.pi/observatory/custom-lenses/room"),
			).toBe(true);
		});
	});
});
