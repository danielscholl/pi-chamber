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
	composeSpawnArgs,
	extractDelta,
	extractFinalText,
	mapWithConcurrencyLimit,
	parseNdjsonLine,
	restoreSessionFile,
	shouldRetry,
	snapshotSessionFile,
	type MindMessage,
	type SpawnMindResult,
} from "./spawn.ts";

describe("parseNdjsonLine", () => {
	test("parses a typed event line", () => {
		const event = parseNdjsonLine('{"type":"message_end","message":{"role":"assistant","content":[]}}');
		expect(event?.type).toBe("message_end");
	});

	test("returns null on whitespace", () => {
		expect(parseNdjsonLine("")).toBeNull();
		expect(parseNdjsonLine("   ")).toBeNull();
	});

	test("returns null on malformed JSON", () => {
		expect(parseNdjsonLine("not json")).toBeNull();
	});

	test("returns null when the parsed object lacks a type", () => {
		expect(parseNdjsonLine('{"message":"hi"}')).toBeNull();
	});

	test("preserves arbitrary fields", () => {
		const event = parseNdjsonLine('{"type":"x","extra":42}');
		expect((event as { extra?: number } | null)?.extra).toBe(42);
	});
});

describe("extractDelta", () => {
	test("extracts text_delta from message_update.assistantMessageEvent.delta", () => {
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		};
		expect(extractDelta(ev as never)).toBe("hello");
	});

	test("extracts text_delta from .text_delta field as fallback", () => {
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", text_delta: "world" },
		};
		expect(extractDelta(ev as never)).toBe("world");
	});

	test("returns null for non-text-delta updates", () => {
		const ev = {
			type: "message_update",
			assistantMessageEvent: { type: "tool_call_delta", delta: "x" },
		};
		expect(extractDelta(ev as never)).toBeNull();
	});

	test("returns null for non-message_update events", () => {
		expect(extractDelta({ type: "message_end" } as never)).toBeNull();
	});
});

describe("extractFinalText", () => {
	test("returns the last assistant text content joined", () => {
		const messages: MindMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
		];
		expect(extractFinalText(messages)).toBe("hello world");
	});

	test("ignores tool messages", () => {
		const messages: MindMessage[] = [
			{ role: "tool", content: [{ type: "text", text: "tool output" }] },
			{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		];
		expect(extractFinalText(messages)).toBe("answer");
	});

	test("returns the last assistant message text when there are multiple", () => {
		const messages: MindMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "tool", content: [] },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		];
		expect(extractFinalText(messages)).toBe("second");
	});

	test("returns empty string when no assistant text is found", () => {
		expect(extractFinalText([])).toBe("");
		expect(
			extractFinalText([
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "x", arguments: {} }],
				},
			]),
		).toBe("");
	});
});

describe("composeSpawnArgs", () => {
	test("emits --no-session by default and --no-extensions when not opted out", () => {
		const args = composeSpawnArgs({});
		expect(args).toEqual(["--mode", "json", "-p", "--no-session", "--no-extensions"]);
	});

	test("replaces --no-session with --session <path> when sessionFile is set", () => {
		const args = composeSpawnArgs({ sessionFile: "/tmp/abs/path.session.jsonl" });
		expect(args).toContain("--session");
		expect(args).toContain("/tmp/abs/path.session.jsonl");
		expect(args).not.toContain("--no-session");
	});

	test("respects noChildExtensions: false (drops --no-extensions)", () => {
		const args = composeSpawnArgs({ noChildExtensions: false });
		expect(args).not.toContain("--no-extensions");
	});

	test("emits --model from the override before falling back to options.model", () => {
		const args = composeSpawnArgs({ model: "primary" }, "fallback");
		const idx = args.indexOf("--model");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("fallback");
	});

	test("emits --tools as a comma-joined allowlist", () => {
		const args = composeSpawnArgs({ tools: ["read", "grep", "ls"] });
		const idx = args.indexOf("--tools");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("read,grep,ls");
	});

	test("omits --tools when the list is empty", () => {
		expect(composeSpawnArgs({ tools: [] })).not.toContain("--tools");
	});
});

