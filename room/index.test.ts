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
import chamberRoomExtension from "./index.ts";
import { ROOM_CUSTOM_TYPES } from "./ui.ts";
import { createMindStructure, resolveGenesisPaths } from "../genesis/core.ts";
import { __resetForTests as resetSessionExit } from "../shared/session-exit.ts";

type TestNotification = {
	message: string;
	type?: "info" | "warning" | "error";
};

type TestStatus = {
	key: string;
	value: string | undefined;
};

type WidgetCall = {
	key: string;
	content: unknown;
	options?: Record<string, unknown>;
};

type SentMessage = {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: unknown;
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
	widgets: WidgetCall[];
	workingIndicators: Array<{ frames?: string[]; intervalMs?: number } | undefined>;
	entries: Array<Record<string, unknown>>;
	selectValues: Array<string | undefined>;
	inputValues: Array<string | undefined>;
	leafId: string | null;
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
		input(prompt: string, defaultValue?: string): Promise<string | undefined>;
		setStatus(key: string, value: string | undefined): void;
		setWidget(
			key: string,
			content: unknown,
			options?: Record<string, unknown>,
		): void;
		setWorkingIndicator(options?: {
			frames?: string[];
			intervalMs?: number;
		}): void;
	};
};

function withTempProject<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "room-test-"));
	return Promise.resolve()
		.then(() => fn(cwd))
		.finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

function writeCompleteMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	createMindStructure(paths);
	fs.writeFileSync(paths.soulPath, `# ${slug}\n\nI am ${slug}.\n`);
	fs.writeFileSync(paths.mindIndexPath, "# Mind Index\n\n- SOUL.md\n");
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nCurated memory.\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- Stay composed.\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- Genesis completed.\n");
	return paths;
}

function createHarness(
	entries: Array<Record<string, unknown>> = [],
) {
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
	const messageRenderers = new Map<string, unknown>();
	const sentMessages: SentMessage[] = [];

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
			// Mirror real Pi: persisted custom entries become readable via
			// sessionManager.getEntries() in subsequent reads. Tests that share
			// the entries array between harness and context see this state.
			entries.push({ type: "custom", customType: stream, data: entry });
		},
		registerMessageRenderer(customType: string, renderer: unknown) {
			messageRenderers.set(customType, renderer);
		},
		sendMessage(message: SentMessage) {
			sentMessages.push(message);
		},
	};

	chamberRoomExtension(pi as never);
	return {
		commands,
		handlers,
		appendEntries,
		messageRenderers,
		sentMessages,
		entries,
	};
}

