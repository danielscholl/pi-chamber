// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { beforeEach, describe, expect, test } from "bun:test";
import {
	type ExitCommandContext,
	__resetForTests,
	registerExitCommand,
	registerExitTarget,
} from "./session-exit.ts";

type TestCommand = {
	description?: string;
	handler: (args: string, ctx: ExitCommandContext) => Promise<void>;
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

function createContext(): ExitCommandContext {
	return {
		cwd: "/tmp/session-exit-test",
		hasUI: true,
		sessionManager: {
			getEntries() {
				return [];
			},
		},
		ui: {
			notify() {},
		},
	};
}

beforeEach(() => {
	__resetForTests();
});

describe("session-exit coordinator", () => {
	test("two extensions in one session share state — only one /exit is registered", async () => {
		const sessionEvents = {};
		const mindPi = createPi(sessionEvents);
		const roomPi = createPi(sessionEvents);
		const calls: string[] = [];

		registerExitTarget(mindPi as never, {
			id: "mind",
			label: "mind",
			priority: 20,
			isActive: () => true,
			exit: () => {
				calls.push("mind");
			},
		});
		registerExitCommand(mindPi as never);

		registerExitTarget(roomPi as never, {
			id: "room",
			label: "room",
			priority: 10,
			isActive: () => true,
			exit: () => {
				calls.push("room");
			},
		});
		registerExitCommand(roomPi as never);

		expect([...mindPi.commands.keys()]).toEqual(["exit"]);
		expect([...roomPi.commands.keys()]).toEqual([]);

		await mindPi.commands.get("exit")?.handler("", createContext());

		expect(calls).toEqual(["room", "mind"]);
	});

	test("a new session re-registers /exit without inheriting parent-session state", async () => {
		const parentEvents = {};
		const parentPi = createPi(parentEvents);

		registerExitTarget(parentPi as never, {
			id: "mind",
			label: "mind",
			isActive: () => true,
			exit: () => {},
		});
		registerExitCommand(parentPi as never);
		expect([...parentPi.commands.keys()]).toEqual(["exit"]);

		// Simulate ctx.newSession() — fresh EventBus, fresh extension load.
		const childEvents = {};
		const childPi = createPi(childEvents);
		const childCalls: string[] = [];

		registerExitTarget(childPi as never, {
			id: "mind",
			label: "mind",
			isActive: () => true,
			exit: () => {
				childCalls.push("mind");
			},
		});
		registerExitCommand(childPi as never);

		// New session must have its own /exit, not skip because of the parent.
		expect([...childPi.commands.keys()]).toEqual(["exit"]);

		await childPi.commands.get("exit")?.handler("", createContext());
		expect(childCalls).toEqual(["mind"]);
	});

	test("targets registered on a sibling pi after the merge still fire", async () => {
		const sessionEvents = {};
		const firstPi = createPi(sessionEvents);
		const secondPi = createPi(sessionEvents);
		const calls: string[] = [];

		registerExitCommand(firstPi as never);
		registerExitCommand(secondPi as never);

		registerExitTarget(secondPi as never, {
			id: "late-room",
			label: "room",
			priority: 5,
			isActive: () => true,
			exit: () => {
				calls.push("late-room");
			},
		});

		await firstPi.commands.get("exit")?.handler("", createContext());

		expect(calls).toEqual(["late-room"]);
	});

	test("inactive targets are skipped", async () => {
		const pi = createPi({});
		const calls: string[] = [];

		registerExitTarget(pi as never, {
			id: "idle",
			label: "idle",
			isActive: () => false,
			exit: () => {
				calls.push("idle");
			},
		});
		registerExitTarget(pi as never, {
			id: "live",
			label: "live",
			isActive: () => true,
			exit: () => {
				calls.push("live");
			},
		});
		registerExitCommand(pi as never);

		await pi.commands.get("exit")?.handler("", createContext());

		expect(calls).toEqual(["live"]);
	});
});
