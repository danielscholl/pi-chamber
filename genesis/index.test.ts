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
import genesisExtension, { removeMindOnce } from "./index.ts";
import {
	DEFAULT_GENESIS_CONFIG,
	resolveGenesisPaths,
	validateMind,
} from "./core.ts";
import type {
	SpawnGenesisFn,
	SpawnGenesisOptions,
	SpawnGenesisResult,
} from "./spawn.ts";

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-flow-test-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function defaultAuthoringPayload(name: string): Record<string, string> {
	return {
		description: `${name} composed Genesis preset for testing.`,
		soul: `# ${name}\n\nI keep the operation composed, briefed, and moving.`,
		agentInstructions:
			"# Runtime\n\nRead working memory first, brief crisply, and never store secrets.",
		memory: `# Memory\n\n- Name: ${name}\n- Purpose: composed continuity for tests.`,
		rules: "# Rules\n\n1. Protect attention.\n2. State uncertainty plainly.",
		log: `# Log\n\n- Genesis completed via subagent stub for ${name}.`,
		mindIndex:
			"# Mind Index\n\n- SOUL.md: identity.\n- .working-memory/: memory, rules, and log.",
	};
}

interface SpawnCall {
	options: SpawnGenesisOptions;
}

interface HarnessOptions {
	spawn?: SpawnGenesisFn;
	payload?: (name: string) => Record<string, string>;
}

function createHarness(options: HarnessOptions = {}) {
	const commands = new Map<
		string,
		{
			handler: (args: string, ctx: TestContext) => Promise<void>;
			getArgumentCompletions?: (
				prefix: string,
			) => Array<{ value: string; label: string; description?: string }> | null;
		}
	>();
	const tools = new Map<
		string,
		{
			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
			) => Promise<unknown>;
		}
	>();
	const spawnCalls: SpawnCall[] = [];
	const auditEntries: Array<{
		stream: string;
		entry: Record<string, unknown>;
	}> = [];

	const pi = {
		registerCommand(name: string, command: unknown) {
			commands.set(
				name,
				command as {
					handler: (args: string, ctx: TestContext) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => Array<{
						value: string;
						label: string;
						description?: string;
					}> | null;
				},
			);
		},
		registerTool(tool: unknown) {
			const namedTool = tool as {
				name: string;
				execute: (
					toolCallId: string,
					params: Record<string, unknown>,
				) => Promise<unknown>;
			};
			tools.set(namedTool.name, namedTool);
		},
		on() {},
		sendUserMessage() {
			throw new Error(
				"pi.sendUserMessage should not be called by Genesis after the subagent migration.",
			);
		},
		appendEntry(stream: string, entry: Record<string, unknown>) {
			auditEntries.push({ stream, entry });
		},
	};

	const payloadFor = options.payload ?? defaultAuthoringPayload;
	const spawnSubagent: SpawnGenesisFn =
		options.spawn ??
		(async (opts) => {
			spawnCalls.push({ options: opts });
			const nameMatch = /Your name: (.+)/.exec(opts.prompt);
			const name = nameMatch ? nameMatch[1].trim() : opts.slug;
			const payload = payloadFor(name);
			return {
				exitCode: 0,
				finalText: JSON.stringify(payload),
				stderr: "",
				aborted: false,
				durationMs: 1,
			} satisfies SpawnGenesisResult;
		});

	if (options.spawn) {
		const wrapped = options.spawn;
		const recording: SpawnGenesisFn = async (opts) => {
			spawnCalls.push({ options: opts });
			return wrapped(opts);
		};
		genesisExtension(pi as never, { spawnSubagent: recording });
	} else {
		genesisExtension(pi as never, { spawnSubagent });
	}

	return { commands, tools, spawnCalls, auditEntries };
}

type TestNotification = {
	message: string;
	type?: "info" | "warning" | "error";
};

type TestContext = {
	cwd: string;
	hasUI: boolean;
	idleCalls: number;
	notifications: TestNotification[];
	selectOptions: string[][];
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(prompt: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
		setStatus(key: string, value: string): void;
	};
	waitForIdle(): Promise<void>;
};

