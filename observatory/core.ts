// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import {
	assertInsideProject,
	resolveProjectRelativePath,
} from "../genesis/core.ts";

export const ALLOWED_LENS_KINDS = ["briefing", "status-board"] as const;
export type LensKind = (typeof ALLOWED_LENS_KINDS)[number];

export const LENS_MANIFEST_FILE = "lens.json";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ObservatoryConfig {
	lensesPath: string;
}

export const DEFAULT_OBSERVATORY_CONFIG: ObservatoryConfig = {
	lensesPath: "./.pi/observatory/lenses",
};

export interface LensManifest {
	id: string;
	name: string;
	kind: LensKind;
	source: string;
	icon?: string;
	description?: string;
}

export type DiscoveryEntry =
	| { id: string; status: "ok"; manifest: LensManifest }
	| { id: string; status: "invalid"; reason: string };

export interface ValidationOk<T> {
	ok: true;
	value: T;
}

export interface ValidationFail {
	ok: false;
	reason: string;
}

export type ValidationResult<T> = ValidationOk<T> | ValidationFail;

export function loadObservatoryConfig(cwd: string): ObservatoryConfig {
	const config = { ...DEFAULT_OBSERVATORY_CONFIG };
	const settingsPath = path.join(cwd, ".pi", "settings.json");
	if (!existsSync(settingsPath)) {
		return config;
	}

	const raw = readFileSync(settingsPath, "utf-8");
	let settings: { observatory?: Record<string, unknown> };
	try {
		settings = JSON.parse(raw) as { observatory?: Record<string, unknown> };
	} catch (error) {
		throw new Error(
			`Failed to parse .pi/settings.json for Observatory config: ${errorMessage(error)}`,
		);
	}

	const observatory = settings.observatory;
	if (!observatory || typeof observatory !== "object") {
		return config;
	}

	if (typeof observatory.lensesPath === "string") {
		config.lensesPath = observatory.lensesPath;
	}
	// Legacy fields (port, host, openOnStart) from the HTTP-server era are
	// silently ignored. The TUI rework removed the server.

	return config;
}

export function resolveLensesRoot(
	cwd: string,
	config: ObservatoryConfig = DEFAULT_OBSERVATORY_CONFIG,
): string {
	return resolveProjectRelativePath(cwd, config.lensesPath, "lensesPath");
}

export function validateLensId(id: string): ValidationResult<string> {
	if (typeof id !== "string" || id.length === 0) {
		return { ok: false, reason: "lens id must be a non-empty string" };
	}
	if (!SLUG_PATTERN.test(id)) {
		return {
			ok: false,
			reason: "lens id must be lowercase alphanumeric with internal dashes (e.g. mind-status)",
		};
	}
	return { ok: true, value: id };
}

export function validateSourceFilename(
	source: string,
): ValidationResult<string> {
	if (typeof source !== "string" || source.length === 0) {
		return { ok: false, reason: "source must be a non-empty string" };
	}
	if (source.includes("/") || source.includes("\\")) {
		return {
			ok: false,
			reason: "source must be a bare filename, not a path",
		};
	}
	if (source === "." || source === "..") {
		return { ok: false, reason: "source must be a bare filename" };
	}
	if (path.isAbsolute(source)) {
		return { ok: false, reason: "source must not be an absolute path" };
	}
	if (source === LENS_MANIFEST_FILE) {
		return {
			ok: false,
			reason: `source must not be ${LENS_MANIFEST_FILE}`,
		};
	}
	return { ok: true, value: source };
}

export function validateLensManifest(
	id: string,
	raw: unknown,
): ValidationResult<LensManifest> {
	if (!raw || typeof raw !== "object") {
		return { ok: false, reason: "lens.json must be a JSON object" };
	}
	const obj = raw as Record<string, unknown>;

	const name = obj.name;
	if (typeof name !== "string" || name.trim().length === 0) {
		return { ok: false, reason: "lens.json missing required string: name" };
	}

	const kind = obj.kind;
	if (typeof kind !== "string") {
		return { ok: false, reason: "lens.json missing required string: kind" };
	}
	if (!ALLOWED_LENS_KINDS.includes(kind as LensKind)) {
		return {
			ok: false,
			reason: `lens.json kind must be one of ${ALLOWED_LENS_KINDS.join(" | ")} (got ${kind})`,
		};
	}

	const source = obj.source;
	if (typeof source !== "string") {
		return {
			ok: false,
			reason: "lens.json missing required string: source",
		};
	}
	const sourceCheck = validateSourceFilename(source);
	if (!sourceCheck.ok) {
		return { ok: false, reason: `lens.json source: ${sourceCheck.reason}` };
	}

	const manifest: LensManifest = {
		id,
		name: name.trim(),
		kind: kind as LensKind,
		source,
	};
	if (typeof obj.icon === "string" && obj.icon.trim().length > 0) {
		manifest.icon = obj.icon.trim();
	}
	if (typeof obj.description === "string" && obj.description.trim().length > 0) {
		manifest.description = obj.description.trim();
	}

	return { ok: true, value: manifest };
}

