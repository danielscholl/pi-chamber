// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
import {
	type AssembleCommandContext,
	parseAssembleArgs,
	runAssembleCommand,
	validateProposalForAuthoring,
} from "./core.ts";
import { resolveGenesisPaths } from "../genesis/core.ts";
import type {
	AuthorMindFields,
	AuthorMindOnceResult,
} from "../genesis/index.ts";
import type {
	SpawnGenesisFn,
	SpawnGenesisOptions,
	SpawnGenesisResult,
} from "../genesis/spawn.ts";

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-assemble-test-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	fs.mkdirSync(paths.mindPath, { recursive: true });
	for (const folder of paths.ideaFolders) fs.mkdirSync(folder, { recursive: true });
	fs.mkdirSync(paths.workingMemoryPath, { recursive: true });
	fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
	fs.writeFileSync(paths.soulPath, `# ${slug}\n\nIdentity body.\n`);
	fs.writeFileSync(paths.mindIndexPath, "# Index\n\n- SOUL\n");
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nm\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- r\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- created\n");
	fs.writeFileSync(
		paths.shimPath,
		`---\nname: ${slug}\ndescription: "x"\n---\n\nbody\n`,
	);
}

function defaultProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		project: "A test project",
		team_slug: "assembly",
		team_name: "Assembly",
		universe: "Heat",
		rationale: "covers the gaps",
		members: [
			{
				name: "Neil",
				slug: "neil",
				role: "lead",
				voice: "steady",
				voiceDescription: "calm strategist",
				rationale: "runs point",
			},
			{
				name: "Chris",
				slug: "chris",
				role: "executor",
				voice: "sharp",
				voiceDescription: "fast hands",
				rationale: "ships",
			},
		],
		...overrides,
	};
}

function makeSpawnReturning(
	proposals: Array<Record<string, unknown>>,
): { spawn: SpawnGenesisFn; calls: SpawnGenesisOptions[] } {
	const calls: SpawnGenesisOptions[] = [];
	let cursor = 0;
	const spawn: SpawnGenesisFn = async (opts) => {
		calls.push(opts);
		const proposal = proposals[Math.min(cursor, proposals.length - 1)];
		cursor++;
		return {
			exitCode: 0,
			finalText: JSON.stringify(proposal),
			stderr: "",
			aborted: false,
			durationMs: 1,
		} satisfies SpawnGenesisResult;
	};
	return { spawn, calls };
}

interface FakeCtxOptions {
	hasUI?: boolean;
	selectChoices?: Array<string | undefined>;
	inputs?: Array<string | undefined>;
}

interface FakeCtx {
	ctx: AssembleCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	selects: Array<{ prompt: string; options: string[] }>;
	inputs: Array<{ title: string; placeholder?: string }>;
	widgetStates: Array<{ key: string; content?: string[] }>;
}

function makeCtx(cwd: string, opts: FakeCtxOptions = {}): FakeCtx {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ prompt: string; options: string[] }> = [];
	const inputs: Array<{ title: string; placeholder?: string }> = [];
	const widgetStates: Array<{ key: string; content?: string[] }> = [];
	const selectQueue = [...(opts.selectChoices ?? [])];
	const inputQueue = [...(opts.inputs ?? [])];
	const ctx: AssembleCommandContext = {
		cwd,
		hasUI: opts.hasUI ?? true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {
				/* no-op */
			},
			async select(prompt, options) {
				selects.push({ prompt, options });
				if (selectQueue.length === 0) return undefined;
				return selectQueue.shift();
			},
			async input(title, placeholder) {
				inputs.push({ title, placeholder });
				if (inputQueue.length === 0) return undefined;
				return inputQueue.shift();
			},
			setWidget(key, content) {
				widgetStates.push({
					key,
					content: content ? [...content] : undefined,
				});
			},
		},
	};
	return { ctx, notifications, selects, inputs, widgetStates };
}