describe("shouldRetry", () => {
	function makeResult(over: Partial<SpawnMindResult>): SpawnMindResult {
		return {
			exitCode: 0,
			finalText: "",
			messages: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			stderr: "",
			aborted: false,
			durationMs: 0,
			...over,
		};
	}

	test("retries when exitCode != 0 AND stopReason === 'error'", () => {
		expect(shouldRetry(makeResult({ exitCode: 1, stopReason: "error" }))).toBe(true);
	});

	test("does not retry on success", () => {
		expect(shouldRetry(makeResult({ exitCode: 0, stopReason: "stop" }))).toBe(false);
	});

	test("does not retry when aborted by the user", () => {
		expect(
			shouldRetry(
				makeResult({ aborted: true, exitCode: 1, stopReason: "error" }),
			),
		).toBe(false);
	});

	test("does not retry on a process crash without a model error stop reason", () => {
		expect(shouldRetry(makeResult({ exitCode: 1 }))).toBe(false);
		expect(
			shouldRetry(makeResult({ exitCode: 1, stopReason: "stop" })),
		).toBe(false);
	});
});

describe("snapshotSessionFile / restoreSessionFile", () => {
	function withTempFile<T>(fn: (p: string) => T): T {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-snap-"));
		const file = path.join(dir, "session.jsonl");
		try {
			return fn(file);
		} finally {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	test("snapshot of an undefined path returns undefined", () => {
		expect(snapshotSessionFile(undefined)).toBeUndefined();
	});

	test("snapshot of a missing file records existed:false", () => {
		withTempFile((p) => {
			const snap = snapshotSessionFile(p);
			expect(snap).toEqual({ path: p, existed: false, content: undefined });
		});
	});

	test("snapshot of an existing file captures bytes", () => {
		withTempFile((p) => {
			fs.writeFileSync(p, "header\nturn1\n", "utf-8");
			const snap = snapshotSessionFile(p);
			expect(snap?.existed).toBe(true);
			expect(snap?.content?.toString()).toBe("header\nturn1\n");
		});
	});

	test("restore of a missing-file snapshot deletes the file", () => {
		withTempFile((p) => {
			const snap = snapshotSessionFile(p);
			fs.writeFileSync(p, "primary attempt wrote this", "utf-8");
			restoreSessionFile(snap);
			expect(fs.existsSync(p)).toBe(false);
		});
	});

	test("restore of an existing-file snapshot rewrites original bytes", () => {
		withTempFile((p) => {
			fs.writeFileSync(p, "original bytes", "utf-8");
			const snap = snapshotSessionFile(p);
			fs.writeFileSync(p, "polluted by failed primary", "utf-8");
			restoreSessionFile(snap);
			expect(fs.readFileSync(p, "utf-8")).toBe("original bytes");
		});
	});

	test("restore is a no-op when snapshot is undefined", () => {
		expect(() => restoreSessionFile(undefined)).not.toThrow();
	});
});

describe("mapWithConcurrencyLimit", () => {
	test("preserves input order in output", async () => {
		const out = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (n) => n * 2);
		expect(out).toEqual([2, 4, 6, 8, 10]);
	});

	test("returns empty for empty input", async () => {
		expect(await mapWithConcurrencyLimit([], 4, async (n) => n)).toEqual([]);
	});

	test("respects the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const tasks = Array.from({ length: 10 }, (_, i) => i);
		await mapWithConcurrencyLimit(tasks, 3, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});

	test("clamps concurrency to the input length", async () => {
		const out = await mapWithConcurrencyLimit([1, 2], 100, async (n) => n);
		expect(out).toEqual([1, 2]);
	});
});
