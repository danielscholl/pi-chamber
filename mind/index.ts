import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildMindModeSystemPrompt,
	listGenesisMinds,
	loadMindContext,
	normalizeMindSlug,
} from "./core.ts";
import { registerExitCommand, registerExitTarget } from "../shared/session-exit.ts";

type MindModeSessionManager = {
	getEntries(): Array<Record<string, unknown>>;
	getSessionFile?(): string | undefined;
	appendCustomEntry?(customType: string, data?: unknown): string;
	appendSessionInfo?(name: string): string;
};

type MindModeCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: MindModeSessionManager;
	waitForIdle?(): Promise<void>;
	newSession?(options?: {
		parentSession?: string;
		setup?: (sessionManager: MindModeSessionManager) => Promise<void> | void;
		withSession?: (ctx: MindModeCommandContext) => Promise<void> | void;
	}): Promise<{ cancelled?: boolean }>;
	switchSession?(
		sessionPath: string,
		options?: {
			withSession?: (ctx: MindModeCommandContext) => Promise<void> | void;
		},
	): Promise<{ cancelled?: boolean }>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(prompt: string, options: string[]): Promise<string | undefined>;
		setStatus(key: string, value: string | undefined): void;
	};
};

type MindModeEventContext = MindModeCommandContext;

