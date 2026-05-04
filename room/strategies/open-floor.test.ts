// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	type CapturedSpawn,
	fakeSpawn,
	makeContext,
	makeMindSpec,
} from "./_test-helpers.ts";
import { executeStrategy, type MindSpec, type SpawnFn } from "./index.ts";

describe("OpenFloorStrategy", () => {
	test("speakers route via address; addressed mind sees an <addressed-to-you> block", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne:
				'I think A. {"action":"address","slug":"mycroft","reason":"data angle"}',
			mycroft: 'I disagree. {"action":"end","reason":"converged"}',
			scout: "scout view",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "should we ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// First speaker is participantOrder[0] (no opener) → ariadne, then
		// ariadne addresses mycroft, mycroft votes end. Two speakers spoke.
		expect(captured[0].slug).toBe("ariadne");
		expect(captured[1].slug).toBe("mycroft");
		expect(captured[1].prompt).toContain('<addressed-to-you sender="ariadne"');
		expect(captured[1].prompt).toContain("data angle");
		// All speakers get the addressing trailer in open-floor.
		expect(captured[0].prompt).toContain("<addressing-options>");
		expect(captured[1].prompt).toContain("<addressing-options>");
		// End vote with 1/3 below 0.5 threshold doesn't close. But minRounds=1
		// and only ariadne+mycroft have spoken; scout still pending. So loop
		// continues until end-vote ratio meets threshold or maxTurns hits.
		// Result transcript captures speakers' turns.
		expect(result.turns).toBeGreaterThanOrEqual(2);
		expect(events.filter((e) => e.type === "round-metrics").length).toBe(1);
	});

	test("end-vote tie at default 0.5 threshold does NOT close (strict majority)", async () => {
		const captured: CapturedSpawn[] = [];
		// In a 2-speaker room, ariadne votes end and mycroft does not. Ratio
		// is 1/2 = 0.5, exactly the default threshold. With strict-`>`
		// semantics, this must not close — the loop continues until maxTurns
		// or a real majority emerges.
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: "M without an end vote",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 5,
				endVoteThreshold: 0.5,
			},
		});

		// 4 turns must run (loop never short-circuited on the tie).
		expect(result.turns).toBe(4);
	});

	test("end-vote majority closes once minRounds is met", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'B. {"action":"end","reason":"agreed"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "should we ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 8,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Both speakers vote end after each speaks once: 2/2 = 1.0 ≥ 0.5,
		// minRounds=1 met, loop closes.
		expect(result.turns).toBe(2);
		expect(captured.map((c) => c.slug)).toEqual(["ariadne", "mycroft"]);
	});

	test("self-address falls back to least-spoken with a warning", async () => {
		const captured: CapturedSpawn[] = [];
		const warnings: string[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"ariadne","reason":"more time"}',
			mycroft: 'B. {"action":"end","reason":"done"}',
			scout: 'C. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		ctx.notifyWarning = (m) => warnings.push(m);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// ariadne self-addresses; warning fires. Next speaker is least-spoken
		// (mycroft or scout, both at 0). mycroft's mock response also votes end;
		// scout's vote brings the ratio to 2/3 ≥ 0.5 and the loop closes.
		expect(warnings.some((w) => w.includes("addressed themselves"))).toBe(true);
		expect(captured[0].slug).toBe("ariadne");
		expect(["mycroft", "scout"]).toContain(captured[1].slug);
	});

	test("unknown slug falls back to least-spoken with a warning", async () => {
		const captured: CapturedSpawn[] = [];
		const warnings: string[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"ghost","reason":"absent"}',
			mycroft: 'B. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		ctx.notifyWarning = (m) => warnings.push(m);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(warnings.some((w) => w.includes('unknown slug "ghost"'))).toBe(
			true,
		);
		// After the warning, mycroft (least-spoken, count=0) speaks next.
		expect(captured[1].slug).toBe("mycroft");
	});

	test("maxTurns hard cap terminates an unending address loop", async () => {
		const captured: CapturedSpawn[] = [];
		// ariadne and mycroft ping-pong via address; nobody votes end.
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"mycroft","reason":"keep going"}',
			mycroft:
				'B. {"action":"address","slug":"ariadne","reason":"keep going"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 3,
				minRounds: 1,
				// High repeat cap so the address ping-pong is honored, not
				// rerouted to least-spoken before maxTurns lands.
				maxSpeakerRepeats: 5,
				endVoteThreshold: 0.5,
			},
		});

		expect(result.turns).toBe(3);
	});

	test("repeat cap reroutes address to least-spoken with a warning", async () => {
		const captured: CapturedSpawn[] = [];
		const warnings: string[] = [];
		// ariadne addresses mycroft; mycroft addresses ariadne (already at cap).
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A1. {"action":"address","slug":"mycroft","reason":"first"}',
			mycroft:
				'B. {"action":"address","slug":"ariadne","reason":"loop back"}',
			scout: 'C. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		ctx.notifyWarning = (m) => warnings.push(m);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				// With cap=1, ariadne hits the cap after their first turn.
				// mycroft tries to address ariadne back, but ariadne is at cap,
				// so the routing falls back to least-spoken (scout).
				maxTurns: 5,
				minRounds: 1,
				maxSpeakerRepeats: 1,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured[0].slug).toBe("ariadne");
		expect(captured[1].slug).toBe("mycroft");
		expect(warnings.some((w) => w.includes("repeat cap"))).toBe(true);
		// The third speaker is scout (least-spoken, count=0) instead of ariadne.
		expect(captured[2].slug).toBe("scout");
	});

	test("opener picks the first speaker before the loop runs", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			chairman:
				'{"next_speaker":"mycroft","direction":"start with cost","action":"direct"}',
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["chairman", makeMindSpec("chairman", 4)],
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			openerSlug: "chairman",
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// First captured is chairman (opener); first visible speaker is mycroft
		// (the opener's pick), not the participantOrder default ariadne.
		expect(captured[0].slug).toBe("chairman");
		expect(captured[0].prompt).toContain("<open-floor-open");
		const speakerSpawns = captured.filter((c) => c.slug !== "chairman");
		expect(speakerSpawns[0].slug).toBe("mycroft");
		const openEvents = events.filter(
			(e) => e.type === "moderator-decision" && (e as { action: string }).action === "open",
		);
		expect(openEvents.length).toBe(1);
	});

	test("synthesisConfig appends a synthesizer turn after close", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
			chairman: "summary",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["chairman", makeMindSpec("chairman", 4)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			synthesisConfig: { mode: "chairman" },
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Last captured spawn is chairman (synthesis), with the synthesis prompt.
		const last = captured[captured.length - 1];
		expect(last.slug).toBe("chairman");
		expect(last.prompt).toContain("<group-chat-synthesis");
		// Transcript ends with a moderator-flagged turn.
		const finalTurn = result.transcript[result.transcript.length - 1];
		expect(finalTurn.speaker).toBe("chairman");
		expect(finalTurn.isModerator).toBe(true);
	});

	test("/inject preserves a peer-to-peer address (provenance bug regression)", async () => {
		const captured: CapturedSpawn[] = [];
		// ariadne addresses mycroft on turn 1. Before turn 2 fires, the
		// director uses /inject. The next speaker (mycroft) must still see
		// ariadne as the addresser; the director note belongs in the
		// moderator-direction channel, not in addressedFrom.reason.
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"mycroft","reason":"data angle"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		// The override is consumed once, on the iteration that picks mycroft.
		// In open-floor, consumeDirectorOverrides runs at the top of EACH
		// iteration. Iteration 0 (ariadne) sees no override; iteration 1
		// (mycroft) sees it.
		let injectionsConsumed = 0;
		ctx.consumeDirectorOverrides = () => {
			if (injectionsConsumed === 0) {
				injectionsConsumed += 1;
				return undefined; // first iteration: no override
			}
			if (injectionsConsumed === 1) {
				injectionsConsumed += 1;
				return { directionInjection: "DIRECTOR-NOTE" };
			}
			return undefined;
		};
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		const mycroftPrompt = captured.find((c) => c.slug === "mycroft")?.prompt ?? "";
		// addressedFrom retained the real peer (ariadne), not "director".
		expect(mycroftPrompt).toContain('<addressed-to-you sender="ariadne"');
		expect(mycroftPrompt).not.toContain('<addressed-to-you sender="director"');
		// The original peer's reason survived.
		expect(mycroftPrompt).toContain("data angle");
		// The director's note went into moderator-direction.
		expect(mycroftPrompt).toContain("DIRECTOR-NOTE");
		expect(mycroftPrompt).toContain("<moderator-direction>");
	});

	test("/inject without a peer address still appears prominently as director", async () => {
		const captured: CapturedSpawn[] = [];
		// No prior speaker addresses anyone; the director's /inject becomes
		// the prominent addressed-to-you payload (current behavior preserved
		// for the unaddressed path).
		const spawn = fakeSpawn(captured, {
			ariadne: "no address tail",
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { directionInjection: "DIRECTOR-NOTE" };
		};
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 2,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		const ariadnePrompt = captured.find((c) => c.slug === "ariadne")?.prompt ?? "";
		expect(ariadnePrompt).toContain('<addressed-to-you sender="director"');
		expect(ariadnePrompt).toContain("DIRECTOR-NOTE");
	});

	test("director /next override redirects the next speaker once", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"address","slug":"mycroft","reason":"data"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
			scout: 'S. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		let consumed = false;
		ctx.consumeDirectorOverrides = () => {
			if (consumed) return undefined;
			consumed = true;
			return { nextSpeaker: "scout" };
		};
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Director override fires on iteration 0: scout speaks first instead
		// of participantOrder[0] (ariadne).
		expect(captured[0].slug).toBe("scout");
		expect(consumed).toBe(true);
	});

	test("single intent: closes after the lead's turn when they don't hand off", async () => {
		const captured: CapturedSpawn[] = [];
		// Operator addresses ariadne; her reply has no JSON tail. Without the
		// single-intent close, the leastSpoken fallback would force mycroft to
		// take a turn — exactly the unwanted "Jarvis chimed in" behavior.
		const spawn = fakeSpawn(captured, {
			ariadne: "the weather is fine.",
			mycroft: "should not run",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ariadne, what's the weather?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual(["ariadne"]);
		expect(result.turns).toBe(1);
		// The routed-audit line surfaces the single intent at round start.
		const openDecision = events.find(
			(e) => e.type === "moderator-decision" && (e as { action: string }).action === "open",
		) as { direction?: string } | undefined;
		expect(openDecision?.direction).toBe("Routed: single → ariadne.");
	});

	test("single intent: lead's explicit address continues into a normal handoff", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"mycroft","reason":"his domain"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "ariadne, what should we do?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Lead handed off explicitly → mycroft sees the addressed-to-you block
		// with the lead's reason, then closes via end vote.
		expect(captured.map((c) => c.slug)).toEqual(["ariadne", "mycroft"]);
		expect(captured[1].prompt).toContain('<addressed-to-you sender="ariadne"');
		expect(captured[1].prompt).toContain("his domain");
	});

	test("chain intent: drains the operator-named queue with addressed-to-you framing", async () => {
		const captured: CapturedSpawn[] = [];
		// "ariadne, update mycroft" — ariadne is the lead, mycroft is queued.
		// Neither emits a JSON tail; without chain-drain, scout (least-spoken)
		// would be pulled in instead of mycroft.
		const spawn = fakeSpawn(captured, {
			ariadne: "here's the update on the QA project.",
			mycroft: "got it, will follow up.",
			scout: "should not run",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ariadne, update mycroft on the project",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual(["ariadne", "mycroft"]);
		expect(result.turns).toBe(2);
		// mycroft's prompt frames the handoff via the just-finished speaker
		// (ariadne) but without a peer-supplied reason — the operator's intent
		// is already in the user-message block.
		expect(captured[1].prompt).toContain('<addressed-to-you sender="ariadne"/>');
		// The opener-decision audit reports the full chain.
		const openDecision = events.find(
			(e) => e.type === "moderator-decision" && (e as { action: string }).action === "open",
		) as { direction?: string } | undefined;
		expect(openDecision?.direction).toBe(
			"Routed: chain → ariadne → mycroft.",
		);
		// And the chain-drain handoff is itself audited.
		const chainHandoff = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { direction?: string }).direction === "operator-named chain",
		) as { nextSpeaker?: string } | undefined;
		expect(chainHandoff?.nextSpeaker).toBe("mycroft");
	});

	test("chain intent: an end vote on any turn closes the round immediately", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"resolved before brief"}',
			mycroft: "should not run",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ariadne, brief mycroft",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			// minRounds=2 would normally require both speakers to be heard
			// before any end vote could close. Chain intent bypasses that
			// gate so the lead's "we're done" actually ends the round.
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 2,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual(["ariadne"]);
		expect(result.turns).toBe(1);
	});

	test("chain intent: explicit handoff interleaves with the queue, not replaces it", async () => {
		const captured: CapturedSpawn[] = [];
		// "ariadne, update mycroft" with ariadne re-routing to scout first.
		// Expected order: ariadne (lead) → scout (explicit) → mycroft (queued).
		const spawn = fakeSpawn(captured, {
			ariadne:
				'A. {"action":"address","slug":"scout","reason":"data first"}',
			scout: "data update.",
			mycroft: "thanks, end.",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ariadne, update mycroft on QA",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual([
			"ariadne",
			"scout",
			"mycroft",
		]);
		expect(result.turns).toBe(3);
		// Scout sees ariadne's reason (peer address); mycroft sees scout
		// (chain handoff, no peer reason).
		const scoutPrompt = captured[1].prompt;
		const mycroftPrompt = captured[2].prompt;
		expect(scoutPrompt).toContain('<addressed-to-you sender="ariadne"');
		expect(scoutPrompt).toContain("data first");
		expect(mycroftPrompt).toContain('<addressed-to-you sender="scout"/>');
	});

	test("sticky single: blank follow-up inherits the prior addressed mind", async () => {
		const captured: CapturedSpawn[] = [];
		// Operator addressed ariadne in round 1; this round is the natural
		// follow-up "what are your responsibilities?" with no slug. Without
		// stickiness, leastSpoken would pull mycroft in first.
		const spawn = fakeSpawn(captured, {
			ariadne: "I keep the workspace operationally sane.",
			mycroft: "should not run",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "what are your responsibilities?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, can you introduce yourself?" },
				{ speaker: "ariadne", content: "At your service." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual(["ariadne"]);
		expect(result.turns).toBe(1);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		) as { direction?: string } | undefined;
		// Audit line tags the inheritance so the operator can see that the
		// system inferred a continuation rather than picked it from the
		// current message.
		expect(openDecision?.direction).toBe(
			"Routed: single → ariadne (continued).",
		);
	});

	test("sticky chain: blank follow-up inherits the prior chain", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "still no anomalies on my side.",
			mycroft: "data still looks clean.",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "anything new since?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, brief mycroft on the QA work" },
				{ speaker: "ariadne", content: "..." },
				{ speaker: "mycroft", content: "..." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Chain rebuilds: ariadne first, then mycroft drained from queue.
		// scout (uninvolved in the prior round) does not get pulled in.
		expect(captured.map((c) => c.slug)).toEqual(["ariadne", "mycroft"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		) as { direction?: string } | undefined;
		expect(openDecision?.direction).toBe(
			"Routed: chain → ariadne → mycroft (continued).",
		);
	});

	test("explicit broadcast token in current message overrides prior single", async () => {
		const captured: CapturedSpawn[] = [];
		// Prior round was single-ariadne. Current opens "team, …" — explicit
		// broadcast token must break stickiness even though there are no
		// slugs in the current message.
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "team, what's the status",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, status?" },
				{ speaker: "ariadne", content: "..." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Both speakers run (broadcast loop), and there's no "open" decision
		// emitted because no userLead and no explicit openerSlug.
		expect(captured.map((c) => c.slug).sort()).toEqual(["ariadne", "mycroft"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		);
		expect(openDecision).toBeUndefined();
	});

	test("naming a new slug overrides a sticky lead from the prior round", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			mycroft: "here's the engineering view.",
			ariadne: "should not run",
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "mycroft, your turn — what do you think?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, what's the weather?" },
				{ speaker: "ariadne", content: "Fine." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Current message names mycroft → fresh single intent, no inheritance.
		expect(captured.map((c) => c.slug)).toEqual(["mycroft"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		) as { direction?: string } | undefined;
		// Tag is plain — no "(continued)" — because the current message
		// itself named the lead.
		expect(openDecision?.direction).toBe("Routed: single → mycroft.");
	});

	test("transitive stickiness reaches through a blank intermediate round", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "still nothing to add.",
			mycroft: "should not run",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		// History shows: round 1 targeted ariadne, round 2 was a blank
		// follow-up (which would have inherited via this same rule). Round 3
		// (current) is also blank — must walk back through round 2 to find
		// round 1's mention.
		await executeStrategy({
			mode: "open-floor",
			userMessage: "and now?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, what's the weather?" },
				{ speaker: "ariadne", content: "Fine." },
				{ speaker: "user", content: "what about tomorrow?" },
				{ speaker: "ariadne", content: "Cloudy." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 6,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		expect(captured.map((c) => c.slug)).toEqual(["ariadne"]);
	});

	test("mid-sentence 'you all' overrides prior-single stickiness", async () => {
		const captured: CapturedSpawn[] = [];
		// The motivating real-world case: prior round targeted ariadne; this
		// round opens with a follow-up that asks the *room* to discuss. The
		// "you all" phrase fires explicit-broadcast and breaks stickiness,
		// even though it's mid-sentence rather than a leading "team,".
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage:
				"okay I'd like for you all to discuss our project and ensure your understanding is the same.",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, do you understand jarvis's role?" },
				{ speaker: "ariadne", content: "Yes — engineering partner." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Broadcast loop: both speakers run, no "Routed: single (continued)"
		// audit because explicit broadcast won over stickiness.
		expect(captured.map((c) => c.slug).sort()).toEqual(["ariadne", "mycroft"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		);
		expect(openDecision).toBeUndefined();
	});

	test("@<slug> direct-address rounds in history do not establish stickiness (regression)", async () => {
		const captured: CapturedSpawn[] = [];
		// Codex review caught this: a prior @jarvis round persists as
		// "@jarvis …" in transcript, and the inheritance path was reading
		// it back as a sticky single target on the next open-floor turn —
		// turning the documented one-shot bypass into multi-turn routing.
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			jarvis: 'J. {"action":"end","reason":"done"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["jarvis", makeMindSpec("jarvis", 1)],
		]);

		await executeStrategy({
			mode: "open-floor",
			userMessage: "what about the risks?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "jarvis"],
			roundHistory: [
				{ speaker: "user", content: "@jarvis quick question" },
				{ speaker: "jarvis", content: "Answer." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Broadcast intent: both speakers run, no "open" decision because the
		// @-bypass round was skipped during the inheritance walk.
		expect(captured.map((c) => c.slug).sort()).toEqual(["ariadne", "jarvis"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		);
		expect(openDecision).toBeUndefined();
	});

	test("explicit broadcast in history resets stickiness for subsequent blanks", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: 'A. {"action":"end","reason":"done"}',
			mycroft: 'M. {"action":"end","reason":"done"}',
		});
		const { ctx, events } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		// History: round 1 targeted ariadne, round 2 was an explicit broadcast
		// ("everyone, …"). Round 3 (current) is blank. The walk must stop at
		// round 2's broadcast and NOT inherit ariadne from round 1.
		await executeStrategy({
			mode: "open-floor",
			userMessage: "follow-up?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [
				{ speaker: "user", content: "ariadne, status?" },
				{ speaker: "ariadne", content: "Fine." },
				{ speaker: "user", content: "everyone, what's next?" },
				{ speaker: "ariadne", content: "..." },
				{ speaker: "mycroft", content: "..." },
			],
			context: ctx,
			openFloorConfig: {
				maxTurns: 4,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Broadcast intent: both speakers run, no "open" decision.
		expect(captured.map((c) => c.slug).sort()).toEqual(["ariadne", "mycroft"]);
		const openDecision = events.find(
			(e) =>
				e.type === "moderator-decision" &&
				(e as { action: string }).action === "open",
		);
		expect(openDecision).toBeUndefined();
	});

	test("aborts cleanly partway through a round", async () => {
		const captured: CapturedSpawn[] = [];
		const ac = new AbortController();
		const spawn: SpawnFn = async (req) => {
			captured.push({
				slug: req.slug,
				prompt: req.prompt,
				cwd: req.cwd,
				hasModeratorDirection: req.prompt.includes("moderator-direction"),
				model: req.model,
				fallbackModels: req.fallbackModels,
				tools: req.tools,
				hasOnAttemptStart: typeof req.onAttemptStart === "function",
			});
			// Abort just after ariadne's first turn so the loop's pre-iteration
			// signal check exits the loop before mycroft is asked.
			if (req.slug === "ariadne") ac.abort();
			return {
				exitCode: 0,
				finalText: 'A. {"action":"address","slug":"mycroft","reason":"more"}',
				messages: [],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					contextTokens: 0,
					turns: 1,
				},
				stderr: "",
				model: "test-model",
				aborted: false,
				durationMs: 1,
			};
		};
		const { ctx } = makeContext("/tmp/test", spawn, ac.signal);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
		]);

		const result = await executeStrategy({
			mode: "open-floor",
			userMessage: "ship?",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft"],
			roundHistory: [],
			context: ctx,
			openFloorConfig: {
				maxTurns: 5,
				minRounds: 1,
				maxSpeakerRepeats: 2,
				endVoteThreshold: 0.5,
			},
		});

		// Only ariadne ran — abort prevented mycroft from being addressed.
		expect(captured.map((c) => c.slug)).toEqual(["ariadne"]);
		expect(result.turns).toBe(1);
	});
});
