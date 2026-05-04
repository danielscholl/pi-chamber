// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import { mkdtempSync, rmSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
import { resolveGenesisPaths } from "./core.ts";
import {
	type AssembleProposal,
	buildAgentShim,
	buildAssembleProposalPrompt,
	buildGenesisAuthoringPrompt,
	buildGenesisSubagentAuthoringPrompt,
	parseAssembleProposalJson,
} from "./prompts.ts";
import type { RepoSignals } from "./signals.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "genesis-prompts-test-"));
	try {
		return fn(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("buildGenesisAuthoringPrompt", () => {
	test("includes requestId, structured tool instruction, and all artifact fields", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			const prompt = buildGenesisAuthoringPrompt({
				requestId: "request-123",
				name: "Ariadne",
				slug: "ariadne",
				role: "OSDU architecture scout",
				voiceDescription: 'Character/voice: "calm systems thinker"',
				paths,
			});

			expect(prompt).toContain("request-123");
			expect(prompt).toContain("genesis_write_files exactly once");
			expect(prompt).toContain("model-local knowledge only");
			expect(prompt).toContain("Do not browse or use network tools");
			expect(prompt).toContain("Do not use raw write or edit tools");
			expect(prompt).toContain(
				"Before authoring any artifact, read the two shared doctrine files",
			);
			expect(prompt).toContain(`shared IDEA doctrine: ${paths.sharedIdeaPath}`);
			expect(prompt).toContain(
				`shared Observatory doctrine: ${paths.sharedObservatoryPath}`,
			);
			expect(prompt).toContain("publishes lenses to the workspace's local viewing surface");
			expect(prompt).toContain("normalized markdown database with identity");
			expect(prompt).toContain(
				"Do not invent people, projects, domains, expertise notes",
			);
			expect(prompt).toContain("quick-scan index for the whole IDEA database");
			expect(prompt).toContain(
				"Ingest is graph operation: Read → Discuss → Place → Fan out → Index → Log → Clear",
			);
			expect(prompt).toContain(
				"Triage sorts inbox material as ingest, task, or archive",
			);
			expect(prompt).toContain(
				"Do not duplicate shared IDEA or Observatory doctrine wholesale",
			);
			expect(prompt).toContain("do not invent user or project facts");
			expect(prompt).toContain(
				"mark empty collections as empty rather than inventing notes",
			);
			expect(prompt).toContain(`SOUL.md: ${paths.soulPath}`);
			expect(prompt).toContain(`runtime agent shim: ${paths.shimPath}`);
			expect(prompt).toContain(`memory.md: ${paths.memoryPath}`);
			expect(prompt).toContain(`rules.md: ${paths.rulesPath}`);
			expect(prompt).toContain(`log.md: ${paths.logPath}`);
			expect(prompt).toContain(`mind-index.md: ${paths.mindIndexPath}`);

			for (const field of [
				"requestId",
				"description",
				"soul",
				"agentInstructions",
				"memory",
				"rules",
				"log",
				"mindIndex",
			]) {
				expect(prompt).toContain(field);
			}
		});
	});
});

describe("buildGenesisSubagentAuthoringPrompt", () => {
	test("instructs the subagent to emit JSON instead of calling tools", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			const prompt = buildGenesisSubagentAuthoringPrompt({
				requestId: "request-123",
				name: "Ariadne",
				slug: "ariadne",
				role: "OSDU architecture scout",
				voiceDescription: 'Character/voice: "calm systems thinker"',
				paths,
			});

			expect(prompt).toContain("Your name: Ariadne");
			expect(prompt).toContain("Your slug: ariadne");
			expect(prompt).toContain('Character/voice: "calm systems thinker"');
			expect(prompt).toContain("model-local knowledge only");
			expect(prompt).toContain(
				"Your final assistant message must be exactly one JSON object",
			);
			expect(prompt).toContain("Do not call tools");
			expect(prompt).toContain("Do not include markdown fences around the JSON");
			expect(prompt).not.toContain("genesis_write_files");
			expect(prompt).not.toContain("requestId:");

			for (const field of [
				"description",
				"soul",
				"agentInstructions",
				"memory",
				"rules",
				"log",
				"mindIndex",
			]) {
				expect(prompt).toContain(`"${field}"`);
			}
		});
	});
});

