// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import {
	accumulateUsage,
	composeSpawnArgs,
	extractDelta,
	extractFinalText,
	parseNdjsonLine,
	type AssistantMessage,
	type AssistantUsage,
	type NdjsonEvent,
	type SpawnUsage,
} from "./spawn.ts";

describe("composeSpawnArgs", () => {
	test("baseline: --mode json -p --no-session --no-extensions", () => {
		expect(composeSpawnArgs({})).toEqual(["--mode", "json", "-p", "--no-session", "--no-extensions"]);
	});

	test("resumeSessionId replaces --no-session with --resume <id>", () => {
		expect(composeSpawnArgs({ resumeSessionId: "sess-123" })).toEqual([
			"--mode",
			"json",
			"-p",
			"--resume",
			"sess-123",
			"--no-extensions",
		]);
	});

	test("noChildExtensions: false drops --no-extensions", () => {
		expect(composeSpawnArgs({ noChildExtensions: false })).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
		]);
	});

	test("model adds --model <name>", () => {
		const args = composeSpawnArgs({ model: "claude-opus-4-7" });
		expect(args).toContain("--model");
		const idx = args.indexOf("--model");
		expect(args[idx + 1]).toBe("claude-opus-4-7");
	});

	test("allowedTools adds --tools <comma-list>", () => {
		const args = composeSpawnArgs({ allowedTools: ["Read", "Edit", "Bash"] });
		const idx = args.indexOf("--tools");
		expect(args[idx + 1]).toBe("Read,Edit,Bash");
	});

	test("deniedTools adds --disallowed-tools <comma-list>", () => {
		const args = composeSpawnArgs({ deniedTools: ["Write", "WebFetch"] });
		const idx = args.indexOf("--disallowed-tools");
		expect(args[idx + 1]).toBe("Write,WebFetch");
	});

	test("systemPromptFile adds --append-system-prompt <path>", () => {
		const args = composeSpawnArgs({ systemPromptFile: "/tmp/sys.md" });
		const idx = args.indexOf("--append-system-prompt");
		expect(args[idx + 1]).toBe("/tmp/sys.md");
	});

	test("empty allowedTools array does NOT emit --tools", () => {
		expect(composeSpawnArgs({ allowedTools: [] })).not.toContain("--tools");
	});
});

describe("parseNdjsonLine", () => {
	test("returns null on empty / whitespace lines", () => {
		expect(parseNdjsonLine("")).toBeNull();
		expect(parseNdjsonLine("   ")).toBeNull();
		expect(parseNdjsonLine("\n")).toBeNull();
	});

	test("returns null on non-JSON noise", () => {
		expect(parseNdjsonLine("not json")).toBeNull();
		expect(parseNdjsonLine("[]")).toBeNull();
	});

	test("returns null when JSON has no 'type' string", () => {
		expect(parseNdjsonLine(JSON.stringify({ foo: 1 }))).toBeNull();
		expect(parseNdjsonLine(JSON.stringify({ type: 42 }))).toBeNull();
	});

	test("returns parsed object when type is a string", () => {
		const event = parseNdjsonLine(JSON.stringify({ type: "session", sessionId: "abc" }));
		expect(event?.type).toBe("session");
	});
});

describe("extractFinalText", () => {
	test("returns the latest assistant text-block content", () => {
		const messages: AssistantMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		];
		expect(extractFinalText(messages)).toBe("second");
	});

	test("concatenates multiple text parts within one message", () => {
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello " },
					{ type: "text", text: "world" },
				],
			},
		];
		expect(extractFinalText(messages)).toBe("hello world");
	});

	test("skips non-assistant messages", () => {
		const messages: AssistantMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "real" }] },
			{ role: "user", content: [{ type: "text", text: "ignored" }] } as AssistantMessage,
		];
		expect(extractFinalText(messages)).toBe("real");
	});

	test("returns empty string when no assistant text present", () => {
		expect(extractFinalText([])).toBe("");
		expect(extractFinalText([{ role: "assistant", content: [] }])).toBe("");
	});
});

describe("extractDelta", () => {
	test("returns delta string for text_delta updates", () => {
		const event: NdjsonEvent = {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "tok" },
		};
		expect(extractDelta(event)).toBe("tok");
	});

	test("falls back to text_delta key when delta missing", () => {
		const event: NdjsonEvent = {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", text_delta: "fallback" },
		};
		expect(extractDelta(event)).toBe("fallback");
	});

	test("returns null for non-text_delta inner type", () => {
		const event: NdjsonEvent = {
			type: "message_update",
			assistantMessageEvent: { type: "tool_call_delta", delta: "ignored" },
		};
		expect(extractDelta(event)).toBeNull();
	});

	test("returns null for non-message_update events", () => {
		expect(extractDelta({ type: "session" } as NdjsonEvent)).toBeNull();
	});
});

describe("accumulateUsage", () => {
	test("returns prev unchanged when next is undefined", () => {
		const prev: SpawnUsage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			costUsd: 0.001,
		};
		expect(accumulateUsage(prev, undefined)).toBe(prev);
	});

	test("returns undefined when both prev and next are undefined", () => {
		expect(accumulateUsage(undefined, undefined)).toBeUndefined();
	});

	test("seeds a fresh accumulator from the first usage payload", () => {
		const next: AssistantUsage = {
			input: 100,
			output: 50,
			cacheRead: 200,
			cacheWrite: 10,
			totalTokens: 360,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		};
		expect(accumulateUsage(undefined, next)).toEqual({
			input: 100,
			output: 50,
			cacheRead: 200,
			cacheWrite: 10,
			totalTokens: 360,
			costUsd: 0.003,
		});
	});

	test("sums token counts and cost across multiple usage payloads", () => {
		const first: AssistantUsage = {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { total: 0.001 },
		};
		const second: AssistantUsage = {
			input: 80,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { total: 0.0008 },
		};
		const acc = accumulateUsage(undefined, first);
		const final = accumulateUsage(acc, second);
		expect(final).toEqual({
			input: 180,
			output: 90,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 270,
			costUsd: 0.0018,
		});
	});

	test("treats missing fields as zero contributions (defensive)", () => {
		const partial: AssistantUsage = { input: 10 };
		expect(accumulateUsage(undefined, partial)).toEqual({
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			costUsd: 0,
		});
	});

	test("threads through an AssistantMessage shape unchanged", () => {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			stopReason: "stop",
			usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8 },
		};
		expect(accumulateUsage(undefined, msg.usage)).toEqual({
			input: 5,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 8,
			costUsd: 0,
		});
	});
});