function createContext(
	cwd: string,
	overrides: Partial<{
		hasUI: boolean;
		selectValue: string | undefined;
		inputs: string[];
	}> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const selectOptions: string[][] = [];
	const inputs = [...(overrides.inputs ?? [])];
	const ctx: TestContext = {
		cwd,
		hasUI: overrides.hasUI ?? true,
		idleCalls: 0,
		notifications,
		selectOptions,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			async select(_prompt, options) {
				selectOptions.push(options);
				return overrides.selectValue;
			},
			async input() {
				return inputs.shift();
			},
			setStatus() {},
		},
		async waitForIdle() {
			ctx.idleCalls += 1;
		},
	};
	return ctx;
}

function moneypennyPayload(): Record<string, string> {
	return {
		description:
			"Miss Moneypenny, composed Chief of Staff for workspace operations.",
		soul: "# Miss Moneypenny\n\nI keep the operation composed, briefed, and moving.",
		agentInstructions:
			"# Runtime\n\nRead working memory first, brief crisply, track follow-through, and never store secrets.",
		memory:
			"# Memory\n\n- Name: Miss Moneypenny\n- Role: Chief of Staff\n- Purpose: briefings, priorities, follow-through, and operational memory.",
		rules:
			"# Rules\n\n1. Protect attention.\n2. State uncertainty plainly.\n3. Do not store secrets.",
		log: "# Log\n\n- Genesis completed through subagent flow.",
		mindIndex:
			"# Mind Index\n\n- SOUL.md: identity.\n- .working-memory/: memory, rules, and log.\n- Agent shim: runtime entrypoint.",
	};
}