export function discoverLenses(lensesRoot: string): DiscoveryEntry[] {
	if (!existsSync(lensesRoot)) {
		return [];
	}
	let entries: string[];
	try {
		entries = readdirSync(lensesRoot);
	} catch (error) {
		throw new Error(
			`Failed to read observatory lenses directory ${lensesRoot}: ${errorMessage(error)}`,
		);
	}

	const results: DiscoveryEntry[] = [];

	for (const entry of entries.sort()) {
		if (entry.startsWith(".")) continue;
		const folder = path.join(lensesRoot, entry);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(folder);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;

		const idCheck = validateLensId(entry);
		if (!idCheck.ok) {
			results.push({ id: entry, status: "invalid", reason: idCheck.reason });
			continue;
		}

		const manifestPath = path.join(folder, LENS_MANIFEST_FILE);
		if (!existsSync(manifestPath)) {
			results.push({
				id: entry,
				status: "invalid",
				reason: `missing ${LENS_MANIFEST_FILE}`,
			});
			continue;
		}

		let raw: string;
		try {
			raw = readFileSync(manifestPath, "utf-8");
		} catch (error) {
			results.push({
				id: entry,
				status: "invalid",
				reason: `cannot read ${LENS_MANIFEST_FILE}: ${errorMessage(error)}`,
			});
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			results.push({
				id: entry,
				status: "invalid",
				reason: `${LENS_MANIFEST_FILE} is not valid JSON: ${errorMessage(error)}`,
			});
			continue;
		}

		const manifestCheck = validateLensManifest(entry, parsed);
		if (!manifestCheck.ok) {
			results.push({
				id: entry,
				status: "invalid",
				reason: manifestCheck.reason,
			});
			continue;
		}

		results.push({
			id: entry,
			status: "ok",
			manifest: manifestCheck.value,
		});
	}

	return results;
}

export function resolveDataFilePath(
	lensesRoot: string,
	id: string,
	source: string,
): string {
	const idCheck = validateLensId(id);
	if (!idCheck.ok) {
		throw new Error(`invalid lens id: ${idCheck.reason}`);
	}
	const sourceCheck = validateSourceFilename(source);
	if (!sourceCheck.ok) {
		throw new Error(`invalid source: ${sourceCheck.reason}`);
	}

	const lensFolder = path.resolve(lensesRoot, id);
	assertInsideProject(lensesRoot, lensFolder, "lensFolder");

	const finalPath = path.resolve(lensFolder, source);
	const relativeToFolder = path.relative(lensFolder, finalPath);
	if (
		relativeToFolder === "" ||
		relativeToFolder.startsWith("..") ||
		path.isAbsolute(relativeToFolder)
	) {
		throw new Error(`source resolves outside lens folder: ${source}`);
	}

	if (existsSync(finalPath)) {
		const stat = lstatSync(finalPath);
		if (stat.isSymbolicLink()) {
			throw new Error(`source must not be a symbolic link: ${source}`);
		}
	}

	return finalPath;
}

export type LensDataResult =
	| { ok: true; data: unknown }
	| { ok: false; reason: string };

