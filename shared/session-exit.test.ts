// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { beforeEach, describe, expect, test } from "bun:test";
import {
	type SessionCommandContext,
	__resetForTests,
	registerSessionCommands,
	registerSessionTarget,
} from "./session-exit.ts";

type TestCommand = {
	description?: string;
	handler: (args: string, ctx: SessionCommandContext) => Promise<void>;
};

type TestPi = {
	commands: Map<string, TestCommand>;
	events: object;
	registerCommand(name: string, command: TestCommand): void;
	getCommands(): Array<{ name: string; description?: string }>;
};

function createPi(events: object): TestPi {
	const commands = new Map<string, TestCommand>();
	return {
		commands,
		events,
		registerCommand(name, command) {
			commands.set(name, command);
		},
		getCommands() {
			return [...commands.entries()].map(([name, command]) => ({
				name,
				description: command.description,
			}));
		},
	};
}

function createContext(
	overrides: Partial<SessionCommandContext> = {},
): SessionCommandContext {
	const notifications: Array<{
		message: string;
		type?: "info" | "warning" | "error";
	}> = [];
	return {
		cwd: "/tmp/session-control-test",
		hasUI: true,
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
		...overrides,
	};
}

beforeEach(() => {
	__resetForTests();
});

describe("session-control coordinator", () => {
	test("two extensions in one session share state — only one /leave and /detach is registered", async () => {
		const sessionEvents = {};
		const mindPi = createPi(sessionEvents);
		const roomPi = createPi(sessionEvents);
		const calls: string[] = [];

		registerSessionTarget(mindPi as never, {
			id: "mind",
			label: "mind",
			priority: 20,
			isActive: () => true,
			leave: () => {
				calls.push("mind:leave");
			},
			detach: () => {
				calls.push("mind:detach");
			},
		});
		registerSessionCommands(mindPi as never);

		registerSessionTarget(roomPi as never, {
			id: "room",
			label: "room",
			priority: 10,
			isActive: () => true,
			leave: () => {
				calls.push("room:leave");
			},
			detach: () => {
				calls.push("room:detach");
			},
		});
		registerSessionCommands(roomPi as never);

		expect([...mindPi.commands.keys()]).toEqual(["leave", "detach"]);
		expect([...roomPi.commands.keys()]).toEqual([]);

		await mindPi.commands.get("leave")?.handler("", createContext());
		expect(calls).toEqual(["room:leave", "mind:leave"]);

		calls.length = 0;
		await mindPi.commands.get("detach")?.handler("", createContext());
		expect(calls).toEqual(["room:detach", "mind:detach"]);
	});

	test("a new session re-registers commands without inheriting parent-session state", async () => {
		const parentEvents = {};
		const parentPi = createPi(parentEvents);

		registerSessionTarget(parentPi as never, {
			id: "mind",
			label: "mind",
			isActive: () => true,
			leave: () => {},
			detach: () => {},
		});
		registerSessionCommands(parentPi as never);
		expect([...parentPi.commands.keys()]).toEqual(["leave", "detach"]);

		// Simulate ctx.newSession() — fresh EventBus, fresh extension load.
		const childEvents = {};
		const childPi = createPi(childEvents);
		const childCalls: string[] = [];

		registerSessionTarget(childPi as never, {
			id: "mind",
			label: "mind",
			isActive: () => true,
			leave: () => {
				childCalls.push("mind:leave");
			},
			detach: () => {
				childCalls.push("mind:detach");
			},
		});
		registerSessionCommands(childPi as never);

		// New session must have its own commands, not skip because of the parent.
		expect([...childPi.commands.keys()]).toEqual(["leave", "detach"]);

		await childPi.commands.get("leave")?.handler("", createContext());
		expect(childCalls).toEqual(["mind:leave"]);
	});

	test("targets registered on a sibling pi after the merge still fire", async () => {
		const sessionEvents = {};
		const firstPi = createPi(sessionEvents);
		const secondPi = createPi(sessionEvents);
		const calls: string[] = [];

		registerSessionCommands(firstPi as never);
		registerSessionCommands(secondPi as never);

		registerSessionTarget(secondPi as never, {
			id: "late-room",
			label: "room",
			priority: 5,
			isActive: () => true,
			leave: () => {
				calls.push("late-room:leave");
			},
			detach: () => {
				calls.push("late-room:detach");
			},
		});

		await firstPi.commands.get("leave")?.handler("", createContext());
		expect(calls).toEqual(["late-room:leave"]);

		calls.length = 0;
		await firstPi.commands.get("detach")?.handler("", createContext());
		expect(calls).toEqual(["late-room:detach"]);
	});

	test("inactive targets are skipped", async () => {
		const pi = createPi({});
		const calls: string[] = [];

		registerSessionTarget(pi as never, {
			id: "idle",
			label: "idle",
			isActive: () => false,
			leave: () => {
				calls.push("idle:leave");
			},
			detach: () => {
				calls.push("idle:detach");
			},
		});
		registerSessionTarget(pi as never, {
			id: "live",
			label: "live",
			isActive: () => true,
			leave: () => {
				calls.push("live:leave");
			},
			detach: () => {
				calls.push("live:detach");
			},
		});
		registerSessionCommands(pi as never);

		await pi.commands.get("leave")?.handler("", createContext());
		expect(calls).toEqual(["live:leave"]);

		calls.length = 0;
		await pi.commands.get("detach")?.handler("", createContext());
		expect(calls).toEqual(["live:detach"]);
	});

	test("commands report when there is nothing active", async () => {
		const pi = createPi({});
		const notifications: Array<{ message: string; type?: string }> = [];
		const ctx: SessionCommandContext = {
			cwd: "/tmp/session-test",
			hasUI: true,
			sessionManager: { getEntries: () => [] },
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
		};

		registerSessionCommands(pi as never);
		await pi.commands.get("leave")?.handler("", ctx);
		expect(notifications.pop()).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("No active mind or room to leave"),
				type: "info",
			}),
		);

		await pi.commands.get("detach")?.handler("", ctx);
		expect(notifications.pop()).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("No active mind or room to detach"),
				type: "info",
			}),
		);
	});
});
