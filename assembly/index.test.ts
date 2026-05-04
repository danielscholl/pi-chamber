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
	};
	waitForIdle(): Promise<void>;
}

function createContext(cwd: string): TestContext {
	const notifications: TestNotification[] = [];
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

	test("/assembly runs end-to-end and writes minds + room + lens + audit", async () => {
		await withTempProject(async (cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n\nHello.\n");

			const proposalPayload = {
				project: "test",
				team_slug: "alpha-team",
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
			const ctx = createContext(cwd);
			await harness.commands
				.get("assembly")
				?.handler("describe me", ctx);

			expect(harness.spawnCalls.length).toBeGreaterThanOrEqual(2);

			const neilPaths = resolveGenesisPaths(cwd, "neil");
			expect(fs.existsSync(neilPaths.soulPath)).toBe(true);
			expect(validateMind(neilPaths).ok).toBe(true);

			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "rooms", "alpha-team", "room.json"),
				),
			).toBe(true);

			expect(
				fs.existsSync(
					path.join(
						cwd,
						".pi",
						"observatory",
						"lenses",
						"alpha-team-team",
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
