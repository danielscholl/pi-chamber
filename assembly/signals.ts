// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import {
	assertInsideProject,
	type GenesisConfig,
	loadGenesisConfig,
	resolveGenesisPaths,
} from "../genesis/core.ts";
import { listGenesisMinds } from "../mind/core.ts";

export const DEFAULT_PER_FILE_BYTES = 4096;

export type ManifestKind =
	| "package.json"
	| "pyproject.toml"
	| "go.mod"
	| "Cargo.toml"
	| "pom.xml"
	| "build.gradle.kts"
	| "build.gradle"
	| "Gemfile"
	| "composer.json";

const MANIFEST_PRIORITY: ManifestKind[] = [
	"package.json",
	"pyproject.toml",
	"go.mod",
	"Cargo.toml",
	"pom.xml",
	"build.gradle.kts",
	"build.gradle",
	"Gemfile",
	"composer.json",
];

export interface FileSignal {
	path: string;
	content: string;
	truncated: boolean;
}

export interface ManifestSignal extends FileSignal {
	kind: ManifestKind;
}

export interface ExistingMind {
	slug: string;
	soulFirstLine?: string;
}

export interface RepoSignals {
	description?: string;
	readme?: FileSignal;
	agentsMd?: FileSignal;
	claudeMd?: FileSignal;
	manifest?: ManifestSignal;
	topLevelDirs: string[];
	existingMinds: ExistingMind[];
}

export interface CollectSignalsOptions {
	description?: string;
	perFileBytes?: number;
}

// Collect bounded, read-only repo signals for the assemble proposer.
//
// Scope is intentionally narrow: README.md, AGENTS.md, CLAUDE.md, the first
// detected manifest, depth-1 directory listing, and the slugs of existing
// Genesis minds. No recursion, no .env reads, every file capped at
// perFileBytes (default 4 KB). Failures (missing files, perm errors) are
// swallowed so the caller can rely on a best-effort snapshot rather than
// guarding every read.
export function collectRepoSignals(
	cwd: string,
	opts: CollectSignalsOptions = {},
): RepoSignals {
	const root = path.resolve(cwd);
	const perFileBytes = opts.perFileBytes ?? DEFAULT_PER_FILE_BYTES;
	const description = opts.description?.trim() || undefined;

	const readme = readBoundedFileSignal(root, "README.md", perFileBytes);
	const agentsMd = readBoundedFileSignal(root, "AGENTS.md", perFileBytes);
	const claudeMd = readBoundedFileSignal(root, "CLAUDE.md", perFileBytes);
	const manifest = readManifestSignal(root, perFileBytes);
	const topLevelDirs = listTopLevelDirs(root);
	const existingMinds = listExistingMinds(root);

	const signals: RepoSignals = {
		topLevelDirs,
		existingMinds,
	};
	if (description) signals.description = description;
	if (readme) signals.readme = readme;
	if (agentsMd) signals.agentsMd = agentsMd;
	if (claudeMd) signals.claudeMd = claudeMd;
	if (manifest) signals.manifest = manifest;
	return signals;
}

function readBoundedFileSignal(
	root: string,
	relPath: string,
	perFileBytes: number,
): FileSignal | undefined {
	const target = path.join(root, relPath);
	try {
		assertInsideProject(root, target, relPath);
	} catch {
		return undefined;
	}
	if (!existsSync(target)) return undefined;
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(target);
	} catch {
		return undefined;
	}
	if (!stat.isFile()) return undefined;
	let raw: string;
	try {
		raw = readFileSync(target, "utf-8");
	} catch {
		return undefined;
	}
	return truncateContent(relPath, raw, perFileBytes);
}

function readManifestSignal(
	root: string,
	perFileBytes: number,
): ManifestSignal | undefined {
	for (const kind of MANIFEST_PRIORITY) {
		const signal = readBoundedFileSignal(root, kind, perFileBytes);
		if (signal) {
			return { ...signal, kind };
		}
	}
	return undefined;
}

// Truncate UTF-8 content to a byte cap. Trailing partial multi-byte sequences
// decode as U+FFFD; we strip them so the prompt block stays clean.
function truncateContent(
	relPath: string,
	raw: string,
	perFileBytes: number,
): FileSignal {
	if (perFileBytes <= 0) {
		return { path: relPath, content: "", truncated: raw.length > 0 };
	}
	const buffer = Buffer.from(raw, "utf-8");
	if (buffer.length <= perFileBytes) {
		return { path: relPath, content: raw, truncated: false };
	}
	const sliced = buffer.subarray(0, perFileBytes).toString("utf-8");
	const cleaned = sliced.replace(/�+$/, "");
	return { path: relPath, content: cleaned, truncated: true };
}

function listTopLevelDirs(root: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const full = path.join(root, entry);
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) dirs.push(entry);
	}
	return dirs.sort();
}

function listExistingMinds(root: string): ExistingMind[] {
	let config: GenesisConfig;
	let slugs: string[];
	try {
		config = loadGenesisConfig(root);
		slugs = listGenesisMinds(root, config);
	} catch {
		return [];
	}
	const out: ExistingMind[] = [];
	for (const slug of slugs) {
		const soulFirstLine = readSoulFirstLine(root, slug, config);
		out.push(soulFirstLine ? { slug, soulFirstLine } : { slug });
	}
	return out;
}

function readSoulFirstLine(
	root: string,
	slug: string,
	config: GenesisConfig,
): string | undefined {
	let soulPath: string;
	try {
		soulPath = resolveGenesisPaths(root, slug, config).soulPath;
	} catch {
		return undefined;
	}
	if (!existsSync(soulPath)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(soulPath, "utf-8");
	} catch {
		return undefined;
	}
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
		}
	}
	return undefined;
}
