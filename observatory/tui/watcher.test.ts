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
import { startLensWatcher, type WatcherChange } from "./watcher.ts";

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lens-watcher-"));
	return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("startLensWatcher", () => {
	test("classifies a manifest write as a 'discover' change", async () => {
		await withTempDir(async (dir) => {
			const events: WatcherChange[] = [];
			const watcher = startLensWatcher(
				dir,
				(kind) => events.push(kind),
				{ debounceMs: 50 },
			);
			fs.mkdirSync(path.join(dir, "ops"), { recursive: true });
			fs.writeFileSync(path.join(dir, "ops", "lens.json"), "{}");
			await sleep(150);
			watcher.stop();
			expect(events.includes("discover")).toBe(true);
		});
	});

	test("classifies a data-only write as a 'data' change", async () => {
		await withTempDir(async (dir) => {
			fs.mkdirSync(path.join(dir, "ops"), { recursive: true });
			fs.writeFileSync(path.join(dir, "ops", "lens.json"), "{}");
			// Allow the manifest write to flush before subscribing.
			await sleep(20);
			const events: WatcherChange[] = [];
			const watcher = startLensWatcher(
				dir,
				(kind) => events.push(kind),
				{ debounceMs: 80 },
			);
			await sleep(20);
			fs.writeFileSync(
				path.join(dir, "ops", "data.json"),
				JSON.stringify({ x: 1 }),
			);
			await sleep(200);
			watcher.stop();
			expect(events.length).toBeGreaterThan(0);
			// First flushed event should be data (no manifest-touching activity).
			expect(events[0]).toBe("data");
		});
	});

	test("coalesces a burst of writes into a single callback per window", async () => {
		await withTempDir(async (dir) => {
			fs.mkdirSync(path.join(dir, "ops"), { recursive: true });
			fs.writeFileSync(path.join(dir, "ops", "lens.json"), "{}");
			await sleep(20);
			const events: WatcherChange[] = [];
			const watcher = startLensWatcher(
				dir,
				(kind) => events.push(kind),
				{ debounceMs: 100 },
			);
			await sleep(20);
			for (let i = 0; i < 5; i++) {
				fs.writeFileSync(
					path.join(dir, "ops", "data.json"),
					JSON.stringify({ x: i }),
				);
			}
			await sleep(250);
			watcher.stop();
			expect(events.length).toBeLessThanOrEqual(2);
		});
	});

	test("polls for an absent root and attaches once it appears", async () => {
		await withTempDir(async (dir) => {
			const target = path.join(dir, "lenses");
			const events: WatcherChange[] = [];
			const watcher = startLensWatcher(
				target,
				(kind) => events.push(kind),
				{ debounceMs: 60, existencePollMs: 60 },
			);
			await sleep(120);
			fs.mkdirSync(target, { recursive: true });
			await sleep(200);
			fs.mkdirSync(path.join(target, "ops"));
			fs.writeFileSync(path.join(target, "ops", "lens.json"), "{}");
			await sleep(200);
			watcher.stop();
			expect(events.length).toBeGreaterThan(0);
		});
	});

	test("stop() detaches and prevents further callbacks", async () => {
		await withTempDir(async (dir) => {
			fs.mkdirSync(path.join(dir, "ops"), { recursive: true });
			fs.writeFileSync(path.join(dir, "ops", "lens.json"), "{}");
			await sleep(20);
			const events: WatcherChange[] = [];
			const watcher = startLensWatcher(
				dir,
				(kind) => events.push(kind),
				{ debounceMs: 50 },
			);
			watcher.stop();
			fs.writeFileSync(
				path.join(dir, "ops", "data.json"),
				JSON.stringify({ x: 1 }),
			);
			await sleep(150);
			expect(events.length).toBe(0);
		});
	});
});
