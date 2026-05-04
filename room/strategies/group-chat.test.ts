// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	type CapturedSpawn,
	fakeSpawn,
	makeContext,
	makeMindSpec,
} from "./_test-helpers.ts";
import { executeStrategy, type MindSpec } from "./index.ts";

describe("GroupChatStrategy", () => {
	test("opens with a moderator decision then routes to the picked speaker", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"address cost","action":"close"}',
			ariadne: "ariadne speaks",
			mycroft: "mycroft speaks",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
			},
		});

		// First spawn is moderator (open), then ariadne, then moderator may_close.
		expect(captured[0].slug).toBe("jarvis");
		expect(captured[0].prompt).toContain('phase="open"');
		expect(captured[1].slug).toBe("ariadne");
		expect(captured[1].hasModeratorDirection).toBe(true);

		const moderatorEvents = events.filter(
			(e) => e.type === "moderator-decision",
		);
		expect(moderatorEvents.length).toBeGreaterThanOrEqual(2);
		expect(moderatorEvents[0].action).toBe("open");
	});

	test("consumeDirectorOverrides redirects the next speaker", async () => {
		const captured: CapturedSpawn[] = [];
		// Moderator picks ariadne first, then closes after one speaker turn.
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"discuss cost","action":"close"}',
			ariadne: "ariadne replies",
			mycroft: "mycroft replies",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		// Override: redirect to mycroft on the next speaker pick.
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { nextSpeaker: "mycroft" };
		};
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
			},
		});

		// First speaker after the open should be mycroft (override) rather than ariadne (moderator pick).
		const speakerSpawns = captured.filter((c) => c.slug !== "jarvis");
		expect(speakerSpawns[0]?.slug).toBe("mycroft");
		// Override should have been consumed exactly once.
		expect(consumed).toBe(true);
		void events;
	});

	test("consumeDirectorOverrides directionInjection prepends to the speaker prompt", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"original","action":"close"}',
			ariadne: "thoughts",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { directionInjection: "DIRECTOR-NOTE" };
		};
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "go",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
		});

		const speakerCall = captured.find((c) => c.slug === "ariadne");
		expect(speakerCall?.prompt).toContain("DIRECTOR-NOTE");
	});

	test("speakerAddressing: speaker tail surfaces as <speaker-suggestion> on next moderator prompt", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"direct"}',
			ariadne:
				'My take is X. {"action":"address","slug":"mycroft","reason":"data angle"}',
			mycroft: "mycroft replies",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 1, minRounds: 1, maxSpeakerRepeats: 2 },
			speakerAddressing: true,
		});

		// captured: [jarvis-open, ariadne-speaker, jarvis-moderate]
		expect(captured[0].slug).toBe("jarvis");
		expect(captured[1].slug).toBe("ariadne");
		expect(captured[1].prompt).toContain("<addressing-options>");
		expect(captured[2].slug).toBe("jarvis");
		expect(captured[2].prompt).toContain(
			'<speaker-suggestion slug="mycroft" reason="data angle"/>',
		);
	});

	test("speakerAddressing trailer omits the moderator slug from the addressable peers", async () => {
		const captured: CapturedSpawn[] = [];
		// The room uses a participant slug (alice) as moderator/synthesizer.
		// `participantOrder` includes alice; `speakers` does not. The trailer
		// must list ONLY the speakers minus self — never the moderator —
		// because findSpeaker() in the strategy will discard a tail naming
		// the moderator as "unknown" and silently fail to route.
		const spawn = fakeSpawn(captured, {
			alice:
				'{"next_speaker":"bob","direction":"go","action":"direct"}',
			bob: 'B. {"action":"address","slug":"carol","reason":"why"}',
			carol: "C",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["alice", makeMindSpec("alice")],
			["bob", makeMindSpec("bob", 1)],
			["carol", makeMindSpec("carol", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["alice", "bob", "carol"],
			moderatorSlug: "alice",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 1, minRounds: 1, maxSpeakerRepeats: 2 },
			speakerAddressing: true,
		});

		// captured: [alice-open, bob-speaker, alice-moderate]
		const bobPrompt = captured[1].prompt;
		// Trailer SHOULD include the other speaker (carol) and NOT the
		// moderator (alice).
		expect(bobPrompt).toContain("<addressing-options>");
		// `<one of: ...>` is the placeholder line in the trailer; it must
		// list carol but not alice.
		const trailerMatch = bobPrompt.match(/<one of: ([^>]+)>/);
		expect(trailerMatch).not.toBeNull();
		const advertised = trailerMatch?.[1] ?? "";
		expect(advertised).toContain("carol");
		expect(advertised).not.toContain("alice");
	});

	test("speakerAddressing off: addressing-options trailer is omitted", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"direct"}',
			ariadne: "plain reply",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 1, minRounds: 1, maxSpeakerRepeats: 2 },
		});

		const ariadne = captured.find((c) => c.slug === "ariadne");
		expect(ariadne?.prompt).not.toContain("<addressing-options>");
	});

	test("speakerAddressing: self-address is rejected (no suggestion forwarded)", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"direct"}',
			ariadne:
				'My take. {"action":"address","slug":"ariadne","reason":"keep going"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 1, minRounds: 1, maxSpeakerRepeats: 2 },
			speakerAddressing: true,
		});

		const moderatePrompt = captured[2]?.prompt ?? "";
		expect(moderatePrompt).not.toContain("<speaker-suggestion");
	});

	test("speakerAddressing: unknown slug is rejected (no suggestion forwarded)", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"direct"}',
			ariadne:
				'My take. {"action":"address","slug":"ghost","reason":"absent"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
			["mycroft", makeMindSpec("mycroft", 2)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne", "mycroft"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 1, minRounds: 1, maxSpeakerRepeats: 2 },
			speakerAddressing: true,
		});

		const moderatePrompt = captured[2]?.prompt ?? "";
		expect(moderatePrompt).not.toContain("<speaker-suggestion");
	});

	test("speakerAddressing: end vote after canClose triggers synthesis without spending a moderator deliberation", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"direct"}',
			ariadne: 'Take. {"action":"end","reason":"converged"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
			groupChatConfig: { maxTurns: 4, minRounds: 1, maxSpeakerRepeats: 2 },
			speakerAddressing: true,
		});

		// captured order with end-vote shortcut: [jarvis-open, ariadne-speaker, jarvis-synthesis]
		// (the per-iteration moderate/may_close call is skipped)
		const slugs = captured.map((c) => c.slug);
		expect(slugs).toEqual(["jarvis", "ariadne", "jarvis"]);
		// The third spawn is the synthesizer prompt, not a moderator deliberation prompt.
		expect(captured[2].prompt).toContain("<group-chat-synthesis");
		// The emitted moderator-decision event reflects the close action.
		const closeEvents = events.filter(
			(e) => e.type === "moderator-decision" && (e as { action: string }).action === "close",
		);
		expect(closeEvents.length).toBeGreaterThanOrEqual(1);
	});

	test("does not emit mind-start for hidden moderator deliberation", async () => {
		const captured: CapturedSpawn[] = [];
		// Moderator emits close on the second decision, ending the loop quickly.
		const spawn = fakeSpawn(captured, {
			jarvis:
				'{"next_speaker":"ariadne","direction":"go","action":"close"}',
			ariadne: "thoughts",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["jarvis", makeMindSpec("jarvis")],
			["ariadne", makeMindSpec("ariadne", 1)],
		]);

		await executeStrategy({
			mode: "group-chat",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["jarvis", "ariadne"],
			moderatorSlug: "jarvis",
			roundHistory: [],
			context: ctx,
		});

		// Visible mind-start events should be for speaker (ariadne) and synthesis (jarvis).
		const startSlugs = events
			.filter((e) => e.type === "mind-start")
			.map((e) => (e as { slug: string }).slug);
		const moderatorAsRouter = startSlugs.filter((s) => s === "jarvis").length;
		// 1 entry for synthesis (after close); the moderator's open and decide passes are silent.
		expect(moderatorAsRouter).toBeLessThanOrEqual(1);
	});
});
