// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	findGenesisStarterByName,
	findGenesisStarterBySlug,
	GENESIS_STARTERS,
	JARVIS_STARTER,
	MISS_MONEYPENNY_STARTER,
	MYCROFT_STARTER,
} from "./starters.ts";

describe("Genesis starters", () => {
	test("exposes built-in starter metadata for the generative Genesis flow", () => {
		expect(GENESIS_STARTERS.map((starter) => starter.slug)).toEqual([
			"moneypenny",
			"mycroft",
			"jarvis",
		]);

		expect(MISS_MONEYPENNY_STARTER).toEqual(
			expect.objectContaining({
				name: "Miss Moneypenny",
				slug: "moneypenny",
				role: "Chief of Staff",
				voice: "Miss Moneypenny",
			}),
		);
		expect(MYCROFT_STARTER).toEqual(
			expect.objectContaining({
				name: "Mycroft",
				slug: "mycroft",
				role: "Research Partner",
				voice: "Mycroft Holmes",
			}),
		);
		expect(JARVIS_STARTER).toEqual(
			expect.objectContaining({
				name: "Jarvis",
				slug: "jarvis",
				role: "Engineering Partner",
				voice: "J.A.R.V.I.S. (Stark Industries)",
			}),
		);
	});

	test("starter voice descriptions ask for fresh authored artifacts", () => {
		for (const starter of GENESIS_STARTERS) {
			expect(starter.description).toContain("Generative");
			expect(starter.voiceDescription).toContain("Research");
			expect(starter.voiceDescription).toContain(
				"Do not copy a prebaked template",
			);
			expect(starter.voiceDescription).toContain(
				"author fresh Genesis artifacts",
			);
		}
	});

	test("each starter exposes a short identity-forward tagline for command hints", () => {
		for (const starter of GENESIS_STARTERS) {
			expect(starter.tagline).toBeTruthy();
			expect(starter.tagline.length).toBeLessThanOrEqual(72);
			expect(starter.tagline).not.toContain("Generative");
			expect(starter.tagline).not.toContain("preset");
		}
	});

	test("finds starters by display name or slug", () => {
		expect(findGenesisStarterByName("Mycroft")?.slug).toBe("mycroft");
		expect(findGenesisStarterBySlug("jarvis")?.name).toBe("Jarvis");
		expect(findGenesisStarterBySlug("missing")).toBeUndefined();
	});
});