describe("Genesis command flow", () => {
	test("registers direct commands for all starter presets", () => {
		const harness = createHarness();

		expect([...harness.commands.keys()].sort()).toEqual(
			expect.arrayContaining([
				"genesis",
				"genesis:moneypenny",
				"genesis:mycroft",
				"genesis:jarvis",
			]),
		);
		expect(harness.commands.has("genesis:miss-moneypenny")).toBe(false);
		expect(harness.commands.has("genesis:alfred")).toBe(false);
	});

	test("/genesis completions explain help, custom creation, and starter presets", () => {
		const harness = createHarness();
		const completions = harness.commands
			.get("genesis")
			?.getArgumentCompletions?.("");

		expect(completions?.map((item) => item.value)).toEqual(
			expect.arrayContaining([
				"help",
				"list",
				"custom",
				"moneypenny",
				"mycroft",
				"jarvis",
			]),
		);
		expect(completions?.map((item) => item.value)).not.toContain("alfred");
		expect(JSON.stringify(completions)).toContain("Create a custom mind");
	});

	test("/genesis help and list show creation guidance", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis")?.handler("help", ctx);
			await harness.commands.get("genesis")?.handler("list", ctx);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("/genesis custom"),
				}),
			);
			expect(ctx.notifications[0].message).toContain("/mind <slug>");
			expect(ctx.notifications[0].message).toContain("moneypenny");
			expect(ctx.notifications[1].message).toContain(
				"Existing complete Genesis minds",
			);
			expect(ctx.notifications[1].message).toContain("Create one with");
		});
	});

	test("/genesis starter slug spawns the subagent with the right prompt", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis")?.handler("moneypenny", ctx);

			expect(harness.spawnCalls).toHaveLength(1);
			const prompt = harness.spawnCalls[0].options.prompt;
			expect(harness.spawnCalls[0].options.slug).toBe("moneypenny");
			expect(prompt).toContain("Your name: Miss Moneypenny");
			expect(prompt).toContain("Your slug: moneypenny");
			expect(prompt).toContain(
				"Research this character or persona from model-local knowledge",
			);
		});
	});

	test("/genesis:moneypenny runs the subagent and writes files from its JSON output", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness({ payload: () => moneypennyPayload() });
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			expect(ctx.idleCalls).toBe(0);
			expect(harness.spawnCalls).toHaveLength(1);
			const prompt = harness.spawnCalls[0].options.prompt;
			expect(prompt).toContain("Your name: Miss Moneypenny");
			expect(prompt).toContain("Your slug: moneypenny");
			expect(prompt).toContain("Your role: Chief of Staff");
			expect(prompt).toContain('Character/voice: "Miss Moneypenny"');
			expect(prompt).toContain("Research this character or persona");
			expect(prompt).toContain("Do not browse or use network tools");
			expect(prompt).toContain("Capture the energy");
			expect(prompt).toContain(
				"Your final assistant message must be exactly one JSON object",
			);
			expect(prompt).not.toContain("genesis_write_files");

			const paths = resolveGenesisPaths(cwd, "moneypenny");
			expect(fs.readFileSync(paths.soulPath, "utf-8")).toContain(
				"I keep the operation composed",
			);
			expect(fs.readFileSync(paths.memoryPath, "utf-8")).toContain(
				"Role: Chief of Staff",
			);
			expect(fs.readFileSync(paths.mindIndexPath, "utf-8")).toContain(
				"SOUL.md: identity",
			);
			expect(fs.existsSync(paths.shimPath)).toBe(true);
			expect(fs.readFileSync(paths.shimPath, "utf-8")).toContain(
				"name: moneypenny",
			);
			expect(validateMind(paths)).toEqual({
				ok: true,
				errors: [],
				missing: [],
				invalid: [],
			});
			expect(harness.auditEntries).toHaveLength(1);
			expect(harness.auditEntries[0].entry).toEqual(
				expect.objectContaining({
					slug: "moneypenny",
					source: "moneypenny",
				}),
			);

			const completionNotice = ctx.notifications.find(
				(n) => n.type === "info" && n.message.startsWith("Genesis complete."),
			);
			expect(completionNotice).toBeDefined();
		});
	});

	test("/genesis UI Miss Moneypenny selection runs the subagent", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd, { selectValue: "Miss Moneypenny" });

			await harness.commands.get("genesis")?.handler("", ctx);

			expect(ctx.selectOptions[0]).toEqual([
				"Custom mind",
				"Miss Moneypenny",
				"Mycroft",
				"Jarvis",
			]);
			expect(harness.spawnCalls).toHaveLength(1);
			expect(harness.spawnCalls[0].options.prompt).toContain(
				"Your slug: moneypenny",
			);
			expect(
				fs.existsSync(resolveGenesisPaths(cwd, "moneypenny").shimPath),
			).toBe(true);
		});
	});

	test("/genesis:mycroft starts the Mycroft preset", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:mycroft")?.handler("", ctx);

			expect(harness.spawnCalls).toHaveLength(1);
			const prompt = harness.spawnCalls[0].options.prompt;
			expect(prompt).toContain("Your name: Mycroft");
			expect(prompt).toContain("Your role: Research Partner");
			expect(prompt).toContain("Mycroft Holmes");
			expect(prompt).toContain("pattern");
		});
	});

	test("/genesis:jarvis starts the Jarvis preset", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:jarvis")?.handler("", ctx);

			expect(harness.spawnCalls).toHaveLength(1);
			const prompt = harness.spawnCalls[0].options.prompt;
			expect(prompt).toContain("Your name: Jarvis");
			expect(prompt).toContain("Your role: Engineering Partner");
			expect(prompt).toContain("J.A.R.V.I.S.'s");
			expect(prompt).toContain("diagnostics");
		});
	});

	test("custom Genesis args spawn the subagent with custom voice fields", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd, { hasUI: false });

			await harness.commands
				.get("genesis")
				?.handler(
					'name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
					ctx,
				);

			expect(harness.spawnCalls).toHaveLength(1);
			const prompt = harness.spawnCalls[0].options.prompt;
			expect(prompt).toContain("Your name: Ariadne");
			expect(prompt).toContain("Your slug: ariadne");
			expect(prompt).toContain("Your role: OSDU architecture scout");
			expect(prompt).toContain('Character/voice: "calm systems thinker"');
			expect(prompt).not.toContain("Miss Moneypenny");
			const paths = resolveGenesisPaths(cwd, "ariadne");
			expect(fs.existsSync(paths.soulPath)).toBe(true);
			expect(fs.existsSync(paths.shimPath)).toBe(true);
		});
	});

	test("subagent failure surfaces an error and leaves scaffold for inspection", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness({
				spawn: async () => ({
					exitCode: 2,
					finalText: "",
					stderr: "boom",
					aborted: false,
					durationMs: 1,
				}),
			});
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			const errorNotice = ctx.notifications.find((n) => n.type === "error");
			expect(errorNotice?.message).toContain(
				"Genesis subagent exited with code 2",
			);
			expect(errorNotice?.message).toContain("boom");
			expect(errorNotice?.message).toContain("delete before retrying");
			const paths = resolveGenesisPaths(cwd, "moneypenny");
			expect(fs.existsSync(paths.mindPath)).toBe(true);
			expect(fs.existsSync(paths.soulPath)).toBe(false);
			expect(harness.auditEntries).toHaveLength(0);
		});
	});

	test("invalid subagent JSON surfaces a parse error", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness({
				spawn: async () => ({
					exitCode: 0,
					finalText: "not json at all",
					stderr: "",
					aborted: false,
					durationMs: 1,
				}),
			});
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			const errorNotice = ctx.notifications.find((n) => n.type === "error");
			expect(errorNotice?.message).toContain(
				"Genesis subagent output was not valid JSON",
			);
			expect(harness.auditEntries).toHaveLength(0);
		});
	});

	test("existing Miss Moneypenny mind blocks a new preset request", async () => {
		await withTempProject(async (cwd) => {
			const paths = resolveGenesisPaths(cwd, "moneypenny");
			fs.mkdirSync(paths.mindPath, { recursive: true });
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			expect(harness.spawnCalls).toHaveLength(0);
			expect(ctx.notifications).toEqual([
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("Genesis starter already exists"),
				}),
			]);
		});
	});

	test("existing Miss Moneypenny shim blocks a new preset request", async () => {
		await withTempProject(async (cwd) => {
			const paths = resolveGenesisPaths(cwd, "moneypenny");
			fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
			fs.writeFileSync(paths.shimPath, "existing shim\n");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			expect(harness.spawnCalls).toHaveLength(0);
			expect(ctx.notifications).toEqual([
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining(
						"Genesis starter shim already exists",
					),
				}),
			]);
		});
	});
});

