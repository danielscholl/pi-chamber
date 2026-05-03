// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { beforeEach, describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import process from "node:process";
import { createMindStructure, resolveGenesisPaths } from "../genesis/core.ts";
import mindModeExtension from "./index.ts";
import { __resetForTests as resetSessionExit } from "../shared/session-exit.ts";

type TestNotification = {
	message: string;
	type?: "info" | "warning" | "error";
};

type TestStatus = {
	key: string;
	value: string | undefined;
};

type TestNewSession = {
	parentSession?: string;
	customEntries: Array<{ customType: string; data?: unknown }>;
	sessionNames: string[];
};

type TestSwitchSession = {
	sessionPath: string;
};

type TestContext = {
	cwd: string;
	hasUI: boolean;
	notifications: TestNotification[];
	statuses: TestStatus[];
	entries: Array<Record<string, unknown>>;
	selectValue?: string;
	selectOptions: string[][];
	sessionFile?: string;
	newSessions: TestNewSession[];
	switches: TestSwitchSession[];
	waitForIdleCount: number;
	sessionManager: {
		getEntries(): Array<Record<string, unknown>>;
		getSessionFile?(): string | undefined;
	};
	waitForIdle?(): Promise<void>;
	newSession?(options?: {
		parentSession?: string;
		setup?: (sessionManager: {
			appendCustomEntry(customType: string, data?: unknown): string;
			appendSessionInfo(name: string): string;
		}) => Promise<void> | void;
		withSession?: (ctx: TestContext) => Promise<void> | void;
	}): Promise<{ cancelled?: boolean }>;
	switchSession?(
		sessionPath: string,
		options?: { withSession?: (ctx: TestContext) => Promise<void> | void },
	): Promise<{ cancelled?: boolean }>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select(prompt: string, options: string[]): Promise<string | undefined>;
		setStatus(key: string, value: string | undefined): void;
	};
};

function withTempProject<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mind-test-"));
	return Promise.resolve()
		.then(() => fn(cwd))
		.finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

function writeCompleteMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	createMindStructure(paths);
	fs.writeFileSync(paths.soulPath, `# ${slug}\n\nI am ${slug}.\n`);
	fs.writeFileSync(
		paths.mindIndexPath,
		"# Mind Index\n\n- SOUL.md: identity.\n",
	);
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nCurated memory.\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- Stay composed.\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- Genesis completed.\n");
	return paths;
}

function createHarness(entries: Array<Record<string, unknown>> = []) {
	const commands = new Map<
		string,
		{
			handler: (args: string, ctx: TestContext) => Promise<void>;
			getArgumentCompletions?: (
				prefix: string,
			) => Array<{ value: string; label: string; description?: string }> | null;
		}
	>();
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: TestContext) => Promise<unknown>>
	>();
	const appendEntries: Array<{
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
		on(eventName: string, handler: unknown) {
			const list = handlers.get(eventName) ?? [];
			list.push(
				handler as (event: unknown, ctx: TestContext) => Promise<unknown>,
			);
			handlers.set(eventName, list);
		},
		appendEntry(stream: string, entry: Record<string, unknown>) {
			appendEntries.push({ stream, entry });
		},
	};

	mindModeExtension(pi as never);
	return { commands, handlers, appendEntries, entries };
}

function createContext(
	cwd: string,
	entries: Array<Record<string, unknown>> = [],
	overrides: Partial<{
		hasUI: boolean;
		selectValue: string;
		sessionFile: string;
		enableSessionControl: boolean;
	}> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const statuses: TestStatus[] = [];
	const selectOptions: string[][] = [];
	const newSessions: TestNewSession[] = [];
	const switches: TestSwitchSession[] = [];
	const ctx: TestContext = {
		cwd,
		hasUI: overrides.hasUI ?? true,
		notifications,
		statuses,
		entries,
		selectValue: overrides.selectValue,
		selectOptions,
		sessionFile: overrides.sessionFile,
		newSessions,
		switches,
		waitForIdleCount: 0,
		sessionManager: {
			getEntries() {
				return entries;
			},
			getSessionFile: overrides.sessionFile
				? () => overrides.sessionFile
				: undefined,
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			async select(_prompt, options) {
				ctx.selectOptions.push(options);
				return ctx.selectValue;
			},
			setStatus(key, value) {
				statuses.push({ key, value });
			},
		},
	};

	if (overrides.enableSessionControl) {
		ctx.waitForIdle = async () => {
			ctx.waitForIdleCount += 1;
		};
		ctx.newSession = async (options) => {
			const record: TestNewSession = {
				parentSession: options?.parentSession,
				customEntries: [],
				sessionNames: [],
			};
			newSessions.push(record);
			await options?.setup?.({
				appendCustomEntry(customType, data) {
					record.customEntries.push({ customType, data });
					return `custom-${record.customEntries.length}`;
				},
				appendSessionInfo(name) {
					record.sessionNames.push(name);
					return `session-info-${record.sessionNames.length}`;
				},
			});
			await options?.withSession?.(ctx);
			return { cancelled: false };
		};
		ctx.switchSession = async (sessionPath, options) => {
			switches.push({ sessionPath });
			await options?.withSession?.(ctx);
			return { cancelled: false };
		};
	}

	return ctx;
}