type MindModeStateEntry = {
	active?: boolean;
	slug?: string;
	mindPath?: string;
	activatedAt?: string;
	deactivatedAt?: string;
	reason?: string;
	returnSessionFile?: string;
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

const STATE_STREAM = "mind-state";
const STATUS_KEY = "mind";
const MIND_STATUS_ICON = "\u{F415}"; // nf-oct-person: project-local mind/persona.

export default function (pi: ExtensionAPI) {
	let activeMindSlug: string | undefined;
	let inactiveMindSlug: string | undefined;

	function setMindStatus(
		ctx: MindModeCommandContext,
		slug = activeMindSlug,
	): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			slug ? `${MIND_STATUS_ICON} ${slug}` : undefined,
		);
	}

	function persistState(entry: MindModeStateEntry): void {
		try {
			pi.appendEntry(STATE_STREAM, entry);
		} catch {
			// Session state is useful for restore but should not block /mind usage.
		}
	}

	async function activateMind(
		ctx: MindModeCommandContext,
		input: string,
	): Promise<void> {
		let loaded;
		try {
			const slug = normalizeMindSlug(input);
			loaded = loadMindContext(ctx.cwd, slug);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}

		const returnSessionFile = ctx.sessionManager.getSessionFile?.();
		if (returnSessionFile && ctx.newSession && ctx.switchSession) {
			await ctx.waitForIdle?.();
			const state: MindModeStateEntry = {
				active: true,
				slug: loaded.slug,
				mindPath: loaded.paths.mindPath,
				activatedAt: new Date().toISOString(),
				returnSessionFile,
			};
			const result = await ctx.newSession({
				parentSession: returnSessionFile,
				setup: (sessionManager) => {
					sessionManager.appendCustomEntry?.(STATE_STREAM, state);
					sessionManager.appendSessionInfo?.(`Mind: ${loaded.slug}`);
				},
				withSession: (replacementCtx) => {
					setMindStatus(replacementCtx, loaded.slug);
					notify(
						replacementCtx,
						`Mind mode active in a dedicated session: ${loaded.slug}. Future turns will inhabit ${loaded.paths.mindPath}. Use /exit to return to the previous session.`,
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(ctx, "Mind mode activation cancelled.", "info");
			}
			return;
		}

		activeMindSlug = loaded.slug;
		inactiveMindSlug = undefined;
		persistState({
			active: true,
			slug: loaded.slug,
			mindPath: loaded.paths.mindPath,
			activatedAt: new Date().toISOString(),
		});
		setMindStatus(ctx, loaded.slug);
		notify(
			ctx,
			`Mind mode active: ${loaded.slug}. Future turns will inhabit ${loaded.paths.mindPath}. Use /exit to return to the normal assistant.`,
			"info",
		);
	}

	async function deactivateMind(
		ctx: MindModeCommandContext,
		reason?: string,
	): Promise<void> {
		const state = latestMindModeState(ctx.sessionManager.getEntries());
		const previous = activeMindSlug ?? state?.slug;
		const returnSessionFile = state?.returnSessionFile;
		activeMindSlug = undefined;
		inactiveMindSlug = previous ?? inactiveMindSlug;
		persistState({
			active: false,
			...(previous ? { slug: previous } : {}),
			deactivatedAt: new Date().toISOString(),
			...(reason ? { reason } : {}),
			...(returnSessionFile ? { returnSessionFile } : {}),
		});
		setMindStatus(ctx, undefined);

		if (returnSessionFile && ctx.switchSession) {
			await ctx.waitForIdle?.();
			const result = await ctx.switchSession(returnSessionFile, {
				withSession: (replacementCtx) => {
					// The parent session never had this mind active in its own
					// transcript, so don't carry the "Mind Mode Off" guard into
					// it. Clear closure state so the next before_agent_start in
					// the parent runs without injection. session_start firing on
					// the parent will re-derive any state from its own entries.
					activeMindSlug = undefined;
					inactiveMindSlug = undefined;
					setMindStatus(replacementCtx, undefined);
					notify(
						replacementCtx,
						previous
							? `Mind mode off. Returned from ${previous} to the previous session.`
							: "Mind mode off. Returned to the previous session.",
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(
					ctx,
					"Mind mode off, but returning to the previous session was cancelled.",
					"warning",
				);
			}
			return;
		}

		notify(
			ctx,
			"Mind mode off. Future turns use the normal assistant.",
			"info",
		);
	}

	registerExitTarget(pi, {
		id: "mind",
		label: "mind",
		priority: 20,
		isActive: (ctx) => {
			const state = latestMindModeState(ctx.sessionManager.getEntries());
			return Boolean(activeMindSlug || (state?.active && state.slug));
		},
		exit: async (ctx) => {
			await deactivateMind(
				ctx as unknown as MindModeCommandContext,
				"exit command",
			);
		},
	});
	registerExitCommand(pi);

	function showMindList(ctx: MindModeCommandContext): void {
		let slugs: string[];
		try {
			slugs = listGenesisMinds(ctx.cwd);
		} catch (error) {
			notify(
				ctx,
				`Could not list Genesis minds: ${errorMessage(error)}`,
				"error",
			);
			return;
		}

		if (slugs.length === 0) {
			notify(ctx, noMindsText(), "warning");
			return;
		}

		notify(
			ctx,
			`Available Genesis minds:\n${slugs.map((slug) => `- ${slug}`).join("\n")}`,
			"info",
		);
	}

	pi.registerCommand("mind", {
		description: "Activate a Genesis mind in the current main Pi session.",
		getArgumentCompletions: (prefix: string) => mindArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			const commandCtx = ctx as unknown as MindModeCommandContext;
			const value = (args || "").trim();
			const lower = value.toLowerCase();

			if (lower === "help" || lower === "?") {
				notify(
					commandCtx,
					`${mindUsageText()}${availableMindSuffix(commandCtx.cwd)}`,
					"info",
				);
				return;
			}

			if (lower === "list") {
				showMindList(commandCtx);
				return;
			}

			if (lower === "create" || lower === "new") {
				notify(commandCtx, createMindText(), "info");
				return;
			}

			if (value) {
				await activateMind(commandCtx, value);
				return;
			}

			let slugs: string[];
			try {
				slugs = listGenesisMinds(commandCtx.cwd);
			} catch (error) {
				notify(
					commandCtx,
					`Could not list Genesis minds: ${errorMessage(error)}`,
					"error",
				);
				return;
			}

			if (!commandCtx.hasUI || !commandCtx.ui.select) {
				const available = availableMindSuffix(commandCtx.cwd, slugs);
				notify(commandCtx, `${mindUsageText()}${available}`, "error");
				return;
			}

			if (slugs.length === 0) {
				notify(commandCtx, noMindsText(), "warning");
				return;
			}

			const selected = await commandCtx.ui.select("Genesis mind:", slugs);
			if (!selected) return;
			await activateMind(commandCtx, selected);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const eventCtx = ctx as unknown as MindModeEventContext;
		const state = latestMindModeState(eventCtx.sessionManager.getEntries());
		if (!state?.active) {
			activeMindSlug = undefined;
			inactiveMindSlug = state?.slug;
			setMindStatus(eventCtx, undefined);
			return;
		}

		if (!state.slug) {
			activeMindSlug = undefined;
			inactiveMindSlug = undefined;
			setMindStatus(eventCtx, undefined);
			return;
		}

		try {
			const loaded = loadMindContext(eventCtx.cwd, state.slug);
			activeMindSlug = loaded.slug;
			inactiveMindSlug = undefined;
			setMindStatus(eventCtx, loaded.slug);
		} catch (error) {
			activeMindSlug = undefined;
			inactiveMindSlug = state.slug;
			setMindStatus(eventCtx, undefined);
			persistState({
				active: false,
				slug: state.slug,
				deactivatedAt: new Date().toISOString(),
				reason: "restore validation failed",
			});
			notify(
				eventCtx,
				`Mind mode restore skipped: ${errorMessage(error)}`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const eventCtx = ctx as unknown as MindModeEventContext;
		if (!activeMindSlug) {
			if (!inactiveMindSlug) return undefined;
			// One-shot guard: name the previously-active mind once so the model
			// doesn't drift back into its voice mid-conversation, then clear.
			// Subsequent turns rely on normal base instructions; re-injecting
			// the guard every turn for the rest of the session would be
			// performative.
			const guardSlug = inactiveMindSlug;
			inactiveMindSlug = undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildMindModeOffSystemPrompt(guardSlug)}`,
			};
		}

		try {
			const loaded = loadMindContext(eventCtx.cwd, activeMindSlug);
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildMindModeSystemPrompt(loaded)}`,
			};
		} catch (error) {
			const failedSlug = activeMindSlug;
			activeMindSlug = undefined;
			inactiveMindSlug = failedSlug;
			setMindStatus(eventCtx, undefined);
			persistState({
				active: false,
				slug: failedSlug,
				deactivatedAt: new Date().toISOString(),
				reason: "load failed before turn",
			});
			notify(
				eventCtx,
				`Mind mode disabled because the active mind could not be loaded: ${errorMessage(error)}`,
				"warning",
			);
			return {
				systemPrompt: `${event.systemPrompt}\n\n${buildMindModeOffSystemPrompt(failedSlug)}`,
			};
		}
	});
}

function mindArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = safeListGenesisMinds(".").map((slug) => ({
		value: slug,
		label: slug,
		description: `Activate Genesis mind ${slug}`,
	}));
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function mindUsageText(): string {
	return "Usage: /mind <slug>, /mind list, /mind create, or /mind help. Use /exit to leave an active mind.";
}

function createMindText(): string {
	return [
		"/mind activates a complete Genesis mind; it does not create one directly.",
		'Create one with /genesis, /genesis custom, /genesis moneypenny, or /genesis name="Ariadne" role="..." voice="...".',
		"After Genesis completes, run /mind <slug> to activate it.",
	].join("\n");
}

function noMindsText(): string {
	return `No complete Genesis minds found for /mind.\n${createMindText()}`;
}

function availableMindSuffix(
	cwd: string,
	slugs = safeListGenesisMinds(cwd),
): string {
	return slugs.length
		? ` Available: ${slugs.join(", ")}.`
		: " No complete minds yet; create one with /genesis.";
}

function safeListGenesisMinds(cwd: string): string[] {
	try {
		return listGenesisMinds(cwd);
	} catch {
		return [];
	}
}

function buildMindModeOffSystemPrompt(previousSlug: string): string {
	return [
		"# Genesis Mind Mode Off",
		`The Genesis mind "${previousSlug}" is not active for this turn.`,
		"Do not inhabit, roleplay, or preserve the voice/persona of that previously active mind.",
		"Respond as the normal Pi coding assistant and follow the base system, developer, and project instructions.",
	].join("\n");
}

function latestMindModeState(
	entries: Array<Record<string, unknown>>,
): MindModeStateEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== STATE_STREAM) continue;
		const data = entry.data;
		if (data && typeof data === "object") return data as MindModeStateEntry;
	}
	return undefined;
}

function notify(
	ctx: Pick<MindModeCommandContext, "hasUI" | "ui">,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") {
		console.error(message);
		throw new Error(message);
	}
	console.log(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
