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
import { notify } from "../shared/notice.ts";

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
	const assemblyRooms = allRooms.filter((r) => r.assembledBy === "assembly");

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
			`Room "${targetSlug}" lacks the /assembly provenance marker (legacy assembly room or hand-rolled). Use /room delete to remove it.`,
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

	const anyMemberFailed = results.some((r) => !r.ok);

	let teamLensRemoved = false;
	let teamLensSkipped = false;
	let roomRemoved = false;
	let roomSkipped = false;

	if (anyMemberFailed) {
		// Leave the lens and room in place so the operator can inspect what was
		// partially removed and retry. Otherwise the failed mind would be
		// orphaned with no parent room to recover the team from.
		teamLensSkipped = true;
		roomSkipped = true;
		notify(
			ctx,
			"Skipped lens and room teardown because at least one member could not be removed. Re-run /assembly adjourn after resolving the failures.",
			"warning",
		);
	} else {
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

		try {
			const { roomDir } = resolveSavedRoomPaths(ctx.cwd, targetSlug);
			const roomExistedBefore = existsSync(roomDir);
			deleteSavedRoom(ctx.cwd, targetSlug);
			roomRemoved = roomExistedBefore && !existsSync(roomDir);
		} catch (error) {
			notify(
				ctx,
				`Could not delete saved room: ${errorMessage(error)}`,
				"error",
			);
		}
	}

	appendAdjournAudit(deps.appendEntry, room, partition, results);

	setStatus(ctx, "genesis ready");
	notify(
		ctx,
		renderAdjournSummary(
			room,
			partition,
			results,
			{ removed: teamLensRemoved, skipped: teamLensSkipped },
			{ removed: roomRemoved, skipped: roomSkipped },
		),
		anyMemberFailed ? "warning" : "info",
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	// Dedupe: a defensive participant list could include the same slug twice;
	// without this, the duplicate's removeMindOnce call would no-op against an
	// already-deleted dir and pollute the results array.
	const uniqueParticipants = Array.from(new Set(target.participants));
	for (const slug of uniqueParticipants) {
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
		const removed = results
			.filter(
				(r) =>
					r.ok && (r.removed.mind || r.removed.shim || r.removed.newspaper),
			)
			.map((r) => r.slug);
		const alreadyAbsent = results
			.filter(
				(r) =>
					r.ok && !r.removed.mind && !r.removed.shim && !r.removed.newspaper,
			)
			.map((r) => r.slug);
		const lensWarnings = results
			.filter((r) => r.ok && r.newspaperError)
			.map((r) => ({ slug: r.slug, error: r.newspaperError as string }));
		appendEntry("genesis-assemble", {
			action: "adjourn",
			teamSlug: room.slug,
			teamName: room.name,
			removedMembers: removed,
			...(alreadyAbsent.length ? { alreadyAbsent } : {}),
			failedRemovals: results
				.filter((r) => !r.ok)
				.map((r) => ({ slug: r.slug, error: r.error ?? "unknown" })),
			...(lensWarnings.length ? { lensWarnings } : {}),
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

interface ArtifactOutcome {
	removed: boolean;
	skipped: boolean;
}

function renderArtifactStatus(outcome: ArtifactOutcome): string {
	if (outcome.removed) return "deleted";
	if (outcome.skipped) return "skipped (member removal failed)";
	return "skipped (not present)";
}

function renderAdjournSummary(
	room: SavedRoom,
	partition: MemberPartition,
	results: RemoveMindOnceResult[],
	teamLens: ArtifactOutcome,
	roomOutcome: ArtifactOutcome,
): string {
	// Split results three ways: actually-removed (something existed and got
	// deleted), already-gone (ok=true but nothing was on disk), and failed.
	const removed = results.filter(
		(r) => r.ok && (r.removed.mind || r.removed.shim || r.removed.newspaper),
	);
	const alreadyGone = results.filter(
		(r) =>
			r.ok && !r.removed.mind && !r.removed.shim && !r.removed.newspaper,
	);
	const failed = results.filter((r) => !r.ok);
	const lensIssues = results.filter((r) => r.ok && r.newspaperError);

	const lines: string[] = [];
	lines.push(`ADJOURNED — ${room.name}`);
	lines.push(
		`  removed:    ${removed.length} mind${removed.length === 1 ? "" : "s"}${removed.length ? ` (${removed.map((r) => r.slug).join(", ")})` : ""}`,
	);
	if (alreadyGone.length > 0) {
		lines.push(
			`  skipped:    ${alreadyGone.length} (already absent: ${alreadyGone.map((r) => r.slug).join(", ")})`,
		);
	}
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
	if (lensIssues.length > 0) {
		lines.push(`  lens warnings: ${lensIssues.length}`);
		for (const l of lensIssues) {
			lines.push(`    ${l.slug}: ${l.newspaperError}`);
		}
	}
	lines.push(`  team lens:  ${renderArtifactStatus(teamLens)}`);
	lines.push(`  room:       ${renderArtifactStatus(roomOutcome)}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UI helpers (mirror assembly/core.ts patterns)
// ---------------------------------------------------------------------------

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
