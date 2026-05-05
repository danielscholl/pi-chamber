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

type TestForkCall = {
	entryId: string;
	position?: "before" | "at";
};

type TestContext = {
	cwd: string;
	hasUI: boolean;
	notifications: TestNotification[];
	statuses: TestStatus[];
	entries: Array<Record<string, unknown>>;
	leafId: string | null;
	selectValue?: string;
	selectOptions: string[][];
	forkCalls: TestForkCall[];
	forkResult: { cancelled?: boolean };
	forkThrows?: Error;
	waitForIdleCount: number;
	sessionManager: {
		getEntries(): Array<Record<string, unknown>>;
		getLeafId?(): string | null;
	};
	waitForIdle?(): Promise<void>;
	fork?(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: TestContext) => Promise<void> | void;
		},
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
	fs.writeFileSync(paths.agentPath, "# Operating Doctrine\n\nIDEA + Observatory.\n");
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
			// Mirror real Pi behavior: persisted custom entries become readable
			// via sessionManager.getEntries() in subsequent reads.
			entries.push({ type: "custom", customType: stream, data: entry });
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
		leafId: string | null;
		enableFork: boolean;
		forkResult: { cancelled?: boolean };
		forkThrows: Error;
	}> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const statuses: TestStatus[] = [];
	const selectOptions: string[][] = [];
	const forkCalls: TestForkCall[] = [];
	const ctx: TestContext = {
		cwd,
		hasUI: overrides.hasUI ?? true,
		notifications,
		statuses,
		entries,
		leafId: overrides.leafId ?? null,
		selectValue: overrides.selectValue,
		selectOptions,
		forkCalls,
		forkResult: overrides.forkResult ?? { cancelled: false },
		forkThrows: overrides.forkThrows,
		waitForIdleCount: 0,
		sessionManager: {
			getEntries() {
				return entries;
			},
			getLeafId() {
				return ctx.leafId;
			},
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

	if (overrides.enableFork) {
		ctx.waitForIdle = async () => {
			ctx.waitForIdleCount += 1;
		};
		ctx.fork = async (entryId, options) => {
			forkCalls.push({ entryId, position: options?.position });
			if (ctx.forkThrows) throw ctx.forkThrows;
			await options?.withSession?.(ctx);
			return ctx.forkResult;
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
	preMindLeafId?: string,
): Record<string, unknown> {
	return {
		type: "custom",
		customType: "mind-state",
		data: {
			active,
			...(slug ? { slug } : {}),
			...(preMindLeafId ? { preMindLeafId } : {}),
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
				expect(ctx.notifications[0].message).toContain("/leave");
				expect(ctx.notifications[0].message).toContain("/detach");
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
				// With no minds, autocomplete still surfaces `retire` so users
				// can discover it (and get the friendly "no minds to retire"
				// error). Anything else is filtered out.
				expect(
					command?.getArgumentCompletions?.("")?.map((i) => i.value),
				).toEqual(["retire"]);

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

	test("/mind <slug> activates a complete mind in-place and captures the pre-mind leaf id", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd, [], { leafId: "entry-42" });

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);

			expect(harness.appendEntries).toHaveLength(1);
			expect(harness.appendEntries[0]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: true,
					slug: "miss-moneypenny",
					mindPath: ".pi/minds/miss-moneypenny",
					preMindLeafId: "entry-42",
				}),
			});
			expect(ctx.statuses).toContainEqual({
				key: "mind",
				value: expect.stringContaining("miss-moneypenny"),
			});
			expect(ctx.notifications[0].message).toContain("Mind mode active");
			expect(ctx.notifications[0].message).toContain("/leave");
			expect(ctx.notifications[0].message).toContain("/detach");
		});
	});

	test("/mind <slug> activates in-place even when fork is available — no session swap", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd, [], {
				leafId: "entry-7",
				enableFork: true,
			});

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);

			expect(ctx.forkCalls).toHaveLength(0);
			expect(ctx.waitForIdleCount).toBe(0);
			expect(harness.appendEntries[0]).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: true,
					slug: "miss-moneypenny",
					preMindLeafId: "entry-7",
				}),
			});
		});
	});

	test("/leave clears state, status, and injects an explicit normal-assistant guard", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("leave")?.handler("", ctx);
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

	test("/leave keeps the conversation in the current session", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("leave")?.handler("", ctx);

			const lastEntry =
				harness.appendEntries[harness.appendEntries.length - 1];
			expect(lastEntry).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: false,
					slug: "miss-moneypenny",
					reason: "leave command",
				}),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("Mind mode off");
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("conversation continues in this session");
		});
	});

	test("/mind off is not a leave alias", async () => {
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
				value: expect.stringContaining("miss-moneypenny"),
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
				value: expect.stringContaining("jarvis"),
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
				value: expect.stringContaining("miss-moneypenny"),
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
			await harness.commands.get("leave")?.handler("", ctx);

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
			expect(second).toBeUndefined();
			expect(third).toBeUndefined();
		});
	});

	test("/detach forks at the captured pre-mind leaf id and switches into the fork", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries, {
				leafId: "entry-pre-mind",
				enableFork: true,
			});

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			// Activation persists active state + preMindLeafId; detach persists a
			// final "deactivated" state to the artifact session before forking.
			expect(harness.appendEntries).toEqual([
				expect.objectContaining({
					stream: "mind-state",
					entry: expect.objectContaining({
						active: true,
						slug: "miss-moneypenny",
						preMindLeafId: "entry-pre-mind",
					}),
				}),
				expect.objectContaining({
					stream: "mind-state",
					entry: expect.objectContaining({
						active: false,
						slug: "miss-moneypenny",
						reason: "detach",
					}),
				}),
			]);
			expect(ctx.forkCalls).toEqual([
				{ entryId: "entry-pre-mind", position: "at" },
			]);
			expect(ctx.waitForIdleCount).toBe(1);
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "mind",
				value: undefined,
			});
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("Detached from miss-moneypenny");
		});
	});

	test("/detach falls back to /leave when no pre-mind leaf id was captured", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			// leafId left null: getLeafId returns null, no preMindLeafId stored.
			const ctx = createContext(cwd, [], { enableFork: true });

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			expect(ctx.forkCalls).toHaveLength(0);
			expect(
				ctx.notifications.find((n) =>
					n.message.includes("no pre-mind fork point"),
				),
			).toEqual(
				expect.objectContaining({
					type: "warning",
				}),
			);
			// Fallback persists a leave-style deactivation entry.
			const last = harness.appendEntries[harness.appendEntries.length - 1];
			expect(last).toEqual({
				stream: "mind-state",
				entry: expect.objectContaining({
					active: false,
					slug: "miss-moneypenny",
					reason: "detach fallback",
				}),
			});
		});
	});

	test("/detach falls back to /leave when ctx.fork is unavailable", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const harness = createHarness();
			// enableFork: false → ctx.fork is undefined even though leafId is set.
			const ctx = createContext(cwd, [], { leafId: "entry-pre-mind" });

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			expect(
				ctx.notifications.find((n) =>
					n.message.includes("no pre-mind fork point"),
				),
			).toEqual(
				expect.objectContaining({
					type: "warning",
				}),
			);
		});
	});

	test("/detach reports a warning when the fork primitive throws", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries, {
				leafId: "entry-pre-mind",
				enableFork: true,
				forkThrows: new Error("fork unavailable"),
			});

			await harness.commands.get("mind")?.handler("miss-moneypenny", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			expect(ctx.forkCalls).toHaveLength(1);
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("Detach failed");
		});
	});

	test("/detach with no active mind reports nothing to detach", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd, [], { enableFork: true });

			await harness.commands.get("detach")?.handler("", ctx);

			expect(ctx.forkCalls).toHaveLength(0);
			expect(ctx.notifications).toEqual([
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("No active mind or room to detach"),
				}),
			]);
		});
	});
});