describe("buildAgentShim", () => {
	test("renders pi-subagents frontmatter and Genesis memory bootstrap instructions", () => {
		const shim = buildAgentShim({
			name: "Ariadne",
			slug: "ariadne",
			description: "OSDU architecture scout\nwith calm systems thinking",
			agentInstructions: "## Runtime\nOperate with care.",
		});

		expect(shim).toStartWith("---\n");
		expect(shim).toContain("name: ariadne\n");
		expect(shim).toContain(
			'description: "OSDU architecture scout with calm systems thinking"',
		);
		expect(shim).toContain("tools: read, grep, find, ls, bash, edit, write");
		expect(shim).toContain("thinking: high");
		expect(shim).toContain("systemPromptMode: replace");
		expect(shim).toContain("inheritProjectContext: true");
		expect(shim).toContain("inheritSkills: false");
		expect(shim).toContain("defaultContext: fork");
		expect(shim).toContain("defaultProgress: true");
		expect(shim).toContain("`.pi/minds/ariadne`");
		expect(shim).toContain("`.pi/minds/_shared/IDEA.md`");
		expect(shim).toContain("`.pi/minds/_shared/OBSERVATORY.md`");
		expect(shim).toContain(
			"You inherit shared IDEA doctrine from `.pi/minds/_shared/IDEA.md` and shared Observatory doctrine from `.pi/minds/_shared/OBSERVATORY.md`",
		);
		expect(shim).toContain("`.pi/minds/ariadne/SOUL.md`");
		expect(shim).toContain("`.pi/minds/ariadne/mind-index.md`");
		expect(shim).toContain("`.pi/minds/ariadne/.working-memory/memory.md`");
		expect(shim).toContain("`.pi/minds/ariadne/.working-memory/rules.md`");
		expect(shim).toContain("`.pi/minds/ariadne/.working-memory/log.md`");
		expect(shim).toContain("At the start of every task, read:");
		expect(shim).toContain("## IDEA operating contract");
		expect(shim).toContain("normalized markdown database, not a notes dump");
		expect(shim).toContain(
			"Search `.pi/minds/ariadne/mind-index.md` and relevant IDEA folders before creating notes",
		);
		expect(shim).toContain("Keep each durable fact in one canonical home");
		expect(shim).toContain(
			"Route finite workstreams to `.pi/minds/ariadne/initiatives/`",
		);
		expect(shim).toContain(
			"For ingest work, follow Read → Discuss → Place → Fan out → Index → Log → Clear",
		);
		expect(shim).toContain(
			"Never use `.pi/minds/ariadne/.working-memory/log.md` as the canonical home for domain knowledge",
		);
		expect(shim).toContain("## Observatory authoring contract");
		expect(shim).toContain(
			"the v1 lens kinds (`briefing` and `status-board`)",
		);
		expect(shim).toContain(".pi/observatory/lenses/<slug>/lens.json");
		expect(shim).toContain("Observatory lenses are publication, not memory");
		expect(shim).toContain("## Task modes");
		expect(shim).toContain("**brief/research** — read-only synthesis");
		expect(shim).toContain(
			"**capture/update** — classify conversation context into canonical IDEA notes",
		);
		expect(shim).toContain("**ingest** — process queued inbox/source material");
		expect(shim).toContain("**triage** — review inbox and next-actions");
		expect(shim).toContain("## Runtime\nOperate with care.");
		expect(shim).toContain("## Memory discipline");
		expect(shim).toContain("Keep canonical knowledge in IDEA folders");
		expect(shim).toContain("## Project discipline");
		expect(shim.endsWith("\n")).toBe(true);
	});

	test("rejects model-provided YAML frontmatter in runtime instructions", () => {
		expect(() =>
			buildAgentShim({
				name: "Ariadne",
				slug: "ariadne",
				description: "OSDU architecture scout",
				agentInstructions: "---\nname: bad\n---\nBody",
			}),
		).toThrow(/must not start with YAML frontmatter/);
	});
});


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
		expect(prompt).toContain("Use this fictional universe for naming the team members: Heat");
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
		const text = `Some prose.
\`\`\`json
${JSON.stringify(validProposal)}
\`\`\`
More prose.`;
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
