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
import genesisExtension from "./index.ts";
import { resolveGenesisPaths, validateMind } from "./core.ts";

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

function createHarness() {
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
	const sentMessages: string[] = [];
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
		sendUserMessage(message: string) {
			sentMessages.push(message);
		},
		appendEntry(stream: string, entry: Record<string, unknown>) {
			auditEntries.push({ stream, entry });
		},
	};

	genesisExtension(pi as never);
	return { commands, tools, sentMessages, auditEntries };
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

function requestIdFromPrompt(prompt: string): string {
	const match = prompt.match(/requestId: ([0-9a-f-]+)/);
	expect(match).not.toBeNull();
	return match?.[1] ?? "";
}

function authoredGenesisParams(requestId: string) {
	return {
		requestId,
		description:
			"Miss Moneypenny, composed Chief of Staff for workspace operations.",
		soul: "# Miss Moneypenny\n\nI keep the operation composed, briefed, and moving.",
		agentInstructions:
			"# Runtime\n\nRead working memory first, brief crisply, track follow-through, and never store secrets.",
		memory:
			"# Memory\n\n- Name: Miss Moneypenny\n- Role: Chief of Staff\n- Purpose: briefings, priorities, follow-through, and operational memory.",
		rules:
			"# Rules\n\n1. Protect attention.\n2. State uncertainty plainly.\n3. Do not store secrets.",
		log: "# Log\n\n- Genesis completed through genesis_write_files.",
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

	test("/genesis starter slug starts the matching built-in preset", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis")?.handler("moneypenny", ctx);

			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0]).toContain("Your name: Miss Moneypenny");
			expect(harness.sentMessages[0]).toContain("Your slug: moneypenny");
			expect(harness.sentMessages[0]).toContain(
				"Research this character or persona from model-local knowledge",
			);
		});
	});

	test("/genesis:moneypenny starts a pending authoring request and completes only through genesis_write_files", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			expect(ctx.idleCalls).toBe(1);
			expect(harness.sentMessages).toHaveLength(1);
			const prompt = harness.sentMessages[0];
			expect(prompt).toContain("Your name: Miss Moneypenny");
			expect(prompt).toContain("Your slug: moneypenny");
			expect(prompt).toContain("Your role: Chief of Staff");
			expect(prompt).toContain('Character/voice: "Miss Moneypenny"');
			expect(prompt).toContain("Research this character or persona");
			expect(prompt).toContain("Do not browse or use network tools");
			expect(prompt).toContain("Capture the energy");
			expect(prompt).toContain("genesis_write_files exactly once");

			const paths = resolveGenesisPaths(cwd, "moneypenny");
			expect(fs.existsSync(paths.soulPath)).toBe(false);
			expect(fs.existsSync(paths.mindIndexPath)).toBe(false);
			expect(fs.existsSync(paths.memoryPath)).toBe(true);
			expect(fs.readFileSync(paths.memoryPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.rulesPath)).toBe(true);
			expect(fs.readFileSync(paths.rulesPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.logPath)).toBe(true);
			expect(fs.readFileSync(paths.logPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.shimPath)).toBe(false);

			const requestId = requestIdFromPrompt(prompt);
			const toolResult = await harness.tools
				.get("genesis_write_files")
				?.execute("tool-call-1", authoredGenesisParams(requestId));

			expect(toolResult).toEqual(expect.objectContaining({ terminate: true }));
			expect(JSON.stringify(toolResult)).toContain(
				"Try direct chat: /mind moneypenny",
			);
			expect(JSON.stringify(toolResult)).toContain(
				"Try delegated task: /run moneypenny",
			);
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
		});
	});

	test("/genesis UI Miss Moneypenny selection uses the same pending prompt flow", async () => {
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
			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0]).toContain("Your slug: moneypenny");
			expect(
				fs.existsSync(resolveGenesisPaths(cwd, "moneypenny").shimPath),
			).toBe(false);
		});
	});

	test("/genesis:mycroft starts the Mycroft preset", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:mycroft")?.handler("", ctx);

			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0]).toContain("Your name: Mycroft");
			expect(harness.sentMessages[0]).toContain("Your role: Research Partner");
			expect(harness.sentMessages[0]).toContain("Mycroft Holmes");
			expect(harness.sentMessages[0]).toContain("pattern");
		});
	});

	test("/genesis:jarvis starts the Jarvis preset", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:jarvis")?.handler("", ctx);

			expect(harness.sentMessages).toHaveLength(1);
			expect(harness.sentMessages[0]).toContain("Your name: Jarvis");
			expect(harness.sentMessages[0]).toContain(
				"Your role: Engineering Partner",
			);
			expect(harness.sentMessages[0]).toContain("J.A.R.V.I.S.'s");
			expect(harness.sentMessages[0]).toContain("diagnostics");
		});
	});

	test("custom Genesis args still create a custom pending request", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd, { hasUI: false });

			await harness.commands
				.get("genesis")
				?.handler(
					'name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
					ctx,
				);

			expect(harness.sentMessages).toHaveLength(1);
			const prompt = harness.sentMessages[0];
			expect(prompt).toContain("Your name: Ariadne");
			expect(prompt).toContain("Your slug: ariadne");
			expect(prompt).toContain("Your role: OSDU architecture scout");
			expect(prompt).toContain('Character/voice: "calm systems thinker"');
			expect(prompt).not.toContain("Miss Moneypenny");
			const paths = resolveGenesisPaths(cwd, "ariadne");
			expect(fs.existsSync(paths.soulPath)).toBe(false);
			expect(fs.existsSync(paths.memoryPath)).toBe(true);
			expect(fs.readFileSync(paths.memoryPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.shimPath)).toBe(false);
		});
	});

	test("existing Miss Moneypenny mind blocks a new preset request", async () => {
		await withTempProject(async (cwd) => {
			const paths = resolveGenesisPaths(cwd, "moneypenny");
			fs.mkdirSync(paths.mindPath, { recursive: true });
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("genesis:moneypenny")?.handler("", ctx);

			expect(harness.sentMessages).toHaveLength(0);
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

			expect(harness.sentMessages).toHaveLength(0);
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
