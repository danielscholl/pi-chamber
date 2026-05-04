// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type GenesisConfig,
	loadGenesisConfig,
} from "../genesis/core.ts";
import {
	removeMindOnce,
	type RemoveMindOnceResult,
} from "../genesis/index.ts";
import {
	loadObservatoryConfig,
	removeTeamStatusBoard,
	resolveLensesRoot,
} from "../observatory/core.ts";
import {
	deleteSavedRoom,
	listSavedRooms,
	resolveSavedRoomPaths,
	safeReadSavedRoom,
	type SavedRoom,
	type SavedRoomSummary,
} from "../room/core.ts";
import type { AssembleCommandContext } from "./core.ts";

export interface AdjournDeps {
	pi: ExtensionAPI;
	appendEntry: (stream: string, entry: Record<string, unknown>) => void;
}

export interface AdjournArgs {
	adjournSlug?: string;
}

interface MemberPartition {
	removable: string[];
	preserved: Array<{ slug: string; otherRooms: string[] }>;
}

// ---------------------------------------------------------------------------
// /assembly adjourn — full teardown
//
// Resolves the target slug (or shows a picker), refuses non-assembly rooms,
// partitions members by cross-room references (preserving any mind another
// saved room still uses), confirms with the user, then removes minds + lens
// + room and writes audit entries.
// ---------------------------------------------------------------------------