describe("removeMindOnce", () => {
	function writeMindFiles(cwd: string, slug: string) {
		const paths = resolveGenesisPaths(cwd, slug);
		fs.mkdirSync(paths.mindPath, { recursive: true });
		for (const folder of paths.ideaFolders) fs.mkdirSync(folder, { recursive: true });
		fs.mkdirSync(paths.workingMemoryPath, { recursive: true });
		fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
		fs.writeFileSync(paths.agentPath, "# Operating Doctrine\n");
		fs.writeFileSync(paths.soulPath, `# ${slug}\n\nbody\n`);
		fs.writeFileSync(paths.mindIndexPath, "# Index\n");
		fs.writeFileSync(paths.memoryPath, "# Memory\n");
		fs.writeFileSync(paths.rulesPath, "# Rules\n");
		fs.writeFileSync(paths.logPath, "# Log\n");
		fs.writeFileSync(paths.shimPath, `---\nname: ${slug}\ndescription: "x"\n---\n\nbody\n`);
		const lensFolder = path.join(
			cwd,
			".pi",
			"observatory",
			"lenses",
			`${slug}-newspaper`,
		);
		fs.mkdirSync(lensFolder, { recursive: true });
		fs.writeFileSync(
			path.join(lensFolder, "lens.json"),
			JSON.stringify({
				name: "Test Newspaper",
				kind: "briefing",
				source: "data.json",
			}),
		);
		fs.writeFileSync(path.join(lensFolder, "data.json"), "{}");
	}

	test("removes mind directory, shim, and newspaper lens", async () => {
		await withTempProject(async (cwd) => {
			writeMindFiles(cwd, "neil");
			const audits: Array<{ stream: string; entry: Record<string, unknown> }> = [];

			const result = await removeMindOnce(
				"neil",
				cwd,
				DEFAULT_GENESIS_CONFIG,
				(stream, entry) => audits.push({ stream, entry }),
			);

			expect(result.ok).toBe(true);
			expect(result.removed).toEqual({ mind: true, shim: true, newspaper: true });
			const paths = resolveGenesisPaths(cwd, "neil");
			expect(fs.existsSync(paths.mindPath)).toBe(false);
			expect(fs.existsSync(paths.shimPath)).toBe(false);
			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "observatory", "lenses", "neil-newspaper"),
				),
			).toBe(false);

			expect(audits).toHaveLength(1);
			expect(audits[0].stream).toBe("genesis");
			expect(audits[0].entry).toEqual(
				expect.objectContaining({
					action: "remove",
					slug: "neil",
				}),
			);
		});
	});

	test("idempotent on second run (missing files are no-ops)", async () => {
		await withTempProject(async (cwd) => {
			writeMindFiles(cwd, "neil");
			const audits: Array<{ stream: string; entry: Record<string, unknown> }> = [];
			const append = (stream: string, entry: Record<string, unknown>) =>
				audits.push({ stream, entry });

			const first = await removeMindOnce("neil", cwd, DEFAULT_GENESIS_CONFIG, append);
			expect(first.ok).toBe(true);
			expect(first.removed.mind).toBe(true);

			const second = await removeMindOnce("neil", cwd, DEFAULT_GENESIS_CONFIG, append);
			expect(second.ok).toBe(true);
			expect(second.removed).toEqual({ mind: false, shim: false, newspaper: false });
		});
	});

	test("rejects empty slug", async () => {
		await withTempProject(async (cwd) => {
			const result = await removeMindOnce("", cwd, DEFAULT_GENESIS_CONFIG, () => {});
			expect(result.ok).toBe(false);
			expect(result.error).toMatch(/slug/);
		});
	});

	test("records source field in audit when provided", async () => {
		await withTempProject(async (cwd) => {
			writeMindFiles(cwd, "chris");
			const audits: Array<{ stream: string; entry: Record<string, unknown> }> = [];
			await removeMindOnce(
				"chris",
				cwd,
				DEFAULT_GENESIS_CONFIG,
				(stream, entry) => audits.push({ stream, entry }),
				{ source: "assembly-adjourn:test-team" },
			);
			expect(audits[0].entry.source).toBe("assembly-adjourn:test-team");
		});
	});

	test("surfaces newspaperError when the lens path is locked", async () => {
		await withTempProject(async (cwd) => {
			writeMindFiles(cwd, "ada");
			// Make the per-mind newspaper lens directory read-only so the inner
			// rmSync raises EACCES. removeMindOnce should still return ok=true
			// (lens removal is best-effort) but the error must surface in both
			// the result and the audit entry.
			const lensesRoot = path.join(cwd, ".pi", "observatory", "lenses");
			fs.chmodSync(lensesRoot, 0o500);

			const audits: Array<{ stream: string; entry: Record<string, unknown> }> = [];
			let result;
			try {
				result = await removeMindOnce(
					"ada",
					cwd,
					DEFAULT_GENESIS_CONFIG,
					(stream, entry) => audits.push({ stream, entry }),
				);
			} finally {
				fs.chmodSync(lensesRoot, 0o755);
			}

			expect(result.ok).toBe(true);
			expect(result.removed.newspaper).toBe(false);
			expect(typeof result.newspaperError).toBe("string");
			expect(audits[0].entry.newspaperError).toBe(result.newspaperError);
		});
	});
});