function makePi(): {
	pi: { appendEntry: (stream: string, entry: Record<string, unknown>) => void };
	auditEntries: Array<{ stream: string; entry: Record<string, unknown> }>;
} {
	const auditEntries: Array<{
		stream: string;
		entry: Record<string, unknown>;
	}> = [];
	return {
		pi: {
			appendEntry(stream, entry) {
				auditEntries.push({ stream, entry });
			},
		},
		auditEntries,
	};
}

interface AuthoringStub {
	authorMind: (
		fields: AuthorMindFields,
		_config: unknown,
		_cwd: string,
	) => Promise<AuthorMindOnceResult>;
	calls: AuthorMindFields[];
}

function makeAuthorMind(
	options: {
		failSlugs?: Set<string>;
		failError?: string;
	} = {},
): AuthoringStub {
	const calls: AuthorMindFields[] = [];
	const authorMind = async (
		fields: AuthorMindFields,
	): Promise<AuthorMindOnceResult> => {
		calls.push(fields);
		const slug = fields.slug ?? "?";
		if (options.failSlugs?.has(slug)) {
			return {
				ok: false,
				slug,
				error: options.failError ?? "stub failure",
				durationMs: 1,
			};
		}
		return {
			ok: true,
			slug,
			mindPath: `.pi/minds/${slug}`,
			shimPath: `.pi/agents/${slug}.md`,
			durationMs: 1,
		};
	};
	return {
		authorMind: authorMind as AuthoringStub["authorMind"],
		calls,
	};
}

describe("parseAssembleArgs", () => {
	test("returns convene defaults for empty input", () => {
		expect(parseAssembleArgs("")).toEqual({
			mode: "convene",
			noUniverse: false,
			scanOnly: false,
		});
	});

	test("recognizes 'adjourn' as a subcommand", () => {
		expect(parseAssembleArgs("adjourn")).toEqual({
			mode: "adjourn",
			noUniverse: false,
			scanOnly: false,
		});
	});

	test("captures adjourn slug from second positional", () => {
		expect(parseAssembleArgs("adjourn alpha-team")).toEqual({
			mode: "adjourn",
			adjournSlug: "alpha-team",
			noUniverse: false,
			scanOnly: false,
		});
	});

	test("ignores trailing tokens after adjourn slug", () => {
		const args = parseAssembleArgs("adjourn alpha-team please");
		expect(args.mode).toBe("adjourn");
		expect(args.adjournSlug).toBe("alpha-team");
		expect(args.description).toBeUndefined();
	});

	test("treats positional text as description", () => {
		const args = parseAssembleArgs("building a CLI for X");
		expect(args.description).toBe("building a CLI for X");
	});

	test("respects quoted descriptions", () => {
		const args = parseAssembleArgs('"I\'m building a thing"');
		expect(args.description).toBe("I'm building a thing");
	});

	test("parses --size and --universe flags", () => {
		const args = parseAssembleArgs(
			"--size=4 --universe=Heat building a CLI",
		);
		expect(args.size).toBe(4);
		expect(args.universe).toBe("Heat");
		expect(args.description).toBe("building a CLI");
	});

	test("parses --no-universe and --scan", () => {
		const args = parseAssembleArgs("--no-universe --scan");
		expect(args.noUniverse).toBe(true);
		expect(args.scanOnly).toBe(true);
	});

	test("ignores nonsensical --size values", () => {
		expect(parseAssembleArgs("--size=0").size).toBeUndefined();
		expect(parseAssembleArgs("--size=99").size).toBeUndefined();
		expect(parseAssembleArgs("--size=abc").size).toBeUndefined();
	});

	test("lowercases adjourn slug for canonical matching", () => {
		expect(parseAssembleArgs("adjourn ASSEMBLY")).toEqual({
			mode: "adjourn",
			adjournSlug: "assembly",
			noUniverse: false,
			scanOnly: false,
		});
		expect(parseAssembleArgs("adjourn Mixed-Case")).toEqual({
			mode: "adjourn",
			adjournSlug: "mixed-case",
			noUniverse: false,
			scanOnly: false,
		});
	});
});

