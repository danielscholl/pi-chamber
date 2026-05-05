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
import assemblyExtension from "./index.ts";
import genesisExtension from "../genesis/index.ts";
import { resolveGenesisPaths, validateMind } from "../genesis/core.ts";
import type {
	SpawnGenesisFn,
	SpawnGenesisOptions,
	SpawnGenesisResult,
} from "../genesis/spawn.ts";
import { serializeProposalToToml } from "./proposal-toml.ts";

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "assembly-index-test-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

interface TestNotification {
	message: string;
	type?: "info" | "warning" | "error";
}

interface TestContext {
	cwd: string;
	hasUI: boolean;
	notifications: TestNotification[];
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(prompt: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		setStatus(key: string, value: string): void;
		setWidget(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		custom<T>(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
	waitForIdle(): Promise<void>;
}

interface CreateContextOptions {
	/**
	 * Queue returned from ctx.ui.custom() in order. Each editor opening
	 * (description prompt, proposal review) consumes one item. Pass undefined
	 * to simulate Esc-cancel; pass a TOML string to simulate submit. Defaults
	 * to a single undefined (cancel) so legacy tests that don't care about
	 * the editor still work.
	 */
	editorResults?: Array<string | undefined>;
}

function createContext(
	cwd: string,
	opts: CreateContextOptions = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const editorQueue = [...(opts.editorResults ?? [undefined])];
	return {
		cwd,
		hasUI: true,
		notifications,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			async select() {
				return "Approve and author";
			},
			async input() {
				return "";
			},
			setStatus() {},
			setWidget() {},
			async custom<T>(): Promise<T> {
				if (editorQueue.length === 0) {
					throw new Error(
						"editorResults queue exhausted: ctx.ui.custom() called more times than expected.",
					);
				}
				return editorQueue.shift() as unknown as T;
			},
		},
		async waitForIdle() {},
	};
}

interface HarnessResult {
	commands: Map<string, { handler: (args: string, ctx: TestContext) => Promise<void> }>;
	auditEntries: Array<{ stream: string; entry: Record<string, unknown> }>;
	spawnCalls: SpawnGenesisOptions[];
}

function createHarness(spawn: SpawnGenesisFn): HarnessResult {
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: TestContext) => Promise<void> }
	>();
	const auditEntries: Array<{
		stream: string;
		entry: Record<string, unknown>;
	}> = [];
	const spawnCalls: SpawnGenesisOptions[] = [];

	const recordingSpawn: SpawnGenesisFn = async (opts) => {
		spawnCalls.push(opts);
		return spawn(opts);
	};

	const pi = {
		registerCommand(name: string, command: unknown) {
			commands.set(
				name,
				command as {
					handler: (args: string, ctx: TestContext) => Promise<void>;
				},
			);
		},
		registerTool() {},
		on() {},
		sendUserMessage() {},
		appendEntry(stream: string, entry: Record<string, unknown>) {
			auditEntries.push({ stream, entry });
		},
	};

	// Both extensions need to load: genesis owns authorMindOnce; assembly
	// registers /assembly. Order doesn't matter for static ES module imports.
	genesisExtension(pi as never, { spawnSubagent: recordingSpawn });
	assemblyExtension(pi as never, { spawnSubagent: recordingSpawn });

	return { commands, auditEntries, spawnCalls };
}

function defaultAuthoringPayload(name: string): Record<string, string> {
	return {
		description: `${name} Genesis preset for testing.`,
		soul: `# ${name}\n\nIdentity body.`,
		agentInstructions:
			"# Runtime\n\nRead working memory; never store secrets.",
		memory: `# Memory\n\n- Name: ${name}.`,
		rules: "# Rules\n\n1. Be precise.",
		log: `# Log\n\n- Genesis stub for ${name}.`,
		mindIndex: "# Index\n\n- SOUL.\n- working memory.",
	};
}

