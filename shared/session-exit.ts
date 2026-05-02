import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ExitCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: {
		getEntries(): Array<Record<string, unknown>>;
	};
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, value: string | undefined): void;
	};
};

export type ExitTarget<
	Context extends ExitCommandContext = ExitCommandContext,
> = {
	id: string;
	label: string;
	priority?: number;
	isActive(ctx: Context): boolean | Promise<boolean>;
	exit(ctx: Context): void | Promise<void>;
};

const EXIT_COMMAND_DESCRIPTION =
	"Leave the active Genesis mind and/or Chamber room.";

// Pi loads each extension with a fresh jiti instance and `moduleCache: false`,
// so two extensions importing this file each get their own evaluation. The
// only state that survives the duplicate evaluation is `globalThis`, which is
// shared across the whole Node process.
//
// Pi creates a new EventBus for each session (resource-loader.js:122 → new
// DefaultResourceLoader → createEventBus() unless one is passed in, and
// agent-session-services constructs a fresh loader per createRuntime call).
// So `pi.events` is a stable per-session identity object: same across all
// extensions in one session, different across sessions. We key our shared
// state on it so a fresh session re-registers /exit instead of inheriting
// the parent session's "already registered" flag.

type PerSessionState = {
	registry: Map<string, ExitTarget>;
	commandRegistered: boolean;
};

type SharedState = {
	bySession: WeakMap<object, PerSessionState>;
};

const SHARED_STATE_KEY = "__pi_session_exit_v2__";

function getSharedState(): SharedState {
	const g = globalThis as Record<string, unknown>;
	let state = g[SHARED_STATE_KEY] as SharedState | undefined;
	if (!state) {
		state = { bySession: new WeakMap() };
		g[SHARED_STATE_KEY] = state;
	}
	return state;
}

function getSessionKey(pi: ExtensionAPI): object {
	// pi.events is the per-session EventBus. Fall back to the pi object itself
	// in test harnesses that don't construct an events bus.
	const events = (pi as unknown as { events?: object }).events;
	return events ?? (pi as unknown as object);
}

function getSessionState(pi: ExtensionAPI): PerSessionState {
	const shared = getSharedState();
	const key = getSessionKey(pi);
	let state = shared.bySession.get(key);
	if (!state) {
		state = { registry: new Map(), commandRegistered: false };
		shared.bySession.set(key, state);
	}
	return state;
}

export function registerExitTarget<Context extends ExitCommandContext>(
	pi: ExtensionAPI,
	target: ExitTarget<Context>,
): void {
	getSessionState(pi).registry.set(target.id, target as ExitTarget);
}

export function registerExitCommand(pi: ExtensionAPI): void {
	const state = getSessionState(pi);
	if (state.commandRegistered) return;
	state.commandRegistered = true;

	pi.registerCommand("exit", {
		description: EXIT_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			const commandCtx = ctx as unknown as ExitCommandContext;
			const value = (args || "").trim().toLowerCase();

			if (value === "help" || value === "?") {
				notify(
					commandCtx,
					"Usage: /exit — leave the active Genesis mind and/or Chamber room.",
					"info",
				);
				return;
			}

			if (value) {
				notify(commandCtx, "Usage: /exit", "error");
				return;
			}

			// Re-read from the same session's state at call time so any
			// targets registered after the command itself still fire.
			const liveState = getSessionState(pi);
			const activeTargets: ExitTarget[] = [];
			for (const target of sortedTargets(liveState.registry)) {
				if (await target.isActive(commandCtx)) {
					activeTargets.push(target);
				}
			}

			if (activeTargets.length === 0) {
				notify(commandCtx, "No active mind or room to exit.", "info");
				return;
			}

			for (const target of activeTargets) {
				await target.exit(commandCtx);
			}
		},
	});
}

export function __resetForTests(): void {
	const g = globalThis as Record<string, unknown>;
	delete g[SHARED_STATE_KEY];
}

function sortedTargets(registry: Map<string, ExitTarget>): ExitTarget[] {
	return [...registry.values()].sort(
		(a, b) => (a.priority ?? 100) - (b.priority ?? 100),
	);
}

function notify(
	ctx: ExitCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}
