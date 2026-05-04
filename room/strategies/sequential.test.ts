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

describe("SequentialStrategy", () => {
	test("invokes minds in order and feeds prior responses to later turns", async () => {
		const captured: CapturedSpawn[] = [];
		const spawn = fakeSpawn(captured, {
			ariadne: "ariadne first",
			mycroft: "mycroft second",
			scout: "scout third",
		});
		const { ctx } = makeContext("/tmp/test", spawn);
		const minds = new Map<string, MindSpec>([
			["ariadne", makeMindSpec("ariadne")],
			["mycroft", makeMindSpec("mycroft", 1)],
			["scout", makeMindSpec("scout", 2)],
		]);

		const result = await executeStrategy({
			mode: "sequential",
			userMessage: "hi",
			mindsBySlug: minds,
			participantOrder: ["ariadne", "mycroft", "scout"],
			roundHistory: [],
			context: ctx,
		});

		expect(captured.map((c) => c.slug)).toEqual([
			"ariadne",
			"mycroft",
			"scout",
		]);
		// mycroft's prompt sees ariadne's response in <chatroom-history>
		expect(captured[1].prompt).toContain("ariadne first");
		// scout's prompt sees both prior responses
		expect(captured[2].prompt).toContain("ariadne first");
		expect(captured[2].prompt).toContain("mycroft second");
		expect(result.turns).toBe(3);
	});
});
