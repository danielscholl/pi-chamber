// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import { existsSync } from "node:fs";
import {
	type GenesisConfig,
	loadGenesisConfig,
	resolveGenesisPaths,
} from "../genesis/core.ts";
import {
	removeMindOnce,
	type RemoveMindOnceResult,
} from "../genesis/index.ts";
import {
	listSavedRooms,
	type SavedRoomSummary,
} from "../room/core.ts";
import { listGenesisMinds, normalizeMindSlug } from "./core.ts";

export interface MindRetireArgs {
	slug?: string;
}

export interface MindRetireCommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(prompt: string, options: string[]): Promise<string | undefined>;
		setStatus?(key: string, value: string | undefined): void;
	};
}

export interface MindRetireDeps {
	appendEntry: (stream: string, entry: Record<string, unknown>) => void;
	/**
	 * Returns true when the given slug is the live, currently-active mind in
	 * this session. Retire refuses on an active mind so the user must /leave or
	 * /detach first; otherwise mind-mode injection would target a deleted dir
	 * on the next turn.
	 */
	isActiveMind: (slug: string) => boolean;
}

// ---------------------------------------------------------------------------
// /mind retire — single-mind teardown
//
// Resolves the target slug (or shows a picker), refuses when the mind is
// currently active or referenced by any saved room, confirms with the user,
// then delegates per-mind removal to genesis/removeMindOnce. Newspaper lens
// removal is handled inside removeMindOnce; this orchestrator only adds the
// safety checks that scope-broader-than-genesis requires.
// ---------------------------------------------------------------------------

