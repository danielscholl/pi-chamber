// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import {
	type AssembleProposal,
	buildAssembleProposalPrompt,
	parseAssembleProposalJson,
} from "./prompts.ts";
import type { RepoSignals } from "./signals.ts";

function makeSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
	return {
		topLevelDirs: [],
		existingMinds: [],
		...overrides,
	};
}

describe("buildAssembleProposalPrompt", () => {
	test("includes user description, signals block, and JSON schema scaffolding", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals({
				description: "Building a CLI for X",
				readme: { path: "README.md", content: "# Project\n\nIt does X.", truncated: false },
				topLevelDirs: ["src", "tests"],
			}),
		});
		expect(prompt).toContain("casting coordinator for pi-chamber");
		expect(prompt).toContain("Building a CLI for X");
		expect(prompt).toContain("README.md");
		expect(prompt).toContain("# Project");
		expect(prompt).toContain("top-level dirs: src, tests");
		expect(prompt).toContain('"team_slug": "kebab-case slug');
		expect(prompt).toContain("Pick a fictional universe");
	});

	test("surfaces existing minds so the model excludes them", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals({
				existingMinds: [
					{ slug: "moneypenny", soulFirstLine: "# Miss Moneypenny" },
					{ slug: "mycroft" },
				],
			}),
		});
		expect(prompt).toContain("DO NOT propose duplicates");
		expect(prompt).toContain("- moneypenny — # Miss Moneypenny");
		expect(prompt).toContain("- mycroft");
	});

	test("size override pins the count", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
			sizeOverride: 4,
		});
		expect(prompt).toContain("Propose exactly 4 members");
	});

	test("universe override pins the universe", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
			universeOverride: "Heat",
		});
		expect(prompt).toContain(
			"Use this fictional universe for naming the team members: Heat",
		);
	});

	test("defaultTeamSlug emits a 'use this slug' constraint line", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
			defaultTeamSlug: "assembly",
		});
		expect(prompt).toContain('Use "assembly" as the team_slug');
	});

	test("absent defaultTeamSlug emits no constraint line", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
		});
		expect(prompt).not.toContain('Use "assembly" as the team_slug');
		expect(prompt).not.toContain("as the team_slug if it makes sense");
	});

	test("--no-universe instructs literal naming", () => {
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
			noUniverse: true,
		});
		expect(prompt).toContain("Do NOT use fictional names");
		expect(prompt).toContain('Set "universe" to "literal"');
	});

	test("regenerate variant carries feedback and previous proposal", () => {
		const previous: AssembleProposal = {
			project: "X",
			team_slug: "alpha-team",
			team_name: "Alpha",
			universe: "Heat",
			rationale: "because",
			members: [
				{
					name: "Neil",
					slug: "neil",
					role: "lead",
					voice: "steady",
					voiceDescription: "calm pragmatist",
					rationale: "led the crew",
				},
			],
		};
		const prompt = buildAssembleProposalPrompt({
			signals: makeSignals(),
			feedback: "too engineering-heavy",
			previousProposal: previous,
		});
		expect(prompt).toContain("REGENERATE NOTES");
		expect(prompt).toContain('User feedback on the previous proposal: "too engineering-heavy"');
		expect(prompt).toContain("Previous proposal (do not repeat)");
		expect(prompt).toContain("alpha-team");
	});
});

describe("parseAssembleProposalJson", () => {
	const validProposal: AssembleProposal = {
		project: "A CLI for X",
		team_slug: "x-team",
		team_name: "X Team",
		universe: "Heat",
		rationale: "covers the gap",
		members: [
			{
				name: "Neil McCauley",
				slug: "neil",
				role: "lead",
				voice: "steady",
				voiceDescription: "calm strategist",
				rationale: "runs point",
			},
			{
				name: "Chris Shiherlis",
				slug: "chris",
				role: "executor",
				voice: "sharp",
				voiceDescription: "fast hands",
				rationale: "ships work",
			},
		],
	};

	test("parses raw JSON", () => {
		const text = JSON.stringify(validProposal);
		const parsed = parseAssembleProposalJson(text);
		expect(parsed.team_slug).toBe("x-team");
		expect(parsed.members).toHaveLength(2);
	});

	test("parses fenced JSON", () => {
		const text = `Some prose.\n\`\`\`json\n${JSON.stringify(validProposal)}\n\`\`\`\nMore prose.`;
		const parsed = parseAssembleProposalJson(text);
		expect(parsed.team_slug).toBe("x-team");
	});

	test("parses braced JSON embedded in prose", () => {
		const text = `Sure! Here's the proposal: ${JSON.stringify(validProposal)} Hope this helps.`;
		const parsed = parseAssembleProposalJson(text);
		expect(parsed.team_slug).toBe("x-team");
	});

	test("rejects empty input", () => {
		expect(() => parseAssembleProposalJson("")).toThrow(
			/did not contain a JSON object/,
		);
	});

	test("rejects missing required fields", () => {
		const broken = { ...validProposal } as Record<string, unknown>;
		delete broken.team_slug;
		expect(() => parseAssembleProposalJson(JSON.stringify(broken))).toThrow(
			/team_slug/,
		);
	});

	test("rejects non-canonical slugs", () => {
		const broken = {
			...validProposal,
			team_slug: "NotA_Slug",
		};
		expect(() => parseAssembleProposalJson(JSON.stringify(broken))).toThrow(
			/canonical kebab-case slug/,
		);
	});

	test("rejects empty members array", () => {
		const broken = { ...validProposal, members: [] };
		expect(() => parseAssembleProposalJson(JSON.stringify(broken))).toThrow(
			/non-empty/,
		);
	});

	test("rejects duplicate slugs within proposal", () => {
		const broken = {
			...validProposal,
			members: [
				validProposal.members[0],
				{ ...validProposal.members[1], slug: "neil" },
			],
		};
		expect(() => parseAssembleProposalJson(JSON.stringify(broken))).toThrow(
			/duplicate slug/,
		);
	});

	test("rejects member missing required field", () => {
		const broken = {
			...validProposal,
			members: [{ ...validProposal.members[0], voice: "" }],
		};
		expect(() => parseAssembleProposalJson(JSON.stringify(broken))).toThrow(
			/members\[0\]\.voice/,
		);
	});
});
