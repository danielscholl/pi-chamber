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

type TestContext = {
	cwd: string;
	hasUI: boolean;
	notifications: TestNotification[];
	statusUpdates: Array<{ key: string; value: string | undefined }>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
	};
};

function createHarness() {
	const commands = new Map<string, RegisteredCommand>();

	const pi = {
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerTool() {},
		on() {},
		appendEntry() {},
		sendUserMessage() {},
	};

	observatoryExtension(pi as never);
	return { commands };
}

function createContext(
	cwd: string,
	overrides: Partial<{ hasUI: boolean }> = {},
): TestContext {
	const notifications: TestNotification[] = [];
	const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
	return {
		cwd,
		hasUI: overrides.hasUI ?? true,
		notifications,
		statusUpdates,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus(key, value) {
				statusUpdates.push({ key, value });
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
	test("registers /observatory with subcommand completions", () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		expect(cmd).toBeDefined();
		expect(cmd?.description).toMatch(/Genesis-mind-authored lenses/);
		const completions = cmd?.getArgumentCompletions?.("");
		expect(completions).not.toBeNull();
		const values = completions?.map((c) => c.value) ?? [];
		expect(values).toEqual(
			expect.arrayContaining(["open", "stop", "status", "list", "help"]),
		);
	});

	test("/observatory help prints usage that includes the lens.json shape", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		expect(cmd).toBeDefined();
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("help", ctx);
			expect(ctx.notifications).toHaveLength(1);
			const message = ctx.notifications[0].message;
			expect(message).toMatch(/Usage: \/observatory/);
			expect(message).toMatch(/lens\.json/);
			expect(message).toMatch(/kind/);
			expect(message).toMatch(/briefing/);
			expect(message).toMatch(/status-board/);
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

	test("/observatory status notifies when no server is running", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("status", ctx);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0].message).toMatch(/not running/);
		});
	});

	test("/observatory stop notifies when no server is running", async () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		await withTempProject(async (cwd) => {
			const ctx = createContext(cwd);
			await cmd?.handler("stop", ctx);
			expect(ctx.notifications).toHaveLength(1);
			expect(ctx.notifications[0].message).toMatch(/not running/);
			const lastStatus = ctx.statusUpdates.at(-1);
			expect(lastStatus?.key).toBe("observatory");
			expect(lastStatus?.value).toBeUndefined();
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
			expect(ctx.notifications[0].message).toMatch(/Unknown \/observatory subcommand: nope/);
		});
	});

	test("argument completions filter by prefix", () => {
		const { commands } = createHarness();
		const cmd = commands.get("observatory");
		const completions = cmd?.getArgumentCompletions?.("st") ?? [];
		const values = completions.map((c) => c.value);
		expect(values).toEqual(expect.arrayContaining(["stop", "status"]));
		for (const value of values) {
			expect(value.startsWith("st")).toBe(true);
		}
	});
});