export function readLensData(
	lensesRoot: string,
	id: string,
	manifest: Pick<LensManifest, "source">,
): LensDataResult {
	let dataPath: string;
	try {
		dataPath = resolveDataFilePath(lensesRoot, id, manifest.source);
	} catch (error) {
		return { ok: false, reason: errorMessage(error) };
	}
	if (!existsSync(dataPath)) {
		return { ok: false, reason: `data file is missing: ${manifest.source}` };
	}
	let raw: string;
	try {
		raw = readFileSync(dataPath, "utf-8");
	} catch (error) {
		return {
			ok: false,
			reason: `cannot read data file: ${errorMessage(error)}`,
		};
	}
	try {
		return { ok: true, data: JSON.parse(raw) };
	} catch (error) {
		return {
			ok: false,
			reason: `data file is not valid JSON: ${errorMessage(error)}`,
		};
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// ---------------------------------------------------------------------------
// Lens activity (most-recently-modified data file across all lenses)
//
// Used by the Dashboard's Activity panel. Pure I/O lives here in `core.ts`
// so render-* modules can stay (data, width) → string[].
// ---------------------------------------------------------------------------

export interface DashboardActivity {
	lensId: string;
	mtimeMs: number;
}

export function lensesActivitySummary(
	lensesRoot: string,
): DashboardActivity | null {
	if (!existsSync(lensesRoot)) return null;
	let entries: string[];
	try {
		entries = readdirSync(lensesRoot);
	} catch {
		return null;
	}
	let best: DashboardActivity | null = null;
	for (const id of entries) {
		if (id.startsWith(".")) continue;
		const folder = path.join(lensesRoot, id);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(folder);
		} catch {
			continue;
		}
		if (!stat.isDirectory()) continue;
		let files: string[];
		try {
			files = readdirSync(folder);
		} catch {
			continue;
		}
		for (const file of files) {
			if (file === LENS_MANIFEST_FILE) continue;
			const filePath = path.join(folder, file);
			let s: ReturnType<typeof statSync>;
			try {
				s = statSync(filePath);
			} catch {
				continue;
			}
			if (!s.isFile()) continue;
			if (!best || s.mtimeMs > best.mtimeMs) {
				best = { lensId: id, mtimeMs: s.mtimeMs };
			}
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Newspaper scaffolding
//
// Used by /genesis (when seedLensViews is on) to create a starter newspaper
// lens for the new mind. The lens is a minimal page with a placeholder
// priority — enough for the operator to see the lens in the sidebar
// immediately. The mind populates the rest later when asked.
// ---------------------------------------------------------------------------

export interface ScaffoldNewspaperResult {
	mindSlug: string;
	lensSlug: string;
	created: boolean;
	reason?: string;
	manifestPath: string;
	dataPath: string;
}

export function newspaperLensSlug(mindSlug: string): string {
	return `${mindSlug}-newspaper`;
}

export function newspaperLensName(mindSlug: string): string {
	return `${titleCase(mindSlug)} Newspaper`;
}

export function newspaperManifest(mindSlug: string): {
	name: string;
	kind: LensKind;
	source: string;
	icon: string;
	description: string;
} {
	return {
		name: newspaperLensName(mindSlug),
		kind: "briefing",
		source: "data.json",
		icon: "newspaper",
		description: `Daily briefing authored by ${mindSlug}.`,
	};
}

export function newspaperData(mindSlug: string): unknown {
	return {
		summary: `Awaiting first refresh from ${mindSlug}.`,
		status: "ready",
		priority: {
			title: "Awaiting Content",
			body: `Ask ${mindSlug} to populate this newspaper. The mind reads its IDEA notes and updates priority, metrics, activity, and narrative sections.`,
			severity: "info",
		},
		activity: ["Newspaper scaffolded by /genesis"],
	};
}

// Scaffold a newspaper lens for one mind. Idempotent: if either lens.json or
// the data file already exists at the target path, returns `created: false`
// without touching the existing files.
export function scaffoldNewspaper(
	lensesRoot: string,
	mindSlug: string,
): ScaffoldNewspaperResult {
	const lensSlug = newspaperLensSlug(mindSlug);
	const idCheck = validateLensId(lensSlug);
	if (!idCheck.ok) {
		throw new Error(
			`cannot scaffold newspaper for "${mindSlug}": ${idCheck.reason}`,
		);
	}
	const lensFolder = path.resolve(lensesRoot, lensSlug);
	assertInsideProject(lensesRoot, lensFolder, "newspaperLensFolder");
	const manifestPath = path.join(lensFolder, LENS_MANIFEST_FILE);
	const dataPath = path.join(lensFolder, "data.json");

	if (existsSync(manifestPath) || existsSync(dataPath)) {
		return {
			mindSlug,
			lensSlug,
			created: false,
			reason: "newspaper lens already exists",
			manifestPath,
			dataPath,
		};
	}

	mkdirSync(lensFolder, { recursive: true });
	writeFileSync(
		manifestPath,
		`${JSON.stringify(newspaperManifest(mindSlug), null, 2)}\n`,
		"utf-8",
	);
	writeFileSync(
		dataPath,
		`${JSON.stringify(newspaperData(mindSlug), null, 2)}\n`,
		"utf-8",
	);
	return {
		mindSlug,
		lensSlug,
		created: true,
		manifestPath,
		dataPath,
	};
}

function titleCase(slug: string): string {
	return slug
		.split("-")
		.map((word) =>
			word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word,
		)
		.join(" ");
}

// ---------------------------------------------------------------------------
// Team status-board scaffolding
//
// Used by /assembly to scaffold a status-board lens that summarizes
// the assembled team. Sibling to scaffoldNewspaper; same idempotency contract:
// if either lens.json or the data file already exists, returns
// `created: false` without overwriting.
// ---------------------------------------------------------------------------

export interface ScaffoldTeamLensResult {
	teamSlug: string;
	lensSlug: string;
	created: boolean;
	reason?: string;
	manifestPath: string;
	dataPath: string;
}

export function teamLensSlug(teamSlug: string): string {
	return `${teamSlug}-team`;
}

export function teamLensName(teamSlug: string): string {
	return `${titleCase(teamSlug)} Team`;
}

export function teamLensManifest(teamSlug: string): {
	name: string;
	kind: LensKind;
	source: string;
	icon: string;
	description: string;
} {
	return {
		name: teamLensName(teamSlug),
		kind: "status-board",
		source: "data.json",
		icon: "users",
		description: `Team roster authored by /assembly for ${teamSlug}.`,
	};
}

export function teamLensData(
	members: ReadonlyArray<{ slug: string; role: string }>,
): unknown {
	return members.map((m) => ({
		name: m.slug,
		status: "ready",
		role: m.role,
	}));
}

export function scaffoldTeamStatusBoard(
	lensesRoot: string,
	teamSlug: string,
	members: ReadonlyArray<{ slug: string; role: string }>,
): ScaffoldTeamLensResult {
	const lensSlug = teamLensSlug(teamSlug);
	const idCheck = validateLensId(lensSlug);
	if (!idCheck.ok) {
		throw new Error(
			`cannot scaffold team status board for "${teamSlug}": ${idCheck.reason}`,
		);
	}
	const lensFolder = path.resolve(lensesRoot, lensSlug);
	assertInsideProject(lensesRoot, lensFolder, "teamLensFolder");
	const manifestPath = path.join(lensFolder, LENS_MANIFEST_FILE);
	const dataPath = path.join(lensFolder, "data.json");

	if (existsSync(manifestPath) || existsSync(dataPath)) {
		return {
			teamSlug,
			lensSlug,
			created: false,
			reason: "team status board lens already exists",
			manifestPath,
			dataPath,
		};
	}

	mkdirSync(lensFolder, { recursive: true });
	writeFileSync(
		manifestPath,
		`${JSON.stringify(teamLensManifest(teamSlug), null, 2)}\n`,
		"utf-8",
	);
	writeFileSync(
		dataPath,
		`${JSON.stringify(teamLensData(members), null, 2)}\n`,
		"utf-8",
	);
	return {
		teamSlug,
		lensSlug,
		created: true,
		manifestPath,
		dataPath,
	};
}

// ---------------------------------------------------------------------------
// Lens removal — inverses for /assembly adjourn
//
// Both helpers are idempotent (no-op if the lens folder does not exist) and
// validate the slug + path containment to match the scaffolding contracts.
// ---------------------------------------------------------------------------

export interface RemoveLensResult {
	lensSlug: string;
	removed: boolean;
	folder: string;
}

export function removeNewspaperLens(
	lensesRoot: string,
	mindSlug: string,
): RemoveLensResult {
	const lensSlug = newspaperLensSlug(mindSlug);
	const idCheck = validateLensId(lensSlug);
	if (!idCheck.ok) {
		throw new Error(
			`cannot remove newspaper lens for "${mindSlug}": ${idCheck.reason}`,
		);
	}
	const folder = path.resolve(lensesRoot, lensSlug);
	assertInsideProject(lensesRoot, folder, "newspaperLensFolder");
	if (!existsSync(folder)) {
		return { lensSlug, removed: false, folder };
	}
	rmSync(folder, { recursive: true, force: true });
	return { lensSlug, removed: true, folder };
}

export function removeTeamStatusBoard(
	lensesRoot: string,
	teamSlug: string,
): RemoveLensResult {
	const lensSlug = teamLensSlug(teamSlug);
	const idCheck = validateLensId(lensSlug);
	if (!idCheck.ok) {
		throw new Error(
			`cannot remove team status board for "${teamSlug}": ${idCheck.reason}`,
		);
	}
	const folder = path.resolve(lensesRoot, lensSlug);
	assertInsideProject(lensesRoot, folder, "teamLensFolder");
	if (!existsSync(folder)) {
		return { lensSlug, removed: false, folder };
	}
	rmSync(folder, { recursive: true, force: true });
	return { lensSlug, removed: true, folder };
}