export async function runRetireCommand(
	args: MindRetireArgs,
	ctx: MindRetireCommandContext,
	deps: MindRetireDeps,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"/mind retire requires interactive UI. Run it from a Pi session with UI enabled.",
			"error",
		);
		return;
	}

	let config: GenesisConfig;
	try {
		config = loadGenesisConfig(ctx.cwd);
	} catch (error) {
		notify(
			ctx,
			`Genesis configuration could not be loaded: ${errorMessage(error)}`,
			"error",
		);
		return;
	}

	setStatus(ctx, "retiring: resolving target…");

	const targetSlug = await resolveTargetSlug(args.slug, config, ctx);
	if (!targetSlug) {
		setStatus(ctx, undefined);
		return;
	}

	if (deps.isActiveMind(targetSlug)) {
		setStatus(ctx, undefined);
		notify(
			ctx,
			`Mind "${targetSlug}" is currently active in this session. Use /leave (or /detach) before retiring it.`,
			"error",
		);
		return;
	}

	const blockingRooms = findBlockingRooms(ctx.cwd, targetSlug);
	if (blockingRooms.length > 0) {
		setStatus(ctx, undefined);
		notify(ctx, renderBlockedByRooms(targetSlug, blockingRooms), "error");
		return;
	}

	if (!ctx.ui.select) {
		setStatus(ctx, undefined);
		notify(ctx, "UI does not support select; cannot confirm retire.", "error");
		return;
	}
	notify(ctx, renderRetireConfirmation(targetSlug), "info");
	const choice = await ctx.ui.select.call(
		ctx.ui,
		`Retire mind "${targetSlug}"?`,
		["Retire", "Cancel"],
	);
	if (!choice || choice === "Cancel") {
		setStatus(ctx, undefined);
		notify(ctx, "Retire cancelled. No files were removed.", "info");
		return;
	}

	setStatus(ctx, "retiring: removing files…");

	const result = await removeMindOnce(
		targetSlug,
		ctx.cwd,
		config,
		deps.appendEntry,
		{ source: "mind-retire" },
	);

	setStatus(ctx, undefined);
	notify(
		ctx,
		renderRetireSummary(targetSlug, result),
		result.ok ? "info" : "error",
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveTargetSlug(
	slugArg: string | undefined,
	config: GenesisConfig,
	ctx: MindRetireCommandContext,
): Promise<string | undefined> {
	if (slugArg) {
		let slug: string;
		try {
			slug = normalizeMindSlug(slugArg);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return undefined;
		}
		// Check the mind directory exists rather than full validity. A
		// partially-authored mind (e.g. genesis crashed mid-write) should still
		// be retireable — removeMindOnce is idempotent on missing files.
		try {
			const paths = resolveGenesisPaths(ctx.cwd, slug, config);
			if (!existsSync(paths.mindPath)) {
				const known = safeListGenesisMinds(ctx.cwd);
				const hint = known.length
					? ` Available: ${known.join(", ")}.`
					: "";
				notify(
					ctx,
					`No mind directory found at slug "${slug}".${hint}`,
					"error",
				);
				return undefined;
			}
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return undefined;
		}
		return slug;
	}

	const minds = safeListGenesisMinds(ctx.cwd);
	if (minds.length === 0) {
		notify(
			ctx,
			"No Genesis minds to retire. Author one with /genesis first.",
			"error",
		);
		return undefined;
	}

	if (!ctx.ui.select) {
		notify(
			ctx,
			"UI does not support select; pass a slug: /mind retire <slug>",
			"error",
		);
		return undefined;
	}

	const choice = await ctx.ui.select.call(ctx.ui, "Retire which mind?", minds);
	return choice;
}

function findBlockingRooms(cwd: string, slug: string): SavedRoomSummary[] {
	const rooms = listSavedRooms(cwd);
	return rooms.filter((r) => r.participants.includes(slug));
}

function safeListGenesisMinds(cwd: string): string[] {
	try {
		return listGenesisMinds(cwd);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderRetireConfirmation(slug: string): string {
	return [
		`RETIRING — ${slug}`,
		`  mind directory: .pi/minds/${slug}/`,
		`  shim:           .pi/agents/${slug}.md`,
		`  newspaper lens: .pi/observatory/lenses/${slug}-newspaper/`,
	].join("\n");
}

function renderBlockedByRooms(
	slug: string,
	rooms: SavedRoomSummary[],
): string {
	const assembly = rooms.filter((r) => r.assembledBy === "assembly");
	const handRolled = rooms.filter((r) => r.assembledBy !== "assembly");
	const lines: string[] = [
		`Cannot retire "${slug}": still referenced by saved room${rooms.length === 1 ? "" : "s"}.`,
	];
	for (const r of handRolled) {
		lines.push(`  ${r.slug}   (use /room close ${r.slug})`);
	}
	for (const r of assembly) {
		lines.push(`  ${r.slug}   [assembly] (use /assembly adjourn ${r.slug})`);
	}
	return lines.join("\n");
}

function renderRetireSummary(
	slug: string,
	result: RemoveMindOnceResult,
): string {
	if (!result.ok) {
		return `Retire failed for "${slug}": ${result.error ?? "unknown error"}`;
	}
	const removed: string[] = [];
	if (result.removed.mind) removed.push("mind directory");
	if (result.removed.shim) removed.push("shim");
	if (result.removed.newspaper) removed.push("newspaper lens");
	const lines: string[] = [`RETIRED — ${slug}`];
	if (removed.length) {
		lines.push(`  removed: ${removed.join(", ")}`);
	} else {
		lines.push("  removed: nothing (mind was already absent)");
	}
	if (result.newspaperError) {
		lines.push(`  lens warning: ${result.newspaperError}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UI helpers (mirror assembly/adjourn.ts patterns)
// ---------------------------------------------------------------------------

function notify(
	ctx: MindRetireCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") throw new Error(message);
}

function setStatus(
	ctx: MindRetireCommandContext,
	value: string | undefined,
): void {
	if (!ctx.hasUI) return;
	const setter = ctx.ui.setStatus;
	if (typeof setter !== "function") return;
	try {
		setter.call(ctx.ui, "mind", value);
	} catch {
		/* status updates are best-effort */
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