describe("validateProposalForAuthoring", () => {
	test("passes when no collisions", () => {
		withTempProject((cwd) => {
			const proposal = JSON.parse(JSON.stringify(defaultProposal()));
			expect(() =>
				validateProposalForAuthoring(proposal, cwd, {
					basePath: "./.pi/minds",
					agentShimPath: "./.pi/agents",
					defaultRole: "x",
					defaultVoice: "y",
					commit: false,
					seedLensViews: true,
					bootstrapSkills: false,
				}),
			).not.toThrow();
		});
	});

	test("rejects when member slug collides with existing mind", () => {
		withTempProject((cwd) => {
			writeMind(cwd, "neil");
			const proposal = JSON.parse(JSON.stringify(defaultProposal()));
			expect(() =>
				validateProposalForAuthoring(proposal, cwd, {
					basePath: "./.pi/minds",
					agentShimPath: "./.pi/agents",
					defaultRole: "x",
					defaultVoice: "y",
					commit: false,
					seedLensViews: true,
					bootstrapSkills: false,
				}),
			).toThrow(/collides with an existing mind/);
		});
	});

	test("rejects when team_slug already has a saved room", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi", "rooms", "assembly"), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(cwd, ".pi", "rooms", "assembly", "room.json"),
				"{}",
			);
			const proposal = JSON.parse(JSON.stringify(defaultProposal()));
			expect(() =>
				validateProposalForAuthoring(proposal, cwd, {
					basePath: "./.pi/minds",
					agentShimPath: "./.pi/agents",
					defaultRole: "x",
					defaultVoice: "y",
					commit: false,
					seedLensViews: true,
					bootstrapSkills: false,
				}),
			).toThrow(/already exists as a saved room/);
		});
	});
});

describe("runAssembleCommand — happy path", () => {
	test("approves, authors all members, saves room and lens, records audit", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n\nHi.\n");
			const { spawn, calls } = makeSpawnReturning([defaultProposal()]);
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi, auditEntries } = makePi();
			const { authorMind, calls: authorCalls } = makeAuthorMind();

			await runAssembleCommand("describe me", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(calls).toHaveLength(1);
			expect(calls[0].slug).toBe("assemble-proposer");
			expect(authorCalls.map((c) => c.slug)).toEqual(["neil", "chris"]);
			expect(authorCalls[0].source).toBe("assemble:assembly");

			// room saved
			const roomConfig = path.join(
				cwd,
				".pi",
				"rooms",
				"assembly",
				"room.json",
			);
			expect(fs.existsSync(roomConfig)).toBe(true);
			const room = JSON.parse(fs.readFileSync(roomConfig, "utf-8"));
			expect(room.mode).toBe("open-floor");
			expect(room.participants).toEqual(["neil", "chris"]);
			expect(room.opener).toBe("chairman");
			expect(room.synthesizer).toBe("chairman");
			expect(room.openFloor.endVoteThreshold).toBe(0.5);

			// lens saved
			const lensManifest = path.join(
				cwd,
				".pi",
				"observatory",
				"lenses",
				"assembly-team",
				"lens.json",
			);
			expect(fs.existsSync(lensManifest)).toBe(true);
			const manifest = JSON.parse(fs.readFileSync(lensManifest, "utf-8"));
			expect(manifest.kind).toBe("status-board");

			// audit
			expect(auditEntries).toHaveLength(1);
			expect(auditEntries[0].stream).toBe("genesis-assemble");
			expect(auditEntries[0].entry.succeeded).toEqual(["neil", "chris"]);

			// final summary contains NEXT block
			const summary = notifications[notifications.length - 1].message;
			expect(summary).toContain("TEAM ASSEMBLED");
			expect(summary).toContain("/room assembly");
		});
	});
});

