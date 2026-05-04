// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { AssembleProposal } from "./prompts.ts";
import {
	parseProposalFromToml,
	serializeProposalToToml,
} from "./proposal-toml.ts";

const SAMPLE: AssembleProposal = {
	project: "Cross-platform CLI pomodoro timer",
	team_slug: "assembly",
	team_name: "Assembly",
	universe: "Ocean's Eleven",
	rationale: "A balanced CLI team focused on shipping a polished timer.",
	members: [
		{
			name: "Danny Ocean",
			slug: "danny-ocean",
			role: "CLI Product Lead",
			voice: "calm, decisive planner",
			voiceDescription:
				"Speaks with confident brevity, turning vague requirements\ninto a clean command structure and user flow.",
			rationale:
				"The project needs a coherent CLI experience with configurable\ntimers, flags, and defaults.",
		},
		{
			name: "Rusty Ryan",
			slug: "rusty-ryan",
			role: "Stats & Reporting Engineer",
			voice: "practical, detail-smart operator",
			voiceDescription:
				"Uses crisp, implementation-oriented language and thinks in data shapes.",
			rationale:
				"Persistent session tracking and weekly reports are central features.",
		},
	],
};

describe("serializeProposalToToml + parseProposalFromToml", () => {
	test("round-trips a representative proposal", () => {
		const toml = serializeProposalToToml(SAMPLE);
		const result = parseProposalFromToml(toml);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.proposal).toEqual(SAMPLE);
	});

	test("preserves multi-line values exactly", () => {
		const toml = serializeProposalToToml(SAMPLE);
		const result = parseProposalFromToml(toml);
		if (!result.ok) throw new Error(`unexpected parse failure: ${result.error}`);
		expect(result.proposal.members[0]?.voiceDescription).toBe(
			SAMPLE.members[0]?.voiceDescription,
		);
		expect(result.proposal.members[0]?.rationale).toBe(
			SAMPLE.members[0]?.rationale,
		);
	});

	test("emits readable [[members]] sections", () => {
		const toml = serializeProposalToToml(SAMPLE);
		expect(toml).toContain("[[members]]");
		// Two member tables for the two members.
		expect((toml.match(/\[\[members\]\]/g) ?? []).length).toBe(2);
		expect(toml).toContain("team_slug = \"assembly\"");
		expect(toml).toContain("name = \"Danny Ocean\"");
	});

	test("uses literal multi-line strings for newline-bearing values", () => {
		const toml = serializeProposalToToml(SAMPLE);
		// At least one '''-delimited block for the multi-line rationales.
		expect(toml).toContain("'''");
	});

	test("escapes backslashes and quotes in single-line values", () => {
		const proposal: AssembleProposal = {
			...SAMPLE,
			team_name: 'Quote "in" name',
			members: [
				{
					...SAMPLE.members[0]!,
					role: "C:\\Path\\Style",
				},
				SAMPLE.members[1]!,
			],
		};
		const toml = serializeProposalToToml(proposal);
		const result = parseProposalFromToml(toml);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.proposal.team_name).toBe('Quote "in" name');
		expect(result.proposal.members[0]?.role).toBe("C:\\Path\\Style");
	});

	test("returns parse error for malformed TOML", () => {
		const result = parseProposalFromToml('team_name = "unterminated\n');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/TOML syntax error/i);
	});

	test("returns validation error when required field missing", () => {
		const toml = `project = "x"
team_name = "Y"
team_slug = "y"
universe = "literal"
rationale = "hi"
`;
		const result = parseProposalFromToml(toml);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/members/i);
	});

	test("returns validation error for invalid slug", () => {
		const proposal = { ...SAMPLE, team_slug: "Has Spaces" };
		const toml = serializeProposalToToml(proposal);
		const result = parseProposalFromToml(toml);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/team_slug/);
	});

	test("accepts user-edited TOML with reordered fields", () => {
		const toml = `team_slug = "assembly"
project = "x"
universe = "literal"
team_name = "A"
rationale = "r"

[[members]]
slug = "alpha"
name = "Alpha"
voice = "calm"
role = "Lead"
rationale = "because"
voiceDescription = "v"
`;
		const result = parseProposalFromToml(toml);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.proposal.members.length).toBe(1);
	});
});
