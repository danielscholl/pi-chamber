/**
 * room-observatory — write a status-board observatory lens that mirrors
 * the active room state. Reload-based: the user sees updates by
 * refreshing the browser. Conforms to the v1 observatory lens schema
 * (status-board kind, data.json source) and stays inside the project via
 * assertInsideProject.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import path from "node:path";
import { loadObservatoryConfig, resolveLensesRoot } from "../observatory/core.ts";
import { assertInsideProject } from "../genesis/core.ts";
import { MIND_PALETTE } from "./ui.ts";

export const LENS_ID = "room";
export const LENS_DATA_FILE = "data.json";
export const LENS_MANIFEST_FILE = "lens.json";

export type ObservatoryParticipantStatus =
	| "ready"
	| "thinking"
	| "speaking"
	| "done"
	| "aborted"
	| "error";

export type ObservatoryParticipant = {
	name: string;
	status: ObservatoryParticipantStatus;
	role: "speaker" | "moderator";
	color: string;
	turns: number;
	lastReply?: string;
};

export type ObservatoryRoomSnapshot = {
	active: boolean;
	mode: string;
	roomLabel?: string;
	startedAt?: string;
	updatedAt: string;
	participants: ObservatoryParticipant[];
	lastMetrics?: {
		turns: number;
		durationMs: number;
		mode: string;
	};
};

export type ResolvedObservatoryPaths = {
	lensDir: string;
	manifestPath: string;
	dataPath: string;
};

export function resolveChamberObservatoryPaths(cwd: string): ResolvedObservatoryPaths {
	const config = loadObservatoryConfig(cwd);
	const lensesRoot = resolveLensesRoot(cwd, config);
	const lensDir = path.join(lensesRoot, LENS_ID);
	assertInsideProject(cwd, lensDir, "room observatory lensDir");
	return {
		lensDir,
		manifestPath: path.join(lensDir, LENS_MANIFEST_FILE),
		dataPath: path.join(lensDir, LENS_DATA_FILE),
	};
}

export function buildChamberObservatoryManifest(): Record<string, unknown> {
	return {
		name: "Chamber Room",
		kind: "status-board",
		source: LENS_DATA_FILE,
		icon: "users",
		description:
			"Live multi-mind room state. Reload to see the latest snapshot.",
	};
}

export function buildChamberObservatoryData(
	snapshot: ObservatoryRoomSnapshot,
): ObservatoryParticipant[] {
	if (!snapshot.active || snapshot.participants.length === 0) {
		return [];
	}
	return snapshot.participants.map((p) => ({
		name: p.name,
		status: p.status,
		role: p.role,
		color: p.color,
		turns: p.turns,
		...(p.lastReply ? { lastReply: truncate(p.lastReply, 280) } : {}),
	}));
}

export function writeChamberObservatoryLens(
	cwd: string,
	snapshot: ObservatoryRoomSnapshot,
): ResolvedObservatoryPaths {
	const paths = resolveChamberObservatoryPaths(cwd);
	mkdirSync(paths.lensDir, { recursive: true });
	const manifest = buildChamberObservatoryManifest();
	writeFileSync(
		paths.manifestPath,
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf-8",
	);
	const data = buildChamberObservatoryData(snapshot);
	writeFileSync(paths.dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	return paths;
}

export function clearChamberObservatoryLens(cwd: string): void {
	let paths: ResolvedObservatoryPaths;
	try {
		paths = resolveChamberObservatoryPaths(cwd);
	} catch {
		return;
	}
	if (existsSync(paths.lensDir)) {
		try {
			rmSync(paths.lensDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
}

export function paletteNameForIndex(index: number): string {
	const slot = MIND_PALETTE[index] ?? MIND_PALETTE[0];
	return slot?.name ?? "default";
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}
