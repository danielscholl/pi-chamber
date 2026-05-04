import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	buildMindModeSystemPrompt,
	listGenesisMinds,
	loadMindContext,
	normalizeMindSlug,
} from "./core.ts";
import {
	type MindRetireCommandContext,
	runRetireCommand,
} from "./retire.ts";
import {
	registerSessionCommands,
	registerSessionTarget,
} from "../shared/session-exit.ts";

type MindModeSessionManager = {
	getEntries(): Array<Record<string, unknown>>;
	getLeafId?(): string | null;
};

type MindModeCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: MindModeSessionManager;
	waitForIdle?(): Promise<void>;
	fork?(
		entryId: string,
		options?: {
			position?: "before" | "at";
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
	/**
	 * Entry id of the session leaf at the moment of activation. Captured so
	 * /detach can fork the session back to that point, leaving the inhabited
	 * mind chat behind in the original session as an artifact.
	 */
	preMindLeafId?: string;
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

		// Capture the current leaf id BEFORE persisting the activation marker.
		// /detach uses this id to fork the session back to its pre-mind state.
		const preMindLeafId = safeGetLeafId(ctx);

		activeMindSlug = loaded.slug;
		inactiveMindSlug = undefined;
		persistState({
			active: true,
			slug: loaded.slug,
			mindPath: loaded.paths.mindPath,
			activatedAt: new Date().toISOString(),
			...(preMindLeafId ? { preMindLeafId } : {}),
		});
		setMindStatus(ctx, loaded.slug);
		notify(
			ctx,
			`Mind mode active: ${loaded.slug}. Future turns will inhabit ${loaded.paths.mindPath}. Use /leave to return to the normal assistant in this session, or /detach to rewind and preserve this chat as an artifact.`,
			"info",
		);
	}

	async function leaveMind(
		ctx: MindModeCommandContext,
		reason?: string,
	): Promise<void> {
		const state = latestMindModeState(ctx.sessionManager.getEntries());
		const previous = activeMindSlug ?? state?.slug;
		activeMindSlug = undefined;
		inactiveMindSlug = previous ?? inactiveMindSlug;
		persistState({
			active: false,
			...(previous ? { slug: previous } : {}),
			deactivatedAt: new Date().toISOString(),
			...(reason ? { reason } : {}),
		});
		setMindStatus(ctx, undefined);
		notify(
			ctx,
			previous
				? `Mind mode off. Left ${previous}; conversation continues in this session.`
				: "Mind mode off. Conversation continues in this session.",
			"info",
		);
	}

	async function detachMind(ctx: MindModeCommandContext): Promise<void> {
		const state = latestMindModeState(ctx.sessionManager.getEntries());
		const previous = activeMindSlug ?? state?.slug;
		const preMindLeafId = state?.preMindLeafId;

		if (!previous) {
			// isActive said yes but state is malformed. Treat as a leave to be safe.
			await leaveMind(ctx, "detach without slug");
			return;
		}

		if (!preMindLeafId || !ctx.fork) {
			notify(
				ctx,
				`Cannot detach ${previous}: no pre-mind fork point captured for this activation. Falling back to /leave; this chat stays in the current session.`,
				"warning",
			);
			await leaveMind(ctx, "detach fallback");
			return;
		}

		// Mark the OLD session as deactivated before forking so the artifact
		// is internally consistent: anyone returning to it later sees a clean
		// "detach" closing entry rather than a dangling active state.
		persistState({
			active: false,
			slug: previous,
			deactivatedAt: new Date().toISOString(),
			reason: "detach",
		});

		// Clear closure state. The forked session starts fresh; the "Mind Mode
		// Off" guard from leaveMind would only fire if a guard slug were set,
		// which we deliberately skip here because the new session never had
		// the mind in its own transcript.
		activeMindSlug = undefined;
		inactiveMindSlug = undefined;
		setMindStatus(ctx, undefined);

		await ctx.waitForIdle?.();

		try {
			const result = await ctx.fork(preMindLeafId, {
				position: "at",
				withSession: (replacementCtx) => {
					setMindStatus(replacementCtx, undefined);
					notify(
						replacementCtx,
						`Detached from ${previous}. Session rewound to before activation; the ${previous} chat is preserved as an artifact.`,
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(ctx, "Detach cancelled.", "info");
			}
		} catch (error) {
			notify(
				ctx,
				`Detach failed: ${errorMessage(error)}. Mind chat remains in this session.`,
				"warning",
			);
		}
	}

	registerSessionTarget(pi, {
		id: "mind",
		label: "mind",
		priority: 20,
		isActive: (ctx) => {
			const state = latestMindModeState(ctx.sessionManager.getEntries());
			return Boolean(activeMindSlug || (state?.active && state.slug));
		},
		leave: async (ctx) => {
			await leaveMind(
				ctx as unknown as MindModeCommandContext,
				"leave command",
			);
		},
		detach: async (ctx) => {
			await detachMind(ctx as unknown as MindModeCommandContext);
		},
	});
	registerSessionCommands(pi);

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

			// /mind retire [slug] — single-mind teardown. Subcommand keyword is
			// reserved in mind/core.ts so a mind cannot be named `retire`.
			if (lower === "retire" || lower.startsWith("retire ")) {
				const rest = value.slice("retire".length).trim();
				const retireCtx =
					commandCtx as unknown as MindRetireCommandContext;
				await runRetireCommand(
					rest ? { slug: rest } : {},
					retireCtx,
					{
						appendEntry: (stream, entry) => pi.appendEntry(stream, entry),
						isActiveMind: (slug) => activeMindSlug === slug,
					},
				);
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

function safeGetLeafId(ctx: MindModeCommandContext): string | undefined {
	try {
		const id = ctx.sessionManager.getLeafId?.();
		return id ?? undefined;
	} catch {
		return undefined;
	}
}

function mindArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = safeListGenesisMinds(".").map((slug) => ({
		value: slug,
		label: slug,
		description: `Activate Genesis mind ${slug}`,
	}));
	items.push({
		value: "retire",
		label: "retire",
		description: "Retire (delete) a Genesis mind",
	});
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function mindUsageText(): string {
	return "Usage: /mind <slug>, /mind list, /mind create, /mind retire [<slug>], or /mind help. Use /leave or /detach to end an active mind.";
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
