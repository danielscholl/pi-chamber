import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type SessionCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: {
		getEntries(): Array<Record<string, unknown>>;
		getLeafId?(): string | null;
	};
	fork?(
		entryId: string,
		options?: {
			position?: "before" | "at";
			withSession?: (ctx: unknown) => Promise<void> | void;
		},
	): Promise<{ cancelled?: boolean }>;
	waitForIdle?(): Promise<void>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, value: string | undefined): void;
	};
};

export type SessionTarget<
	Context extends SessionCommandContext = SessionCommandContext,
> = {
	id: string;
	label: string;
	priority?: number;
	isActive(ctx: Context): boolean | Promise<boolean>;
	/**
	 * Stop inhabiting this target while keeping all turns in the current
	 * session. Conversation history bridges in and out of the inhabited mind
	 * or room. No session swap.
	 */
	leave(ctx: Context): void | Promise<void>;
	/**
	 * Detach this target by forking the parent session back to the entry
	 * captured at activation time and switching into the fork. The original
	 * session (containing the inhabited turns) is preserved on disk as an
	 * artifact. Targets should fall back to a leave-style cleanup with a
	 * warning if the fork primitive is unavailable or fails.
	 */
	detach(ctx: Context): void | Promise<void>;
};

const LEAVE_COMMAND_DESCRIPTION =
	"Leave the active Genesis mind and/or Chamber room. Conversation history stays in the current session.";
const DETACH_COMMAND_DESCRIPTION =
	"Detach the active Genesis mind and/or Chamber room. Rewinds the session to before activation; the inhabited session is preserved as an artifact.";

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
// state on it so a fresh session re-registers /leave and /detach instead of
// inheriting the parent session's "already registered" flag.

type PerSessionState = {
	registry: Map<string, SessionTarget>;
	commandsRegistered: boolean;
};

type SharedState = {
	bySession: WeakMap<object, PerSessionState>;
};

const SHARED_STATE_KEY = "__pi_session_control_v1__";

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
		state = { registry: new Map(), commandsRegistered: false };
		shared.bySession.set(key, state);
	}
	return state;
}

export function registerSessionTarget<Context extends SessionCommandContext>(
	pi: ExtensionAPI,
	target: SessionTarget<Context>,
): void {
	getSessionState(pi).registry.set(target.id, target as SessionTarget);
}

export function registerSessionCommands(pi: ExtensionAPI): void {
	const state = getSessionState(pi);
	if (state.commandsRegistered) return;
	state.commandsRegistered = true;

	pi.registerCommand("leave", {
		description: LEAVE_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			await dispatchSessionCommand(pi, "leave", args, ctx);
		},
	});

	pi.registerCommand("detach", {
		description: DETACH_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			await dispatchSessionCommand(pi, "detach", args, ctx);
		},
	});
}

export function __resetForTests(): void {
	const g = globalThis as Record<string, unknown>;
	delete g[SHARED_STATE_KEY];
}

async function dispatchSessionCommand(
	pi: ExtensionAPI,
	verb: "leave" | "detach",
	args: string,
	ctx: unknown,
): Promise<void> {
	const commandCtx = ctx as unknown as SessionCommandContext;
	const value = (args || "").trim().toLowerCase();

	if (value === "help" || value === "?") {
		notify(
			commandCtx,
			verb === "leave"
				? "Usage: /leave — leave the active Genesis mind and/or Chamber room. Conversation history stays in the current session."
				: "Usage: /detach — detach the active Genesis mind and/or Chamber room. Rewinds the session to before activation; the inhabited session is preserved as an artifact.",
			"info",
		);
		return;
	}

	if (value) {
		notify(commandCtx, `Usage: /${verb}`, "error");
		return;
	}

	// Re-read from the same session's state at call time so any targets
	// registered after the command itself still fire.
	const liveState = getSessionState(pi);
	const activeTargets: SessionTarget[] = [];
	for (const target of sortedTargets(liveState.registry)) {
		if (await target.isActive(commandCtx)) {
			activeTargets.push(target);
		}
	}

	if (activeTargets.length === 0) {
		notify(
			commandCtx,
			verb === "leave"
				? "No active mind or room to leave."
				: "No active mind or room to detach.",
			"info",
		);
		return;
	}

	for (const target of activeTargets) {
		if (verb === "leave") {
			await target.leave(commandCtx);
		} else {
			await target.detach(commandCtx);
		}
	}
}

function sortedTargets(
	registry: Map<string, SessionTarget>,
): SessionTarget[] {
	return [...registry.values()].sort(
		(a, b) => (a.priority ?? 100) - (b.priority ?? 100),
	);
}

function notify(
	ctx: SessionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}
