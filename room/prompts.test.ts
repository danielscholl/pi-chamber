// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	buildConcurrentSynthesisPrompt,
	buildModeratorPrompt,
	buildOpenFloorOpenerPrompt,
	buildSpeakerPrompt,
	buildSynthesisPrompt,
	CONTROL_ACTIONS,
	extractJsonObject,
	extractTrailingJsonObject,
	parseModeratorDecision,
	parseSpeakerAddress,
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

	test("addressingEnabled appends the addressing-options trailer", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "group-chat",
			participants: ["ariadne", "mycroft", "scout"],
			userMessage: "ship?",
			history: [],
			addressingEnabled: true,
		});
		expect(out).toContain("<addressing-options>");
		expect(out).toContain('"action": "address"');
		expect(out).toContain("mycroft, scout");
		expect(out).toContain('"action": "pass"');
		expect(out).toContain('"action": "end"');
	});

	test("addressingEnabled false omits the trailer (default)", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "ariadne",
			mode: "group-chat",
			participants: ["ariadne", "mycroft"],
			userMessage: "ship?",
			history: [],
		});
		expect(out).not.toContain("<addressing-options>");
	});

	test("addressedFrom lifts the addressee block above the user message", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "mycroft",
			mode: "open-floor",
			participants: ["ariadne", "mycroft"],
			userMessage: "ship?",
			history: [],
			addressedFrom: { slug: "ariadne", reason: "push back on cost" },
		});
		expect(out).toContain('<addressed-to-you sender="ariadne"');
		expect(out).toContain("push back on cost");
		expect(out.indexOf("<addressed-to-you")).toBeLessThan(
			out.indexOf('<message sender="You">'),
		);
	});

	test("addressedFrom without reason still renders the block", () => {
		const out = buildSpeakerPrompt({
			mindSlug: "mycroft",
			mode: "open-floor",
			participants: ["ariadne", "mycroft"],
			userMessage: "ship?",
			history: [],
			addressedFrom: { slug: "ariadne" },
		});
		expect(out).toContain('<addressed-to-you sender="ariadne"/>');
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

	test("speakerSuggestion renders a hint with reason", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "chairman",
			speakers: ["ariadne", "mycroft", "scout"],
			userMessage: "ship?",
			transcript: [{ speaker: "ariadne", content: "yes", turnNumber: 1 }],
			phase: "moderate",
			spokenSlugs: new Set(["ariadne"]),
			speakerSuggestion: { slug: "mycroft", reason: "data angle" },
		});
		expect(out).toContain('<speaker-suggestion slug="mycroft" reason="data angle"/>');
		expect(out).toContain("Honor this unless that speaker has already hit the repeat cap");
	});

	test("speakerSuggestion without reason still renders", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "chairman",
			speakers: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [{ speaker: "ariadne", content: "yes", turnNumber: 1 }],
			phase: "moderate",
			spokenSlugs: new Set(["ariadne"]),
			speakerSuggestion: { slug: "mycroft" },
		});
		expect(out).toContain('<speaker-suggestion slug="mycroft"/>');
		expect(out).not.toContain("reason=");
	});

	test("absent speakerSuggestion omits the hint block", () => {
		const out = buildModeratorPrompt({
			moderatorSlug: "chairman",
			speakers: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [],
			phase: "open",
			spokenSlugs: new Set(),
		});
		expect(out).not.toContain("<speaker-suggestion");
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

describe("buildOpenFloorOpenerPrompt", () => {
	test("emits the user question and asks for a routing JSON", () => {
		const out = buildOpenFloorOpenerPrompt({
			openerSlug: "chairman",
			participants: ["ariadne", "mycroft"],
			userMessage: "should we ship?",
			history: [],
		});
		expect(out).toContain("<open-floor-open");
		expect(out).toContain("should we ship?");
		expect(out).toContain('"next_speaker"');
		expect(out).toContain('"action": "direct"');
	});

	test("renders prior-rounds when history is present", () => {
		const out = buildOpenFloorOpenerPrompt({
			openerSlug: "chairman",
			participants: ["ariadne", "mycroft"],
			userMessage: "next?",
			history: [
				{ speaker: "user", content: "earlier" },
				{ speaker: "ariadne", content: "earlier reply" },
			],
		});
		expect(out).toContain("<prior-rounds>");
		expect(out).toContain("earlier reply");
	});

	test("strips control JSON from history turns", () => {
		const out = buildOpenFloorOpenerPrompt({
			openerSlug: "chairman",
			participants: ["ariadne"],
			userMessage: "next?",
			history: [
				{
					speaker: "ariadne",
					content: 'said something {"action":"end","reason":"done"}',
				},
			],
		});
		expect(out).toContain("said something");
		expect(out).not.toContain('"action":"end"');
	});
});

describe("buildConcurrentSynthesisPrompt", () => {
	test("uses concurrent-synthesis wrapper and notes parallel takes", () => {
		const out = buildConcurrentSynthesisPrompt({
			moderatorSlug: "chairman",
			participants: ["ariadne", "mycroft"],
			userMessage: "ship?",
			transcript: [
				{ speaker: "ariadne", content: "yes" },
				{ speaker: "mycroft", content: "no" },
			],
		});
		expect(out).toContain("<concurrent-synthesis");
		expect(out).toContain("<takes>");
		expect(out).toContain("answered the same question independently");
		expect(out).toContain("chairman");
		expect(out).toContain("ariadne");
		expect(out).toContain("mycroft");
	});

	test("escapes XML-sensitive content in takes", () => {
		const out = buildConcurrentSynthesisPrompt({
			moderatorSlug: "chairman",
			participants: ["a"],
			userMessage: "test <thing>",
			transcript: [{ speaker: "a", content: "use <tag> & 'quote'" }],
		});
		expect(out).toContain("test &lt;thing&gt;");
		expect(out).toContain("&lt;tag&gt;");
		expect(out).toContain("&amp;");
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

	test("CONTROL_ACTIONS includes speaker-side addressing actions", () => {
		expect(CONTROL_ACTIONS.has("address")).toBe(true);
		expect(CONTROL_ACTIONS.has("pass")).toBe(true);
		expect(CONTROL_ACTIONS.has("end")).toBe(true);
	});

	test("stripControlJson removes speaker address tails", () => {
		const text = `My take... {"action":"address","slug":"bob","reason":"push back"}`;
		expect(stripControlJson(text)).toBe("My take...");
	});

	test("stripControlJson strips only the trailing control tail when an earlier JSON example is present", () => {
		// Speaker showed a JSON code example mid-prose, then a real control
		// tail. Only the tail should be stripped — the example is part of
		// the speaker's content and must survive.
		const text =
			'Here is the moderator format: {"action":"close"}. ' +
			'For my take: yes. ' +
			'{"action":"address","slug":"bob","reason":"why"}';
		const stripped = stripControlJson(text);
		expect(stripped).toContain('{"action":"close"}');
		expect(stripped).not.toContain('{"action":"address"');
	});
});

describe("extractTrailingJsonObject", () => {
	test("returns the last balanced top-level object", () => {
		const text =
			'before {"example":1} middle {"action":"address","slug":"bob"}';
		expect(extractTrailingJsonObject(text)).toBe(
			'{"action":"address","slug":"bob"}',
		);
	});

	test("returns the only object when there is just one", () => {
		const text = 'prelude {"action":"end"}';
		expect(extractTrailingJsonObject(text)).toBe('{"action":"end"}');
	});

	test("ignores braces inside strings", () => {
		const text = 'prose {"text":"open { brace"} {"action":"end"}';
		expect(extractTrailingJsonObject(text)).toBe('{"action":"end"}');
	});

	test("handles nested objects", () => {
		const text = 'first {"a":1} second {"outer":{"inner":"x"},"b":2}';
		expect(extractTrailingJsonObject(text)).toBe(
			'{"outer":{"inner":"x"},"b":2}',
		);
	});

	test("returns null when no object is present", () => {
		expect(extractTrailingJsonObject("no braces here")).toBeNull();
	});

	test("bails on unbalanced trailing brace rather than looping", () => {
		const text = '{"a":1} then a stray { with no close';
		// First object is balanced; second is not. Helper returns the last
		// balanced object found before the unbalanced opener.
		expect(extractTrailingJsonObject(text)).toBe('{"a":1}');
	});
});

describe("parseSpeakerAddress", () => {
	test("parses an address action with slug and reason", () => {
		const text = `prelude {"action":"address","slug":"alice","reason":"cost angle"}`;
		expect(parseSpeakerAddress(text)).toEqual({
			action: "address",
			slug: "alice",
			reason: "cost angle",
		});
	});

	test("parses a pass action", () => {
		const text = `Done. {"action":"pass","reason":"no preference"}`;
		expect(parseSpeakerAddress(text)).toEqual({
			action: "pass",
			reason: "no preference",
		});
	});

	test("parses an end action", () => {
		const text = `Wrapping up. {"action":"end","reason":"converged"}`;
		expect(parseSpeakerAddress(text)).toEqual({
			action: "end",
			reason: "converged",
		});
	});

	test("collapses address-without-slug to null", () => {
		const text = `body {"action":"address"}`;
		expect(parseSpeakerAddress(text)).toBeNull();
	});

	test("rejects unknown action", () => {
		const text = `body {"action":"nope","slug":"bob"}`;
		expect(parseSpeakerAddress(text)).toBeNull();
	});

	test("returns null when no JSON tail is present", () => {
		expect(parseSpeakerAddress("just a free-form reply")).toBeNull();
	});

	test("returns null when JSON is malformed", () => {
		expect(parseSpeakerAddress("body {not json}")).toBeNull();
	});

	test("trims whitespace from slug and reason", () => {
		const text = `body {"action":"address","slug":"  alice  ","reason":"  why  "}`;
		expect(parseSpeakerAddress(text)).toEqual({
			action: "address",
			slug: "alice",
			reason: "why",
		});
	});

	test("parses the trailing tail when an earlier JSON example appears in prose", () => {
		const text =
			'Here is what JSON looks like: {"example":42}. ' +
			'My take is X. ' +
			'{"action":"address","slug":"bob","reason":"data angle"}';
		expect(parseSpeakerAddress(text)).toEqual({
			action: "address",
			slug: "bob",
			reason: "data angle",
		});
	});

	test("ignores a non-control trailing object even with prose-front content", () => {
		const text =
			'Some thoughts. {"random":"object","action":"unknown"}';
		expect(parseSpeakerAddress(text)).toBeNull();
	});
});