describe("runAssembleCommand — cancellation", () => {
	test("cancel returns without writing files", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx } = makeCtx(cwd, { selectChoices: ["Cancel"] });
			const { pi, auditEntries } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(calls).toHaveLength(0);
			expect(auditEntries).toHaveLength(0);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(false);
		});
	});
});

describe("runAssembleCommand — drop a member", () => {
	test("drops a member then approves; room participants exclude dropped slug", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: [
					"Drop a member",
					"Chris (chris) — executor",
					"Approve and author",
				],
			});
			const { pi } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(calls.map((c) => c.slug)).toEqual(["neil"]);
			const room = JSON.parse(
				fs.readFileSync(
					path.join(cwd, ".pi", "rooms", "assembly", "room.json"),
					"utf-8",
				),
			);
			expect(room.participants).toEqual(["neil"]);
		});
	});
});

describe("runAssembleCommand — edit a member", () => {
	test("edit role then approve; member voiceDescription unchanged", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: [
					"Edit a member",
					"Neil (neil) — lead",
					"role",
					"Approve and author",
				],
				inputs: ["chief architect"],
			});
			const { pi } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			const neilCall = calls.find((c) => c.slug === "neil");
			expect(neilCall?.role).toBe("chief architect");
		});
	});
});

describe("runAssembleCommand — regenerate", () => {
	test("regenerate triggers a second proposer call with feedback context", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const second = defaultProposal({
				team_slug: "round-two",
				team_name: "Round Two",
				members: [
					{
						name: "Linus",
						slug: "linus",
						role: "lead",
						voice: "calm",
						voiceDescription: "patient strategist",
						rationale: "carries the team",
					},
				],
			});
			const { spawn, calls: spawnCalls } = makeSpawnReturning([
				defaultProposal(),
				second,
			]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: ["Regenerate", "Approve and author"],
				inputs: ["lean toward lighter ops"],
			});
			const { pi } = makePi();
			const { authorMind, calls: authorCalls } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(spawnCalls).toHaveLength(2);
			expect(spawnCalls[1].prompt).toContain("REGENERATE NOTES");
			expect(spawnCalls[1].prompt).toContain("lean toward lighter ops");
			expect(authorCalls.map((c) => c.slug)).toEqual(["linus"]);
		});
	});
});

describe("runAssembleCommand — default-slug override", () => {
	test("respects a contextual team_name when the model deviates from the default slug", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const contextual = defaultProposal({
				team_slug: "strike-team",
				team_name: "Strike Team",
			});
			const { spawn } = makeSpawnReturning([contextual]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi } = makePi();
			const { authorMind } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			const room = JSON.parse(
				fs.readFileSync(
					path.join(cwd, ".pi", "rooms", "strike-team", "room.json"),
					"utf-8",
				),
			);
			expect(room.name).toBe("Strike Team");
			expect(room.slug).toBe("strike-team");
		});
	});

	test("overrides slug when model picked a generic team_name", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const driftedSlug = defaultProposal({
				team_slug: "team",
				team_name: "Assembly",
			});
			const { spawn } = makeSpawnReturning([driftedSlug]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi } = makePi();
			const { authorMind } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly", "room.json")),
			).toBe(true);
			const room = JSON.parse(
				fs.readFileSync(
					path.join(cwd, ".pi", "rooms", "assembly", "room.json"),
					"utf-8",
				),
			);
			expect(room.slug).toBe("assembly");
			expect(room.name).toBe("Assembly");
		});
	});
});