describe("/assembly command registration", () => {
	test("assembly extension registers /assembly", async () => {
		await withTempProject(async () => {
			const harness = createHarness(async () => ({
				exitCode: 0,
				finalText: "{}",
				stderr: "",
				aborted: false,
				durationMs: 1,
			}));
			expect(harness.commands.has("assembly")).toBe(true);
			expect(harness.commands.has("genesis:assemble")).toBe(false);
		});
	});

	test("genesis no longer registers /genesis:assemble", async () => {
		await withTempProject(async () => {
			const harness = createHarness(async () => ({
				exitCode: 0,
				finalText: "{}",
				stderr: "",
				aborted: false,
				durationMs: 1,
			}));
			expect(harness.commands.has("genesis:assemble")).toBe(false);
		});
	});

	test("dispatches /assembly adjourn through the same command", async () => {
		await withTempProject(async (cwd) => {
			// Seed an assembly-marked room with one mind so adjourn has something
			// to remove.
			const minds = ["neil"];
			for (const slug of minds) {
				const paths = resolveGenesisPaths(cwd, slug);
				fs.mkdirSync(paths.mindPath, { recursive: true });
				for (const folder of paths.ideaFolders)
					fs.mkdirSync(folder, { recursive: true });
				fs.mkdirSync(paths.workingMemoryPath, { recursive: true });
				fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
				fs.writeFileSync(paths.agentPath, "# Operating Doctrine\n");
				fs.writeFileSync(paths.soulPath, `# ${slug}\n\nbody\n`);
				fs.writeFileSync(paths.mindIndexPath, "# Index\n\n- SOUL.md\n");
				fs.writeFileSync(paths.memoryPath, "# Memory\n");
				fs.writeFileSync(paths.rulesPath, "# Rules\n");
				fs.writeFileSync(paths.logPath, "# Log\n");
				fs.writeFileSync(
					paths.shimPath,
					`---\nname: ${slug}\ndescription: "x"\n---\n\nbody\n`,
				);
			}
			const now = new Date().toISOString();
			const roomDir = path.join(cwd, ".pi", "rooms", "assembly");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "assembly",
					name: "Assembly",
					mode: "open-floor",
					participants: minds,
					createdAt: now,
					updatedAt: now,
					assembledBy: "assembly",
				}),
			);

			const harness = createHarness(async () => ({
				exitCode: 0,
				finalText: "{}",
				stderr: "",
				aborted: false,
				durationMs: 1,
			}));
			const ctx = createContext(cwd);
			(ctx.ui as { select?: (p: string, o: string[]) => Promise<string | undefined> })
				.select = async () => "Adjourn";

			await harness.commands.get("assembly")?.handler("adjourn", ctx);

			expect(fs.existsSync(roomDir)).toBe(false);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "neil")),
			).toBe(false);
			const adjournAudit = harness.auditEntries.find(
				(e) => e.stream === "genesis-assemble",
			);
			expect(adjournAudit?.entry.action).toBe("adjourn");
		});
	});

	test("/assembly runs end-to-end and writes minds + room + lens + audit", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n\nHello.\n");

			const proposalPayload = {
				project: "test",
				team_slug: "assembly",
				team_name: "Alpha",
				universe: "Heat",
				rationale: "fits",
				members: [
					{
						name: "Neil",
						slug: "neil",
						role: "lead",
						voice: "calm",
						voiceDescription: "calm strategist",
						rationale: "runs point",
					},
				],
			};
			const spawn: SpawnGenesisFn = async (opts) => {
				if (opts.slug === "assemble-proposer") {
					return {
						exitCode: 0,
						finalText: JSON.stringify(proposalPayload),
						stderr: "",
						aborted: false,
						durationMs: 1,
					} satisfies SpawnGenesisResult;
				}
				return {
					exitCode: 0,
					finalText: JSON.stringify(defaultAuthoringPayload(opts.slug)),
					stderr: "",
					aborted: false,
					durationMs: 1,
				} satisfies SpawnGenesisResult;
			};

			const harness = createHarness(spawn);
			// Simulate the user submitting the prefilled proposal unchanged.
			const ctx = createContext(cwd, {
				editorResults: [serializeProposalToToml(proposalPayload)],
			});
			await harness.commands
				.get("assembly")
				?.handler("describe me", ctx);

			expect(harness.spawnCalls.length).toBeGreaterThanOrEqual(2);

			const neilPaths = resolveGenesisPaths(cwd, "neil");
			expect(fs.existsSync(neilPaths.soulPath)).toBe(true);
			expect(validateMind(neilPaths).ok).toBe(true);

			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "rooms", "assembly", "room.json"),
				),
			).toBe(true);

			expect(
				fs.existsSync(
					path.join(
						cwd,
						".pi",
						"observatory",
						"lenses",
						"assembly-team",
						"lens.json",
					),
				),
			).toBe(true);

			const assembleAudit = harness.auditEntries.find(
				(e) => e.stream === "genesis-assemble",
			);
			expect(assembleAudit).toBeDefined();
			expect(assembleAudit?.entry.succeeded).toEqual(["neil"]);
		});
	});
});