export async function runAdjournCommand(
	args: AdjournArgs,
	ctx: AssembleCommandContext,
	deps: AdjournDeps,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"/assembly adjourn requires interactive UI. Run it from a Pi session with UI enabled.",
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

	setStatus(ctx, "adjourning: resolving target…");

	const allRooms = listSavedRooms(ctx.cwd);
	const assemblyRooms = allRooms.filter((r) => isAssemblyRoom(ctx.cwd, r.slug));

	const targetSlug = await resolveTargetSlug(
		args.adjournSlug,
		assemblyRooms,
		ctx,
	);
	if (!targetSlug) {
		setStatus(ctx, "genesis ready");
		return;
	}

	const room = safeReadSavedRoom(ctx.cwd, targetSlug);
	if (!room) {
		setStatus(ctx, "genesis ready");
		notify(ctx, `No saved room found for slug "${targetSlug}".`, "error");
		return;
	}
	if (room.assembledBy !== "assembly") {
		setStatus(ctx, "genesis ready");
		notify(
			ctx,
			`Room "${targetSlug}" wasn't created by /assembly. Use /room delete instead.`,
			"error",
		);
		return;
	}

	const partition = partitionMembers(room, allRooms);

	if (!ctx.ui.select) {
		setStatus(ctx, "genesis ready");
		notify(ctx, "UI does not support select; cannot confirm adjourn.", "error");
		return;
	}
	notify(ctx, renderAdjournConfirmation(room, partition), "info");
	const choice = await ctx.ui.select.call(ctx.ui, "Adjourn this team?", [
		"Adjourn",
		"Cancel",
	]);
	if (!choice || choice === "Cancel") {
		setStatus(ctx, "genesis ready");
		notify(ctx, "Adjourn cancelled. No files were removed.", "info");
		return;
	}

	setStatus(ctx, "adjourning: removing members…");

	const results: RemoveMindOnceResult[] = [];
	for (const slug of partition.removable) {
		const result = await removeMindOnce(
			slug,
			ctx.cwd,
			config,
			deps.appendEntry,
			{ source: `assembly-adjourn:${targetSlug}` },
		);
		results.push(result);
	}

	let teamLensRemoved = false;
	try {
		const observatoryConfig = loadObservatoryConfig(ctx.cwd);
		const lensesRoot = resolveLensesRoot(ctx.cwd, observatoryConfig);
		const lensResult = removeTeamStatusBoard(lensesRoot, targetSlug);
		teamLensRemoved = lensResult.removed;
	} catch (error) {
		notify(
			ctx,
			`Could not remove team lens: ${errorMessage(error)}`,
			"warning",
		);
	}

	let roomRemoved = false;
	try {
		deleteSavedRoom(ctx.cwd, targetSlug);
		roomRemoved = !existsSync(resolveSavedRoomPaths(ctx.cwd, targetSlug).roomDir);
	} catch (error) {
		notify(
			ctx,
			`Could not delete saved room: ${errorMessage(error)}`,
			"error",
		);
	}

	appendAdjournAudit(deps.appendEntry, room, partition, results);

	setStatus(ctx, "genesis ready");
	notify(
		ctx,
		renderAdjournSummary(
			room,
			partition,
			results,
			teamLensRemoved,
			roomRemoved,
		),
		results.some((r) => !r.ok) ? "warning" : "info",
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssemblyRoom(cwd: string, slug: string): boolean {
	const room = safeReadSavedRoom(cwd, slug);
	return room?.assembledBy === "assembly";
}

async function resolveTargetSlug(
	slugArg: string | undefined,
	assemblyRooms: SavedRoomSummary[],
	ctx: AssembleCommandContext,
): Promise<string | undefined> {
	if (slugArg) {
		// Validate the room actually exists; we don't check assembledBy here so the
		// caller can produce a clear "not an assembly" error later.
		try {
			const { roomDir } = resolveSavedRoomPaths(ctx.cwd, slugArg);
			if (!existsSync(roomDir)) {
				notify(
					ctx,
					`No saved room found for slug "${slugArg}". Use /room to list saved rooms.`,
					"error",
				);
				return undefined;
			}
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return undefined;
		}
		return slugArg;
	}

	if (assemblyRooms.length === 0) {
		notify(
			ctx,
			"No assemblies to adjourn. Convene one with /assembly first.",
			"error",
		);
		return undefined;
	}

	if (assemblyRooms.length === 1) {
		return assemblyRooms[0].slug;
	}

	if (!ctx.ui.select) {
		notify(
			ctx,
			"UI does not support select; pass a slug: /assembly adjourn <slug>",
			"error",
		);
		return undefined;
	}

	const labelMap = new Map<string, string>();
	const options = assemblyRooms.map((r) => {
		const label = `${r.name} (${r.slug}) — ${r.participants.length} member${r.participants.length === 1 ? "" : "s"}`;
		labelMap.set(label, r.slug);
		return label;
	});
	const choice = await ctx.ui.select.call(
		ctx.ui,
		"Adjourn which team?",
		options,
	);
	return choice ? labelMap.get(choice) : undefined;
}

function partitionMembers(
	target: SavedRoom,
	allRooms: SavedRoomSummary[],
): MemberPartition {
	const partition: MemberPartition = { removable: [], preserved: [] };
	for (const slug of target.participants) {
		const otherRooms: string[] = [];
		for (const other of allRooms) {
			if (other.slug === target.slug) continue;
			if (other.participants.includes(slug)) {
				otherRooms.push(other.slug);
			}
		}
		if (otherRooms.length > 0) {
			partition.preserved.push({ slug, otherRooms });
		} else {
			partition.removable.push(slug);
		}
	}
	return partition;
}

function appendAdjournAudit(
	appendEntry: AdjournDeps["appendEntry"],
	room: SavedRoom,
	partition: MemberPartition,
	results: RemoveMindOnceResult[],
): void {
	try {
		appendEntry("genesis-assemble", {
			action: "adjourn",
			teamSlug: room.slug,
			teamName: room.name,
			removedMembers: results
				.filter((r) => r.ok)
				.map((r) => r.slug),
			failedRemovals: results
				.filter((r) => !r.ok)
				.map((r) => ({ slug: r.slug, error: r.error ?? "unknown" })),
			preservedMembers: partition.preserved,
			adjournedAt: new Date().toISOString(),
		});
	} catch {
		/* audit is best-effort */
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAdjournConfirmation(
	room: SavedRoom,
	partition: MemberPartition,
): string {
	const lines: string[] = [];
	lines.push(`ADJOURNING — ${room.name}`);
	lines.push(`  team slug:   ${room.slug}`);
	lines.push(`  room:        .pi/rooms/${room.slug}/`);
	lines.push(`  team lens:   .pi/observatory/lenses/${room.slug}-team/`);
	lines.push(`  members:`);
	for (const slug of partition.removable) {
		lines.push(`    ${slug}   will be removed`);
	}
	for (const { slug, otherRooms } of partition.preserved) {
		const others = otherRooms.map((s) => `"${s}"`).join(", ");
		lines.push(
			`    ${slug}   PRESERVED (also in saved room${otherRooms.length === 1 ? "" : "s"} ${others})`,
		);
	}
	if (partition.removable.length === 0 && partition.preserved.length === 0) {
		lines.push("    (none)");
	}
	return lines.join("\n");
}

function renderAdjournSummary(
	room: SavedRoom,
	partition: MemberPartition,
	results: RemoveMindOnceResult[],
	teamLensRemoved: boolean,
	roomRemoved: boolean,
): string {
	const succeeded = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok);
	const lines: string[] = [];
	lines.push(`ADJOURNED — ${room.name}`);
	lines.push(
		`  removed:    ${succeeded.length} mind${succeeded.length === 1 ? "" : "s"}${succeeded.length ? ` (${succeeded.map((r) => r.slug).join(", ")})` : ""}`,
	);
	if (partition.preserved.length > 0) {
		lines.push(
			`  preserved:  ${partition.preserved.length} (${partition.preserved.map((p) => p.slug).join(", ")})`,
		);
	}
	if (failed.length > 0) {
		lines.push(`  failed:     ${failed.length}`);
		for (const f of failed) {
			lines.push(`    ${f.slug}: ${f.error ?? "unknown"}`);
		}
	}
	lines.push(`  team lens:  ${teamLensRemoved ? "deleted" : "skipped (not present)"}`);
	lines.push(`  room:       ${roomRemoved ? "deleted" : "skipped (not present)"}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UI helpers (mirror assembly/core.ts patterns)
// ---------------------------------------------------------------------------

function notify(
	ctx: AssembleCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") throw new Error(message);
}

function setStatus(ctx: AssembleCommandContext, value: string): void {
	if (!ctx.hasUI) return;
	const setter = ctx.ui.setStatus;
	if (typeof setter !== "function") return;
	try {
		setter.call(ctx.ui, "genesis", value);
	} catch {
		/* status updates are best-effort */
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
