// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	extractDelta,
	extractFinalText,
	mapWithConcurrencyLimit,
	parseNdjsonLine,
	type MindMessage,
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