async function runHandler(
	harness: ReturnType<typeof createHarness>,
	eventName: string,
	event: unknown,
	ctx: TestContext,
) {
	let result: unknown;
	for (const handler of harness.handlers.get(eventName) ?? []) {
		result = await handler(event, ctx);
	}
	return result;
}

function stateEntry(
	active: boolean,
	slug?: string,
	returnSessionFile?: string,
): Record<string, unknown> {
	return {
		type: "custom",
		customType: "mind-state",
		data: {
			active,
			...(slug ? { slug } : {}),
			...(returnSessionFile ? { returnSessionFile } : {}),
		},
	};
}

describe("mind extension", () => {
	beforeEach(() => {
		resetSessionExit();
	});

	test("/mind provides argument completions and help", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const originalCwd = process.cwd();
			process.chdir(cwd);
			try {
				const harness = createHarness();
				const command = harness.commands.get("mind");
				expect(command?.getArgumentCompletions?.("a")).toEqual([
					expect.objectContaining({ value: "ariadne" }),
				]);

				const ctx = createContext(cwd);
				await command?.handler("help", ctx);
				expect(ctx.notifications[0]).toEqual(
					expect.objectContaining({
						type: "info",
						message: expect.stringContaining("Usage: /mind <slug>"),
					}),
				);
				expect(ctx.notifications[0].message).toContain("ariadne");
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	test("/mind explains how to create a mind when none exist", async () => {
		await withTempProject(async (cwd) => {
			const originalCwd = process.cwd();
			try {
				process.chdir(cwd);
				const harness = createHarness();
				const command = harness.commands.get("mind");
				expect(command?.getArgumentCompletions?.("")).toEqual(null);

				const ctx = createContext(cwd);
				await command?.handler("", ctx);
				expect(ctx.notifications[0]).toEqual(
					expect.objectContaining({
						type: "warning",
						message: expect.stringContaining("Create one with /genesis"),
					}),
				);

				const createCtx = createContext(cwd);
				await command?.handler("create", createCtx);
				expect(createCtx.notifications[0]).toEqual(
					expect.objectContaining({
						type: "info",
						message: expect.stringContaining("/mind activates"),
					}),
				);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	test("/mind <slug> activates a complete mind and appends state", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);

			expect(harness.appendEntries).toHaveLength(1);
			expect(harness.appendEntries[0]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: true,
					slug: "miss-moneypenny",
					mindPath: ".pi/minds/miss-moneypenny",
				}),
			});
			expect(ctx.statuses).toContainEqual({
				key: "mind",
				value: " miss-moneypenny",
			});
			expect(ctx.notifications[0].message).toContain("Mind mode active");
		});
	});

	test("/mind <slug> starts a dedicated mind session when session control is available", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd, [], {
				sessionFile: "/sessions/normal.jsonl",
				enableSessionControl: true,
			});

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);

			expect(harness.appendEntries).toHaveLength(0);
			expect(ctx.waitForIdleCount).toBe(1);
			expect(ctx.newSessions).toHaveLength(1);
			expect(ctx.newSessions[0].parentSession).toBe("/sessions/normal.jsonl");
			expect(ctx.newSessions[0].sessionNames).toEqual([
				"Mind: miss-moneypenny",
			]);
			expect(ctx.newSessions[0].customEntries).toEqual([
				expect.objectContaining({
					customType: "mind-state",
					data: expect.objectContaining({
						active: true,
						slug: "miss-moneypenny",
						returnSessionFile: "/sessions/normal.jsonl",
					}),
				}),
			]);
			expect(ctx.statuses).toContainEqual({
				key: "mind",
				value: " miss-moneypenny",
			});
			expect(ctx.notifications[0].message).toContain(
				"dedicated session: miss-moneypenny",
			);
		});
	});

	test("/exit returns from an isolated mind session to the previous session", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const entries = [
				stateEntry(true, "miss-moneypenny", "/sessions/normal.jsonl"),
			];
			const harness = createHarness(entries);
			const ctx = createContext(cwd, entries, {
				sessionFile: "/sessions/mind.jsonl",
				enableSessionControl: true,
			});

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			await harness.commands.get("exit")?.handler("", ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: false,
					slug: "miss-moneypenny",
					returnSessionFile: "/sessions/normal.jsonl",
				}),
			});
			expect(ctx.waitForIdleCount).toBe(1);
			expect(ctx.switches).toEqual([{ sessionPath: "/sessions/normal.jsonl" }]);
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(ctx.notifications[0].message).toContain(
				"Returned from miss-moneypenny",
			);
		});
	});

	test("/exit clears state, status, and injects an explicit normal-assistant guard", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("exit")?.handler("", ctx);
			const result = (await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			)) as { systemPrompt: string };

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: false,
					slug: "miss-moneypenny",
				}),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(result.systemPrompt).toContain("# Genesis Mind Mode Off");
			expect(result.systemPrompt).toContain(
				'The Genesis mind "miss-moneypenny" is not active',
			);
			expect(result.systemPrompt).toContain(
				"Respond as the normal Pi coding assistant",
			);
		});
	});

	test("/exit leaves an active mind", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("exit")?.handler("", ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: false,
					slug: "miss-moneypenny",
					reason: "exit command",
				}),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(ctx.notifications[ctx.notifications.length - 1].message).toContain(
				"Mind mode off",
			);
		});
	});

	test("/mind off is not an exit alias", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			const before = harness.appendEntries.length;
			await harness.commands.get("mind")?.handler("off", ctx);

			expect(harness.appendEntries).toHaveLength(before);
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: " miss-moneypenny",
			});
			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining('Genesis mind "off" is not ready'),
				}),
			);
		});
	});

	test("/mind list reports available complete minds", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("list", ctx);

			expect(ctx.notifications).toEqual([
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("- ariadne"),
				}),
			]);
			expect(ctx.notifications[0].message).toContain("- miss-moneypenny");
		});
	});

	test("/mind selector only lists created minds and activates the selection", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "jarvis");
			writeCompleteMind(cwd, "moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd, [], { selectValue: "jarvis" });

			await harness.commands.get("mind")?.handler("", ctx);

			expect(ctx.selectOptions[0]).toEqual(["jarvis", "moneypenny"]);
			expect(ctx.selectOptions[0]).not.toContain("(off)");
			expect(ctx.statuses).toContainEqual({
				key: "mind",
				value: " jarvis",
			});
		});
	});

	test("before_agent_start appends the active mind system prompt", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);

			const result = (await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base prompt" },
				ctx,
			)) as { systemPrompt: string };

			expect(result.systemPrompt).toStartWith("base prompt");
			expect(result.systemPrompt).toContain(
				"# Active Genesis Mind — miss-moneypenny",
			);
			expect(result.systemPrompt).toContain("I am miss-moneypenny");
			expect(result.systemPrompt).toContain("not a delegated subagent task");
		});
	});

	test("missing files during activation show an error and do not activate", async () => {
		await withTempProject(async (cwd) => {
			const paths = resolveGenesisPaths(cwd, "broken");
			createMindStructure(paths);
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("broken", ctx);
			const result = await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining(
						'Genesis mind "broken" is not ready for /mind',
					),
				}),
			);
			expect(harness.appendEntries).toHaveLength(0);
			expect(result).toBeUndefined();
		});
	});

	test("session_start restores the latest active state", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const entries = [stateEntry(true, "miss-moneypenny")];
			const harness = createHarness(entries);
			const ctx = createContext(cwd, entries);

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			const result = (await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			)) as { systemPrompt: string };

			expect(ctx.statuses).toContainEqual({
				key: "mind",
				value: " miss-moneypenny",
			});
			expect(result.systemPrompt).toContain("# Active Genesis Mind");
		});
	});

	test("session_start honors a later inactive state and keeps the normal-assistant guard", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const entries = [
				stateEntry(true, "miss-moneypenny"),
				stateEntry(false, "miss-moneypenny"),
			];
			const harness = createHarness(entries);
			const ctx = createContext(cwd, entries);

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			const result = (await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			)) as { systemPrompt: string };

			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(result.systemPrompt).toContain("# Genesis Mind Mode Off");
			expect(result.systemPrompt).toContain(
				'The Genesis mind "miss-moneypenny" is not active',
			);
		});
	});

	test("Mind Mode Off guard fires once then sunsets", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("exit")?.handler("", ctx);

			const first = (await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			)) as { systemPrompt: string };
			const second = await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			);
			const third = await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			);

			expect(first.systemPrompt).toContain("# Genesis Mind Mode Off");
			// After the first fire, the guard is consumed: the model has been
			// told once not to roleplay; further turns rely on base instructions.
			expect(second).toBeUndefined();
			expect(third).toBeUndefined();
		});
	});

	test("returning from a dedicated mind session does not pollute the parent with a guard", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const entries = [
				stateEntry(true, "miss-moneypenny", "/sessions/normal.jsonl"),
			];
			const harness = createHarness(entries);
			const ctx = createContext(cwd, entries, {
				sessionFile: "/sessions/mind.jsonl",
				enableSessionControl: true,
			});

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			await harness.commands.get("exit")?.handler("", ctx);

			// After /exit triggers switchSession back to the parent, the parent
			// session never had this mind active in its own transcript, so the
			// next before_agent_start should not inject any guard.
			const result = await runHandler(
				harness,
				"before_agent_start",
				{ systemPrompt: "base" },
				ctx,
			);
			expect(result).toBeUndefined();
		});
	});
});
