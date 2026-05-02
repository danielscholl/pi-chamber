// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	statSync,
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

export const DEFAULT_OBSERVATORY_HOST = "127.0.0.1";
export const DEFAULT_OBSERVATORY_PORT = 7878;
export const LENS_MANIFEST_FILE = "lens.json";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export interface ObservatoryConfig {
	lensesPath: string;
	port: number;
	host: string;
	openOnStart: boolean;
}

export const DEFAULT_OBSERVATORY_CONFIG: ObservatoryConfig = {
	lensesPath: "./.pi/observatory/lenses",
	port: DEFAULT_OBSERVATORY_PORT,
	host: DEFAULT_OBSERVATORY_HOST,
	openOnStart: false,
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
	if (typeof observatory.port === "number" && Number.isInteger(observatory.port)) {
		if (observatory.port < 0 || observatory.port > 65535) {
			throw new Error(
				`Observatory port must be between 0 and 65535 (got ${observatory.port}).`,
			);
		}
		config.port = observatory.port;
	} else if (observatory.port !== undefined) {
		throw new Error(
			`Observatory port must be an integer (got ${typeof observatory.port}).`,
		);
	}
	if (typeof observatory.host === "string") {
		if (observatory.host !== DEFAULT_OBSERVATORY_HOST) {
			throw new Error(
				`Observatory host must be ${DEFAULT_OBSERVATORY_HOST} (got ${observatory.host}). The framework binds localhost only.`,
			);
		}
		config.host = observatory.host;
	}
	if (typeof observatory.openOnStart === "boolean") {
		config.openOnStart = observatory.openOnStart;
	}

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

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
