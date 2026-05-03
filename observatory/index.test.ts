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
import observatoryExtension from "./index.ts";

type AutocompleteItem = { value: string; label: string; description?: string };

type RegisteredCommand = {
	description?: string;
	handler: (args: string, ctx: TestContext) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
};

type TestNotification = {
	message: string;
	type?: "info" | "warning" | "error";
};

type CustomCall = {
	options: { overlay?: boolean } | undefined;
	disposed: boolean;
};

type TestContext = {
	cwd: string;
	hasUI: boolean;
	notifications: TestNotification[];
	statusUpdates: Array<{ key: string; value: string | undefined }>;
	customCalls: CustomCall[];
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
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
};

function createHarness() {
	const commands = new Map<string, RegisteredCommand>();
	const sessionHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
	const pi = {
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (event === "session_start") sessionHandlers.push(handler);
		},
		appendEntry() {},
		sendUserMessage() {},
	};
	observatoryExtension(pi as never);
	return { commands, sessionHandlers };
}

function createContext(
	cwd: string,
	overrides: Partial<{ hasUI: boolean }> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	const customCalls: CustomCall[] = [];
	return {
		cwd,
		hasUI: overrides.hasUI ?? true,
		notifications,
		statusUpdates,
		customCalls,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus(key, value) {
				statusUpdates.push({ key, value });
			},
			async custom(factory, options) {
				const call: CustomCall = { options, disposed: false };
				customCalls.push(call);
				const stubTui = { requestRender() {} };
				const stubTheme = { fg: (_c: string, t: string) => t };
				let resolved: unknown;
				const done = (value: unknown) => {
					resolved = value;
				};
				const component = await Promise.resolve(
					factory(stubTui, stubTheme, {}, done as never),
				);
				const disposable = component as { dispose?: () => void };
				if (typeof disposable.dispose === "function") {
					disposable.dispose();
					call.disposed = true;
				}
				return resolved as never;
			},
		},
	};
}

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-ext-test-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

describe("observatory extension", () => {
	test("registers /observatory with completions for list and help only", () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		expect(cmd).toBeDefined();
		expect(cmd?.description).toMatch(/Genesis-mind-authored lenses/);
		const completions = cmd?.getArgumentCompletions?.("");
		expect(completions).not.toBeNull();
		const values = completions?.map((c) => c.value) ?? [];
		expect(values.sort()).toEqual(["help", "list"]);
	});

	test("/observatory help prints usage that includes the lens.json shape", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("help", ctx);
			expect(ctx.notifications).toHaveLength(1);
			const message = ctx.notifications[0].message;
			expect(message).toMatch(/Usage: \/observatory/);
			expect(message).toMatch(/lens\.json/);
			expect(message).toMatch(/briefing/);
			expect(message).toMatch(/status-board/);
			// Help text must not advertise the deprecated server.
			expect(message).not.toMatch(/HTTP|server|http:\/\//i);
		});
	});

	test("/observatory list reports an empty state when no lenses exist", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("list", ctx);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0].type).toBe("info");
			expect(ctx.notifications[0].message).toMatch(/No observatory lenses/);
		});
	});

	test("/observatory list reports authored lenses from the project", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const lensesRoot = path.join(cwd, ".pi", "observatory", "lenses");
			fs.mkdirSync(path.join(lensesRoot, "operations"), { recursive: true });
			fs.writeFileSync(
				path.join(lensesRoot, "operations", "lens.json"),
				JSON.stringify({
					name: "Operations",
					kind: "briefing",
					source: "data.json",
				}),
			);
			fs.mkdirSync(path.join(lensesRoot, "broken"), { recursive: true });
			fs.writeFileSync(
				path.join(lensesRoot, "broken", "lens.json"),
				"{ not json",
			);
			const ctx = createContext(cwd);
			await cmd?.handler("list", ctx);
			expect(ctx.notifications).toHaveLength(1);
			const message = ctx.notifications[0].message;
			expect(message).toMatch(/operations \(briefing\)/);
			expect(message).toMatch(/Operations/);
			expect(message).toMatch(/broken \(invalid:/);
		});
	});

	test("legacy subcommands (status/stop/open) emit a soft hint", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			for (const sub of ["status", "stop", "open"] as const) {
				const ctx = createContext(cwd);
				await cmd?.handler(sub, ctx);
				expect(ctx.notifications).toHaveLength(1);
				expect(ctx.notifications[0].type).toBe("info");
				expect(ctx.notifications[0].message).toMatch(/no longer runs an HTTP server/);
				expect(ctx.customCalls).toHaveLength(0);
			}
		});
	});

	test("default invocation mounts the TUI fullscreen", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("", ctx);
			expect(ctx.customCalls).toHaveLength(1);
			expect(ctx.customCalls[0].options).toEqual({ overlay: false });
			expect(ctx.customCalls[0].disposed).toBe(true);
			expect(
				ctx.notifications.some((n) => n.type === "error"),
			).toBe(false);
		});
	});

	test("/observatory start is an alias for the default invocation", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("start", ctx);
			expect(ctx.customCalls).toHaveLength(1);
		});
	});

	test("default invocation without a UI session emits a warning instead of mounting", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd, { hasUI: false });
			await cmd?.handler("", ctx);
			expect(ctx.customCalls).toHaveLength(0);
			// Without hasUI, notify() short-circuits, so we just assert no overlay.
			// (No notification is delivered to the silent UI.)
		});
	});

	test("unknown subcommands are reported as warnings", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("nope", ctx);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0].type).toBe("warning");
			expect(ctx.notifications[0].message).toMatch(
				/Unknown \/observatory subcommand: nope/,
			);
		});
	});

	test("argument completions filter by prefix", () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		expect(cmd?.getArgumentCompletions?.("h")?.map((c) => c.value)).toEqual([
			"help",
		]);
		expect(cmd?.getArgumentCompletions?.("l")?.map((c) => c.value)).toEqual([
			"list",
		]);
		expect(cmd?.getArgumentCompletions?.("zzz")).toBeNull();
	});

	test("session_start clears any stale observatory status", async () => {
		const { sessionHandlers } = createHarness();
		const updates: Array<{ key: string; value: string | undefined }> = [];
		const ctx = {
			hasUI: true,
			ui: {
				setStatus(key: string, value: string | undefined) {
					updates.push({ key, value });
				},
			},
		};
		for (const handler of sessionHandlers) {
			await handler({}, ctx);
		}
		expect(updates).toEqual([{ key: "observatory", value: undefined }]);
	});
});