describe("runAssembleCommand — metadata lock through regenerate", () => {
	test("user-edited team_slug survives a regenerate", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const first = defaultProposal();
			const second = defaultProposal({
				team_slug: "model-picked",
				team_name: "Model Picked",
				members: [
					{
						name: "Ada",
						slug: "ada",
						role: "lead",
						voice: "steady",
						voiceDescription: "engineer",
						rationale: "covers control",
					},
				],
			});
			const { spawn } = makeSpawnReturning([first, second]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: [
					"Edit team metadata",
					"team slug",
					"Regenerate",
					"Approve and author",
				],
				inputs: ["custom-team", ""],
			});
			const { pi } = makePi();
			const { authorMind } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			const roomPath = path.join(
				cwd,
				".pi",
				"rooms",
				"custom-team",
				"room.json",
			);
			expect(fs.existsSync(roomPath)).toBe(true);
			const room = JSON.parse(fs.readFileSync(roomPath, "utf-8"));
			expect(room.slug).toBe("custom-team");
			expect(room.participants).toEqual(["ada"]);
		});
	});

	test("locked metadata suppresses default-slug override on regenerate", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const first = defaultProposal();
			const second = defaultProposal({
				team_slug: "another",
				team_name: "Another",
			});
			const { spawn, calls } = makeSpawnReturning([first, second]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: [
					"Edit team metadata",
					"team name",
					"Regenerate",
					"Cancel",
				],
				inputs: ["My Custom Team", ""],
			});
			const { pi } = makePi();
			const { authorMind } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(calls).toHaveLength(2);
			// Second prompt should NOT include the default-slug directive once metadata is locked.
			expect(calls[1].prompt).not.toContain('Use "assembly" as the team_slug');
		});
	});
});

describe("runAssembleCommand — partial failure", () => {
	test("one member fails; room saved with succeeded slugs only", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi, auditEntries } = makePi();
			const { authorMind } = makeAuthorMind({
				failSlugs: new Set(["chris"]),
				failError: "spawn timed out",
			});

			await runAssembleCommand("x", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			const room = JSON.parse(
				fs.readFileSync(
					path.join(cwd, ".pi", "rooms", "assembly", "room.json"),
					"utf-8",
				),
			);
			expect(room.participants).toEqual(["neil"]);

			expect(auditEntries[0].entry.succeeded).toEqual(["neil"]);
			expect(auditEntries[0].entry.failed).toEqual(["chris"]);

			const summary = notifications[notifications.length - 1].message;
			expect(summary).toContain("chris: spawn timed out");
		});
	});

	test("all members fail; room not saved, audit still recorded", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi, auditEntries } = makePi();
			const { authorMind } = makeAuthorMind({
				failSlugs: new Set(["neil", "chris"]),
			});

			await runAssembleCommand("x", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(false);
			expect(auditEntries).toHaveLength(1);
			expect(auditEntries[0].entry.succeeded).toEqual([]);
			expect(auditEntries[0].entry.failed).toEqual(["neil", "chris"]);
		});
	});
});

describe("runAssembleCommand — guard rails", () => {
	test("refuses without UI", async () => {
		await withTempProject(async (cwd) => {
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx, notifications } = makeCtx(cwd, { hasUI: false });
			const { pi } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await expect(
				runAssembleCommand("x", ctx, {
					pi: pi as never,
					spawnSubagent: spawn,
					authorMind,
				}),
			).rejects.toThrow(/requires interactive UI/);
			expect(calls).toHaveLength(0);
			// the notify path with hasUI=false throws on error; no notifications recorded
			expect(notifications).toHaveLength(0);
		});
	});

	test("refuses when there are no signals or description", async () => {
		await withTempProject(async (cwd) => {
			const { spawn, calls: spawnCalls } = makeSpawnReturning([
				defaultProposal(),
			]);
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: [],
			});
			const { pi } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await runAssembleCommand("", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			// proposer never called
			expect(spawnCalls).toHaveLength(0);
			expect(calls).toHaveLength(0);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("No project description");
		});
	});

	test("refuses when proposed member slug collides with existing mind", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const { spawn } = makeSpawnReturning([defaultProposal()]);
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Approve and author"],
			});
			const { pi } = makePi();
			const { authorMind, calls } = makeAuthorMind();

			await runAssembleCommand("describe", ctx, {
				pi: pi as never,
				spawnSubagent: spawn,
				authorMind,
			});

			expect(calls).toHaveLength(0);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("collides with an existing mind");
		});
	});
});