function createContext(
	cwd: string,
	entries: Array<Record<string, unknown>> = [],
	overrides: Partial<{
		hasUI: boolean;
		selectValues: Array<string | undefined>;
		inputValues: Array<string | undefined>;
		leafId: string | null;
		enableFork: boolean;
		forkResult: { cancelled?: boolean };
		forkThrows: Error;
	}> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const statuses: TestStatus[] = [];
	const widgets: WidgetCall[] = [];
	const workingIndicators: Array<
		{ frames?: string[]; intervalMs?: number } | undefined
	> = [];
	const forkCalls: TestForkCall[] = [];
	const ctx: TestContext = {
		cwd,
		hasUI: overrides.hasUI ?? true,
		notifications,
		statuses,
		widgets,
		workingIndicators,
		entries,
		selectValues: overrides.selectValues ?? [],
		inputValues: overrides.inputValues ?? [],
		leafId: overrides.leafId ?? null,
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
				const next = ctx.selectValues.shift();
				return next ?? options[0];
			},
			async input(_prompt, defaultValue) {
				const next = ctx.inputValues.shift();
				return next ?? defaultValue;
			},
			setStatus(key, value) {
				statuses.push({ key, value });
			},
			setWidget(key, content, options) {
				widgets.push({ key, content, options });
			},
			setWorkingIndicator(options) {
				workingIndicators.push(options);
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

function roomStateEntry(
	data: Record<string, unknown>,
): Record<string, unknown> {
	return {
		type: "custom",
		customType: "room-state",
		data,
	};
}

describe("room extension", () => {
	beforeEach(() => {
		resetSessionExit();
	});

	test("registers room, leave, detach, and director-shortcut commands", () => {
		const harness = createHarness();
		expect([...harness.commands.keys()].sort()).toEqual([
			"detach",
			"halt",
			"inject",
			"leave",
			"next",
			"room",
		]);
	});

	test("registers all four chamber message renderers", () => {
		const harness = createHarness();
		expect([...harness.messageRenderers.keys()].sort()).toEqual(
			[
				ROOM_CUSTOM_TYPES.mindSpeech,
				ROOM_CUSTOM_TYPES.moderatorDecision,
				ROOM_CUSTOM_TYPES.roundMetrics,
				ROOM_CUSTOM_TYPES.userMessage,
			].sort(),
		);
	});

	test("registers an input handler", () => {
		const harness = createHarness();
		expect(harness.handlers.has("input")).toBe(true);
	});

	test("does NOT register before_agent_start (extension owns turn now)", () => {
		const harness = createHarness();
		expect(harness.handlers.has("before_agent_start")).toBe(false);
	});

	test("/room autocomplete only surfaces top-level subcommands", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const originalCwd = process.cwd();
			process.chdir(cwd);
			try {
				const harness = createHarness();
				const command = harness.commands.get("room");
				expect(
					command?.getArgumentCompletions?.("")?.map((i) => i.value),
				).toEqual(["status", "list", "reset", "help"]);
				expect(command?.getArgumentCompletions?.("o")).toEqual(null);
				expect(
					command?.getArgumentCompletions?.("re")?.map((i) => i.value),
				).toEqual(["reset"]);
			} finally {
				process.chdir(originalCwd);
			}
		});
	});

	test("/room help describes the picker-first surface", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("help", ctx);
			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("/room"),
				}),
			);
			expect(ctx.notifications[0].message).toContain(".pi/rooms/");
			expect(ctx.notifications[0].message).toContain("picker");
		});
	});

	test("/room list shows saved-room emptiness and lists Genesis minds", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("list", ctx);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining("No saved rooms yet"),
				}),
			);
			expect(ctx.notifications[0].message).toContain(
				"Available Genesis minds: ariadne, mycroft",
			);
		});
	});

	test("/room on concurrent all persists active state and sets status", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			expect(harness.appendEntries).toHaveLength(1);
			expect(harness.appendEntries[0]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: true,
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
				}),
			});
			expect(ctx.statuses).toContainEqual({
				key: "room",
				value: " room concurrent:2",
			});
			expect(ctx.notifications[0].message).toContain("Unsaved one-off room");
		});
	});

	test("/room on activates the participant widget", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			expect(lastWidget?.key).toBe("room-stage");
			expect(Array.isArray(lastWidget?.content)).toBe(true);
			expect((lastWidget?.content as string[]).join(" ")).toContain("ariadne");
			expect((lastWidget?.content as string[]).join(" ")).toContain("mycroft");
		});
	});

	test("/room mode sequential changes active mode and persists", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			await harness.commands.get("room")?.handler("mode sequential", ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({ active: true, mode: "sequential" }),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "room",
				value: " room sequential:2",
			});
		});
	});

	test("/room minds <slug> rejects unknown minds", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			const before = harness.appendEntries.length;

			await harness.commands.get("room")?.handler("minds unknown", ctx);

			expect(harness.appendEntries).toHaveLength(before);
			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("Unknown or incomplete"),
				}),
			);
		});
	});

	test("/room reset with no args and no active room warns the user", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("reset", ctx);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining("No active room"),
				}),
			);
		});
	});

	test("/room reset <slug> drops per-mind sessions and reports the count", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const sessionsDir = path.join(cwd, ".pi/rooms/daily/sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "ariadne.session.jsonl"),
				"{}",
				"utf-8",
			);
			fs.writeFileSync(
				path.join(sessionsDir, "mycroft.session.jsonl"),
				"{}",
				"utf-8",
			);

			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("reset daily", ctx);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("Dropped 2 per-mind session"),
				}),
			);
			expect(fs.existsSync(sessionsDir)).toBe(false);
		});
	});

	test("/room reset <slug> with no sessions reports zero", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("reset daily", ctx);

			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("No per-mind sessions to drop"),
				}),
			);
		});
	});

	test("/room moderator subcommand is removed (chairman is the built-in moderator)", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on group-chat all", ctx);
			await harness.commands.get("room")?.handler("moderator mycroft", ctx);
			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.not.stringContaining("must be one of"),
				}),
			);
			expect(
				harness.appendEntries[harness.appendEntries.length - 1].entry,
			).not.toHaveProperty("moderator", "mycroft");
		});
	});

	test("/room on group-chat does not prompt for a moderator", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on group-chat all", ctx);

			expect(ctx.selectValues).toEqual([]);
			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: true,
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
				}),
			});
			expect(
				harness.appendEntries[harness.appendEntries.length - 1].entry
					.moderator,
			).toBeUndefined();
			const activationNote = ctx.notifications.find((n) =>
				n.message.includes("Room active"),
			);
			expect(activationNote?.message).toContain("chairman");
		});
	});

	test("/room off is rejected in favor of /leave or /detach", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			const before = harness.appendEntries.length;

			await harness.commands.get("room")?.handler("off", ctx);

			expect(harness.appendEntries).toHaveLength(before);
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "room",
				value: " room concurrent:1",
			});
			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringMatching(/Use \/(leave|exit)/),
				}),
			);
		});
	});

	test("/leave leaves an active room and clears the widget", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			await harness.commands.get("leave")?.handler("", ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: false,
					mode: "concurrent",
					reason: "leave command",
				}),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "room",
				value: undefined,
			});
			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			expect(lastWidget?.key).toBe("room-stage");
			expect(lastWidget?.content).toBeUndefined();
			expect(ctx.notifications[ctx.notifications.length - 1].message).toContain(
				"Room off",
			);
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("Conversation continues in this session");
		});
	});

	test("/room on activates in-place even when fork is available — no session swap", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries, {
				leafId: "entry-pre-room",
				enableFork: true,
			});

			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			expect(ctx.forkCalls).toHaveLength(0);
			expect(ctx.waitForIdleCount).toBe(0);
			expect(harness.appendEntries[0]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: true,
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
					preRoomLeafId: "entry-pre-room",
				}),
			});
		});
	});

	test("/detach forks at the captured pre-room leaf id and switches into the fork", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries, {
				leafId: "entry-pre-room",
				enableFork: true,
			});

			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			expect(harness.appendEntries[0]).toEqual(
				expect.objectContaining({
					stream: "room-state",
					entry: expect.objectContaining({
						active: true,
						preRoomLeafId: "entry-pre-room",
					}),
				}),
			);
			const lastEntry =
				harness.appendEntries[harness.appendEntries.length - 1];
			expect(lastEntry).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: false,
					reason: "detach",
				}),
			});
			expect(ctx.forkCalls).toEqual([
				{ entryId: "entry-pre-room", position: "at" },
			]);
			expect(ctx.waitForIdleCount).toBe(1);
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "room",
				value: undefined,
			});
			expect(
				ctx.notifications[ctx.notifications.length - 1].message,
			).toContain("Detached from room");
		});
	});

	test("/detach falls back to /leave when no pre-room leaf id was captured", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const sharedEntries: Array<Record<string, unknown>> = [];
			const harness = createHarness(sharedEntries);
			const ctx = createContext(cwd, sharedEntries, { enableFork: true });

			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			await harness.commands.get("detach")?.handler("", ctx);

			expect(ctx.forkCalls).toHaveLength(0);
			expect(
				ctx.notifications.find((n) =>
					n.message.includes("no pre-room fork point"),
				),
			).toEqual(
				expect.objectContaining({
					type: "warning",
				}),
			);
			const lastEntry =
				harness.appendEntries[harness.appendEntries.length - 1];
			expect(lastEntry).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: false,
					reason: "detach fallback",
				}),
			});
		});
	});

	test("/detach with no active room reports nothing to detach", async () => {
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

	test("session_start restores latest active room state", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const entries = [
				roomStateEntry({
					active: true,
					mode: "sequential",
					participants: ["ariadne", "mycroft"],
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);

			expect(ctx.statuses).toContainEqual({
				key: "room",
				value: " room sequential:2",
			});
			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			expect(lastWidget?.key).toBe("room-stage");
		});
	});

	test("session_start disables stale state when a mind is incomplete", async () => {
		await withTempProject(async (cwd) => {
			const paths = writeCompleteMind(cwd, "ariadne");
			const entries = [
				roomStateEntry({
					active: true,
					mode: "concurrent",
					participants: ["ariadne"],
				}),
			];
			fs.rmSync(paths.logPath);
			const harness = createHarness();
			const ctx = createContext(cwd, entries);

			await runHandler(harness, "session_start", { reason: "startup" }, ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: false,
					reason: "restore validation failed",
				}),
			});
			expect(ctx.statuses[ctx.statuses.length - 1]).toEqual({
				key: "room",
				value: undefined,
			});
			expect(ctx.notifications[0]).toEqual(
				expect.objectContaining({ type: "warning" }),
			);
		});
	});

	test("input handler ignores slash commands", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "/room status", source: "interactive" },
				ctx,
			)) as { action: string };
			expect(result?.action).toBe("continue");
		});
	});

	test("input handler ignores extension-source input", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "hello room", source: "extension" },
				ctx,
			)) as { action: string };
			expect(result?.action).toBe("continue");
		});
	});

	test("input handler returns continue when no room is active", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "hello", source: "interactive" },
				ctx,
			)) as { action: string };
			expect(result?.action).toBe("continue");
		});
	});

	test("input handler claims the turn when room is active", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "what is up", source: "interactive" },
				ctx,
			)) as { action: string };
			expect(result?.action).toBe("handled");
			// The user message is dispatched immediately for the transcript.
			expect(
				harness.sentMessages.some(
					(m) => m.customType === ROOM_CUSTOM_TYPES.userMessage,
				),
			).toBe(true);
		});
	});

	test("/room wizard with a name writes a saved room and activates it", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd, [], {
				selectValues: ["concurrent — parallel takes from each mind"],
				inputValues: ["Design Review", "all"],
			});

			await harness.commands.get("room")?.handler("", ctx);

			const configPath = path.join(cwd, ".pi/rooms/design-review/room.json");
			expect(fs.existsSync(configPath)).toBe(true);
			const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
			expect(saved).toEqual(
				expect.objectContaining({
					slug: "design-review",
					name: "Design Review",
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
				}),
			);
			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: true,
					mode: "concurrent",
					slug: "design-review",
				}),
			});
			expect(ctx.notifications[0].message).toContain(
				`Saved as "design-review"`,
			);
		});
	});

	test("/room wizard with no name keeps the room ephemeral", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd, [], {
				selectValues: ["concurrent — parallel takes from each mind"],
				inputValues: ["", "all"],
			});

			await harness.commands.get("room")?.handler("", ctx);

			expect(fs.existsSync(path.join(cwd, ".pi/rooms"))).toBe(false);
			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({ active: true, mode: "concurrent" }),
			});
			expect(
				harness.appendEntries[harness.appendEntries.length - 1].entry.slug,
			).toBeUndefined();
			expect(ctx.notifications[0].message).toContain("Unsaved one-off room");
		});
	});

	test("/halt warns when no round is in flight", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			await harness.commands.get("halt")?.handler("", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining("No in-flight"),
				}),
			);
		});
	});

	test("/halt warns when no room is active", async () => {
		await withTempProject(async (cwd) => {
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("halt")?.handler("", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining("No active"),
				}),
			);
		});
	});

	test("/next rejects when room mode is not group-chat", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			await harness.commands.get("next")?.handler("ariadne", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("group-chat"),
				}),
			);
		});
	});

	test("/next rejects unknown slug in group-chat", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on group-chat all", ctx);

			await harness.commands.get("next")?.handler("nobody", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("must be one of"),
				}),
			);
		});
	});

	test("/next accepts a valid participant slug", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on group-chat all", ctx);

			await harness.commands.get("next")?.handler("mycroft", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("next speaker = mycroft"),
				}),
			);
		});
	});

	test("/next rejects the saved-room synthesizer (it would silently no-op during routing)", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			// Hand-craft a saved room where ariadne IS a participant AND the
			// designated synthesizer.
			const roomDir = path.join(cwd, ".pi/rooms/board");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "board",
					name: "board",
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					synthesizer: "ariadne",
				}),
				"utf-8",
			);
			// Activate "board" via session_start restore so activeRoom.slug === "board".
			const entries = [
				roomStateEntry({
					active: true,
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					slug: "board",
					name: "board",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			ctx.notifications.length = 0;

			await harness.commands.get("next")?.handler("ariadne", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("active moderator"),
				}),
			);
		});
	});

	test("/next accepts the non-moderator participant when synthesizer is set", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const roomDir = path.join(cwd, ".pi/rooms/board");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "board",
					name: "board",
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					synthesizer: "ariadne",
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					slug: "board",
					name: "board",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			ctx.notifications.length = 0;

			await harness.commands.get("next")?.handler("mycroft", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("next speaker = mycroft"),
				}),
			);
		});
	});

	test("/next accepts a valid speaker in open-floor mode", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const roomDir = path.join(cwd, ".pi/rooms/town-hall");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "town-hall",
					name: "town-hall",
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					slug: "town-hall",
					name: "town-hall",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			ctx.notifications.length = 0;

			await harness.commands.get("next")?.handler("mycroft", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("next speaker = mycroft"),
				}),
			);
		});
	});

	test("/inject accepts text in open-floor mode", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const roomDir = path.join(cwd, ".pi/rooms/town-hall");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "town-hall",
					name: "town-hall",
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					slug: "town-hall",
					name: "town-hall",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			ctx.notifications.length = 0;

			await harness.commands.get("inject")?.handler("focus on cost", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("focus on cost"),
				}),
			);
		});
	});

	test("session_start in open-floor with chairman opener surfaces chairman as moderator", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const roomDir = path.join(cwd, ".pi/rooms/town-hall");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "town-hall",
					name: "town-hall",
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					opener: "chairman",
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "open-floor",
					participants: ["ariadne", "mycroft"],
					slug: "town-hall",
					name: "town-hall",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			const widgetText = (lastWidget?.content as string[]).join(" ");
			expect(widgetText).toContain("chairman");
			expect(widgetText).toContain("(mod)");
		});
	});

	test("session_start with a synthesizer puts that mind in the participant widget as moderator", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			// Hand-craft a saved room with mycroft as the synthesizer (so the
			// chairman is replaced by a participant Genesis mind).
			const roomDir = path.join(cwd, ".pi/rooms/board");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "board",
					name: "board",
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					synthesizer: "mycroft",
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					slug: "board",
					name: "board",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			const widgetText = (lastWidget?.content as string[]).join(" ");
			expect(widgetText).toContain("ariadne");
			expect(widgetText).toContain("mycroft");
			expect(widgetText).toContain("(mod)");
		});
	});

	test("session_start in group-chat without a synthesizer surfaces chairman in the widget", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const roomDir = path.join(cwd, ".pi/rooms/board");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify({
					slug: "board",
					name: "board",
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
				}),
				"utf-8",
			);
			const entries = [
				roomStateEntry({
					active: true,
					mode: "group-chat",
					participants: ["ariadne", "mycroft"],
					slug: "board",
					name: "board",
				}),
			];
			const harness = createHarness();
			const ctx = createContext(cwd, entries);
			await runHandler(harness, "session_start", { reason: "startup" }, ctx);
			const lastWidget = ctx.widgets[ctx.widgets.length - 1];
			const widgetText = (lastWidget?.content as string[]).join(" ");
			// Chairman is the implicit moderator and should be tracked so
			// mid-round status updates can find a tracker for it.
			expect(widgetText).toContain("chairman");
			expect(widgetText).toContain("(mod)");
		});
	});

	test("/inject rejects empty text", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on group-chat all", ctx);

			await harness.commands.get("inject")?.handler("", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "error",
					message: expect.stringContaining("Usage"),
				}),
			);
		});
	});

	test("/inject accepts free-form text", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on group-chat all", ctx);

			await harness.commands
				.get("inject")
				?.handler("focus on cost", ctx);

			expect(ctx.notifications[ctx.notifications.length - 1]).toEqual(
				expect.objectContaining({
					type: "info",
					message: expect.stringContaining("focus on cost"),
				}),
			);
		});
	});

	test("@<slug> message routes only to the named mind", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "@ariadne hi there", source: "interactive" },
				ctx,
			)) as { action: string };

			expect(result?.action).toBe("handled");
			const userMessages = harness.sentMessages.filter(
				(m) => m.customType === ROOM_CUSTOM_TYPES.userMessage,
			);
			expect(userMessages.length).toBeGreaterThan(0);
			expect(userMessages[userMessages.length - 1].content).toBe(
				"hi there",
			);
		});
	});

	test("@<unknown-slug> falls through to the normal room turn", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const result = (await runHandler(
				harness,
				"input",
				{ text: "@nobody what's up", source: "interactive" },
				ctx,
			)) as { action: string };
			// Still handled (room consumes turn) but the literal text is the user message.
			expect(result?.action).toBe("handled");
			const userMessages = harness.sentMessages.filter(
				(m) => m.customType === ROOM_CUSTOM_TYPES.userMessage,
			);
			expect(userMessages[userMessages.length - 1].content).toBe(
				"@nobody what's up",
			);
		});
	});

	test("activating a room writes an observatory lens", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const harness = createHarness();
			const ctx = createContext(cwd);

			await harness.commands.get("room")?.handler("on concurrent all", ctx);

			const manifestPath = path.join(
				cwd,
				".pi/observatory/lenses/room/lens.json",
			);
			const dataPath = path.join(
				cwd,
				".pi/observatory/lenses/room/data.json",
			);
			expect(fs.existsSync(manifestPath)).toBe(true);
			expect(fs.existsSync(dataPath)).toBe(true);
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
			expect(manifest).toEqual(
				expect.objectContaining({
					name: "Chamber Room",
					kind: "status-board",
					source: "data.json",
				}),
			);
			const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(2);
			expect(data[0]).toEqual(
				expect.objectContaining({
					name: expect.any(String),
					status: expect.any(String),
					role: expect.any(String),
				}),
			);
		});
	});

	test("/leave clears the observatory lens directory", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			const harness = createHarness();
			const ctx = createContext(cwd);
			await harness.commands.get("room")?.handler("on concurrent all", ctx);
			const lensDir = path.join(cwd, ".pi/observatory/lenses/room");
			expect(fs.existsSync(lensDir)).toBe(true);

			await harness.commands.get("leave")?.handler("", ctx);

			expect(fs.existsSync(lensDir)).toBe(false);
		});
	});

	test("/room picker activates an existing saved room and loads its transcript", async () => {
		await withTempProject(async (cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			// Pre-create the saved room and a transcript on disk.
			const roomDir = path.join(cwd, ".pi/rooms/design-review");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				path.join(roomDir, "room.json"),
				JSON.stringify(
					{
						slug: "design-review",
						name: "Design Review",
						mode: "sequential",
						participants: ["ariadne", "mycroft"],
						createdAt: "2026-05-01T00:00:00.000Z",
						updatedAt: "2026-05-01T00:00:00.000Z",
					},
					null,
					2,
				) + "\n",
			);
			fs.writeFileSync(
				path.join(roomDir, "transcript.jsonl"),
				`${JSON.stringify({ user: "earlier", assistant: "earlier-answer", ts: "" })}\n`,
			);

			const harness = createHarness();
			const ctx = createContext(cwd, [], {
				selectValues: ["▸ design-review · sequential · ariadne, mycroft"],
				inputValues: [],
				leafId: "entry-pre-picker",
			});

			await harness.commands.get("room")?.handler("", ctx);

			expect(harness.appendEntries[harness.appendEntries.length - 1]).toEqual({
				stream: "room-state",
				entry: expect.objectContaining({
					active: true,
					mode: "sequential",
					slug: "design-review",
					participants: ["ariadne", "mycroft"],
					// Picker-driven activation must capture preRoomLeafId so that
					// /detach has a fork anchor. Without this, /detach silently
					// degrades to /leave for saved rooms.
					preRoomLeafId: "entry-pre-picker",
				}),
			});
			expect(ctx.notifications[0].message).toContain("Loaded 1 prior turn");
			expect(ctx.notifications[0].message).toContain("/detach");
		});
	});
});
