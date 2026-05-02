// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	buildModeratorPrompt,
	buildSpeakerPrompt,
	buildSynthesisPrompt,
	CONTROL_ACTIONS,
	extractJsonObject,
	parseModeratorDecision,
	stripControlJson,
} from "./prompts.ts";

describe("buildSpeakerPrompt", () => {
	test("emits identity, room metadata, and current message in order", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "concurrent",
			participants: ["ariadne", "mycroft"],
			userMessage: "what is up?",
			history: [],
		});
		expect(out).toContain("<identity>");
		expect(out).toContain("ariadne");
		expect(out).toContain('mode="concurrent"');
		expect(out).toContain("ariadne, mycroft");
		expect(out).toContain('<message sender="You">what is up?</message>');
	});

	test("renders chatroom-history with prior turns", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "concurrent",
			participants: ["ariadne", "mycroft"],
			userMessage: "follow up",
			history: [
				{ speaker: "user", content: "first question" },
				{ speaker: "mycroft", content: "first answer" },
			],
		});
		expect(out).toContain("<chatroom-history");
		expect(out).toContain("first question");
		expect(out).toContain("first answer");
	});

	test("includes moderator-direction when provided", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "group-chat",
			participants: ["ariadne", "mycroft", "jarvis"],
			userMessage: "decide team-size",
			history: [],
			moderatorDirection: "address the cost angle",
		});
		expect(out).toContain("<moderator-direction>");
		expect(out).toContain("address the cost angle");
	});

	test("escapes XML hostile characters in user message", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "concurrent",
			participants: ["ariadne"],
			userMessage: "<script>alert('x')</script> & co",
			history: [],
		});
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("&amp;");
	});
});

describe("buildModeratorPrompt", () => {
	test("open phase emits opening instruction", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "jarvis",
			speakers: ["ariadne", "mycroft"],
			userMessage: "should we ship?",
			transcript: [],
			phase: "open",
			spokenSlugs: new Set(),
		});
		expect(out).toContain('phase="open"');
		expect(out).toContain("OPENING of the discussion");
		expect(out).toContain('"action": "direct"');
	});

	test("may_close phase exposes the close option", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "jarvis",
			speakers: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [
				{ speaker: "ariadne", content: "yes", turnNumber: 1 },
				{ speaker: "mycroft", content: "yes", turnNumber: 2 },
			],
			phase: "may_close",
			spokenSlugs: new Set(["ariadne", "mycroft"]),
		});
		expect(out).toContain('phase="may_close"');
		expect(out).toContain('action": "close"');
	});

	test("moderate phase prioritizes unheard participants", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "jarvis",
			speakers: ["ariadne", "mycroft", "scout"],
			userMessage: "ship?",
			transcript: [{ speaker: "ariadne", content: "yes", turnNumber: 1 }],
			phase: "moderate",
			spokenSlugs: new Set(["ariadne"]),
		});
		expect(out).toContain('phase="moderate"');
		expect(out).toContain("not yet heard: mycroft, scout");
	});

	test("strips control JSON from transcript turns", () => {
		const controlJson =
			'{"next_speaker":"x","direction":"y","action":"close"}';
		const out = buildModeratorPrompt({
			moderatorSlug: "jarvis",
			speakers: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [
				{
					speaker: "ariadne",
					content: `Some text ${controlJson}`,
					turnNumber: 1,
				},
			],
			phase: "may_close",
			spokenSlugs: new Set(["ariadne"]),
		});
		// The control JSON itself is stripped from the rendered turn, even though
		// the moderator instruction template still mentions the word "close".
		expect(out).not.toContain('"next_speaker":"x"');
		expect(out).toContain('<turn speaker="ariadne" turn="1">Some text</turn>');
	});
});

describe("buildSynthesisPrompt", () => {
	test("includes transcript and asks moderator to summarize in their voice", () => {
		const out = buildSynthesisPrompt({
			moderatorSlug: "jarvis",
			participants: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [
				{ speaker: "ariadne", content: "yes", turnNumber: 1 },
				{ speaker: "mycroft", content: "no", turnNumber: 2 },
			],
		});
		expect(out).toContain("<group-chat-synthesis");
		expect(out).toContain("jarvis");
		expect(out).toContain("Speak in your own voice");
	});
});

describe("extractJsonObject", () => {
	test("extracts the outermost JSON object", () => {
		const text = 'before {"a":1,"b":[1,2,3]} after';
		expect(extractJsonObject(text)).toEqual('{"a":1,"b":[1,2,3]}');
	});

	test("ignores braces inside strings", () => {
		const text = '{"text":"hello {world}","x":1}';
		expect(extractJsonObject(text)).toEqual(text);
	});

	test("returns null when no object is present", () => {
		expect(extractJsonObject("no braces here")).toBeNull();
	});

	test("handles escaped quotes", () => {
		const text = '{"text":"she said \\"hi\\"","x":1}';
		expect(extractJsonObject(text)).toEqual(text);
	});
});

describe("parseModeratorDecision", () => {
	test("parses a direct decision", () => {
		const text = '{"next_speaker":"ariadne","direction":"address cost","action":"direct"}';
		expect(parseModeratorDecision(text)).toEqual({
			nextSpeaker: "ariadne",
			direction: "address cost",
			action: "direct",
		});
	});

	test("parses a close decision with empty next_speaker", () => {
		const text =
			'{"next_speaker":"","direction":"converged","action":"close"}';
		expect(parseModeratorDecision(text)).toEqual({
			nextSpeaker: "",
			direction: "converged",
			action: "close",
		});
	});

	test("parses with surrounding prose", () => {
		const text = `Here is my decision: {"next_speaker":"x","direction":"y","action":"direct"}`;
		expect(parseModeratorDecision(text)?.nextSpeaker).toBe("x");
	});

	test("defaults action to direct when unrecognized", () => {
		const text = '{"next_speaker":"a","direction":"b","action":"weird"}';
		expect(parseModeratorDecision(text)?.action).toBe("direct");
	});

	test("returns null when JSON is malformed", () => {
		expect(parseModeratorDecision("nope")).toBeNull();
		expect(parseModeratorDecision("{not json}")).toBeNull();
	});
});

describe("stripControlJson", () => {
	test("removes JSON containing a known control action", () => {
		const text = `prelude {"a":1,"action":"close"} epilogue`;
		expect(stripControlJson(text)).toBe("prelude  epilogue".trim());
	});

	test("keeps the JSON when action is not a control directive", () => {
		const text = `keep {"action":"speak","x":1} this`;
		const out = stripControlJson(text);
		expect(out).toContain("speak");
	});

	test("uses caller-provided action set", () => {
		const text = `x {"action":"speak"} y`;
		expect(stripControlJson(text, new Set(["speak"]))).toBe("x  y".trim());
	});

	test("CONTROL_ACTIONS includes the chamber routing actions", () => {
		expect(CONTROL_ACTIONS.has("close")).toBe(true);
		expect(CONTROL_ACTIONS.has("direct")).toBe(true);
		expect(CONTROL_ACTIONS.has("handoff")).toBe(true);
	});
});
