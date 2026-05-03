// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import {
	assertInsideProject,
	collapseOneLine,
	type GenesisConfig,
	type GenesisPaths,
	loadGenesisConfig,
	resolveGenesisPaths,
	slugify,
} from "../genesis/core.ts";

export const DEFAULT_LOG_MAX_CHARS = 8000;
export const MIND_CONFIG_FILE = "mind-config.json";

export type MindConfig = {
	tools?: string[];
	model?: string;
	fallbackModels?: string[];
};

export type MindModePaths = {
	mindPath: string;
	sharedIdeaPath: string;
	sharedObservatoryPath: string;
	soulPath: string;
	mindIndexPath: string;
	memoryPath: string;
	rulesPath: string;
	logPath: string;
};

export type MindValidationResult = {
	ok: boolean;
	errors: string[];
	missing: string[];
	invalid: string[];
};

export type MindContext = {
	slug: string;
	paths: MindModePaths;
	sharedIdea: string;
	sharedObservatory: string;
	soul: string;
	mindIndex: string;
	memory: string;
	rules: string;
	log: string;
	logTruncated: boolean;
};

export type LoadedMindContext = MindContext & {
	cwd: string;
};

export type LoadMindContextOptions = {
	config?: GenesisConfig;
	logMaxChars?: number;
};

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LOG_TRUNCATION_MARKER =
	"[... earlier chronological log entries omitted for mind context budget ...]\n";

export function normalizeMindSlug(input: string): string {
	const trimmed = input.trim();
	const slug = SLUG_PATTERN.test(trimmed) ? trimmed : slugify(trimmed);
	if (!slug) {
		throw new Error(
			"Mind slug must contain at least one ASCII letter or number.",
		);
	}
	return slug;
}

export function listGenesisMinds(
	cwd: string,
	config: GenesisConfig = loadGenesisConfig(cwd),
): string[] {
	const basePath = resolveGenesisPaths(cwd, "mind-probe", config).basePath;
	assertInsideProject(cwd, basePath, "basePath");
	if (!existsSync(basePath)) return [];

	return readdirSync(basePath)
		.filter((entry) => {
			const mindPath = path.join(basePath, entry);
			if (!isDirectory(mindPath)) return false;
			let slug: string;
			try {
				slug = normalizeMindSlug(entry);
			} catch {
				return false;
			}
			if (slug !== entry) return false;
			const paths = resolveGenesisPaths(cwd, slug, config);
			return validateMindModeFiles(paths).ok;
		})
		.sort();
}

export function validateMindModeFiles(
	paths: GenesisPaths,
): MindValidationResult {
	const missing: string[] = [];
	const invalid: string[] = [];
	const errors: string[] = [];

	for (const [label, targetPath] of requiredPathEntries(paths)) {
		assertInsideProject(paths.cwd, targetPath, label);
		if (!existsSync(targetPath)) {
			missing.push(targetPath);
			errors.push(`Missing file: ${targetPath}`);
			continue;
		}
		if (!isNonEmptyFile(targetPath)) {
			invalid.push(targetPath);
			errors.push(`Empty file: ${targetPath}`);
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		missing,
		invalid,
	};
}

export function loadMindContext(
	cwd: string,
	inputSlug: string,
	options: LoadMindContextOptions = {},
): LoadedMindContext {
	const slug = normalizeMindSlug(inputSlug);
	const config = options.config ?? loadGenesisConfig(cwd);
	const paths = resolveGenesisPaths(cwd, slug, config);
	assertMindModePathsInsideProject(paths);

	const validation = validateMindModeFiles(paths);
	if (!validation.ok) {
		throw new Error(
			`Genesis mind "${slug}" is not ready for /mind:\n${validation.errors.join("\n")}`,
		);
	}

	const logResult = readTailWithMarker(
		paths.logPath,
		options.logMaxChars ?? DEFAULT_LOG_MAX_CHARS,
	);

	return {
		cwd: paths.cwd,
		slug,
		paths: toMindModeDisplayPaths(paths),
		sharedIdea: readOptionalNonEmptyFile(paths.sharedIdeaPath),
		sharedObservatory: readOptionalNonEmptyFile(paths.sharedObservatoryPath),
		soul: readFileSync(paths.soulPath, "utf-8").trim(),
		mindIndex: readFileSync(paths.mindIndexPath, "utf-8").trim(),
		memory: readFileSync(paths.memoryPath, "utf-8").trim(),
		rules: readFileSync(paths.rulesPath, "utf-8").trim(),
		log: logResult.content.trim(),
		logTruncated: logResult.truncated,
	};
}

/**
 * Load optional per-mind config from `.pi/minds/<slug>/mind-config.json`.
 * Returns undefined if the file is missing, malformed JSON, or contains no
 * recognizable fields. Malformed individual fields silently coerce to
 * undefined (matches the project pattern: don't block room activation on
 * misshapen optional config).
 */
export function loadMindConfig(
	cwd: string,
	inputSlug: string,
	options: { config?: GenesisConfig } = {},
): MindConfig | undefined {
	const slug = normalizeMindSlug(inputSlug);
	const config = options.config ?? loadGenesisConfig(cwd);
	const paths = resolveGenesisPaths(cwd, slug, config);
	const configPath = path.join(paths.mindPath, MIND_CONFIG_FILE);
	assertInsideProject(paths.cwd, configPath, "mindConfigPath");
	if (!existsSync(configPath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	const out: MindConfig = {};
	const tools = coerceToolsList(raw.tools);
	if (tools) out.tools = tools;
	const model = coerceNonEmptyString(raw.model);
	if (model) out.model = model;
	const fallbackModels = coerceStringList(raw.fallbackModels);
	if (fallbackModels) out.fallbackModels = fallbackModels;
	return Object.keys(out).length > 0 ? out : undefined;
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_:-]+$/;

function coerceToolsList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || !TOOL_NAME_PATTERN.test(trimmed)) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out.length > 0 ? out : undefined;
}

function coerceNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function coerceStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		const trimmed = coerceNonEmptyString(item);
		if (trimmed) out.push(trimmed);
	}
	return out.length > 0 ? out : undefined;
}

export function buildMindModeSystemPrompt(context: LoadedMindContext): string {
	return `# Active Genesis Mind — ${context.slug}

You are operating in Genesis direct-chat mind mode. The current main Pi session is inhabiting this project-local mind; this is not a delegated subagent task.

## Mind files active in this prompt

- Shared IDEA doctrine: ${context.paths.sharedIdeaPath}${context.sharedIdea ? "" : " (not found or empty)"}
- Shared Observatory doctrine: ${context.paths.sharedObservatoryPath}${context.sharedObservatory ? "" : " (not found or empty)"}
- Identity: ${context.paths.soulPath}
- Mind index: ${context.paths.mindIndexPath}
- Durable memory: ${context.paths.memoryPath}
- Operating rules: ${context.paths.rulesPath}
- Recent chronological log: ${context.paths.logPath}${context.logTruncated ? " (tail only)" : ""}

## Shared IDEA Doctrine

${context.sharedIdea || "No shared IDEA doctrine file was found for this project. Continue using the mind-specific files below."}

## Shared Observatory Doctrine

${context.sharedObservatory || "No shared Observatory doctrine file was found for this project. If the operator asks you to author observatory lenses, ask for the schema before writing."}

## Identity — SOUL.md

${context.soul}

## Mind Index

${context.mindIndex}

## Durable Memory

${context.memory}

## Operating Rules

${context.rules}

## Recent Chronological Log

${context.log}

## Direct-chat operating rules

- Answer as this Genesis mind in the main Pi session; do not describe yourself as a background subagent.
- Keep following the repository AGENTS.md, active safety rules, and all higher-priority instructions.
- Treat the mind files above as durable identity and memory context for this turn.
- Use normal visible tools when needed; tool calls and results should remain in the main conversation.
- Do not bypass the Genesis authoring flow: live /genesis requests still write only through genesis_write_files exactly once.
- Do not write to mind memory automatically. Update working memory only when the user asks or when a durable continuity note is clearly useful, and keep such edits concise.
- If a mind file conflicts with higher-priority project or safety instructions, follow the higher-priority instruction and say so briefly.`;
}

function assertMindModePathsInsideProject(paths: GenesisPaths): void {
	for (const [label, targetPath] of [
		["mindPath", paths.mindPath],
		["sharedIdeaPath", paths.sharedIdeaPath],
		["sharedObservatoryPath", paths.sharedObservatoryPath],
		...requiredPathEntries(paths),
	] as const) {
		assertInsideProject(paths.cwd, targetPath, label);
	}
}

function requiredPathEntries(paths: GenesisPaths): Array<[string, string]> {
	return [
		["soulPath", paths.soulPath],
		["mindIndexPath", paths.mindIndexPath],
		["memoryPath", paths.memoryPath],
		["rulesPath", paths.rulesPath],
		["logPath", paths.logPath],
	];
}

function toMindModeDisplayPaths(paths: GenesisPaths): MindModePaths {
	return {
		mindPath: relativeToCwd(paths.cwd, paths.mindPath),
		sharedIdeaPath: relativeToCwd(paths.cwd, paths.sharedIdeaPath),
		sharedObservatoryPath: relativeToCwd(paths.cwd, paths.sharedObservatoryPath),
		soulPath: relativeToCwd(paths.cwd, paths.soulPath),
		mindIndexPath: relativeToCwd(paths.cwd, paths.mindIndexPath),
		memoryPath: relativeToCwd(paths.cwd, paths.memoryPath),
		rulesPath: relativeToCwd(paths.cwd, paths.rulesPath),
		logPath: relativeToCwd(paths.cwd, paths.logPath),
	};
}

function readOptionalNonEmptyFile(filePath: string): string {
	if (!isNonEmptyFile(filePath)) return "";
	return readFileSync(filePath, "utf-8").trim();
}

function readTailWithMarker(
	filePath: string,
	maxChars: number,
): { content: string; truncated: boolean } {
	const content = readFileSync(filePath, "utf-8");
	if (maxChars <= 0 || content.length <= maxChars) {
		return { content, truncated: false };
	}
	return {
		content: `${LOG_TRUNCATION_MARKER}${content.slice(-maxChars)}`,
		truncated: true,
	};
}

function isDirectory(targetPath: string): boolean {
	try {
		return statSync(targetPath).isDirectory();
	} catch {
		return false;
	}
}

function isNonEmptyFile(filePath: string): boolean {
	try {
		return (
			statSync(filePath).isFile() &&
			collapseOneLine(readFileSync(filePath, "utf-8")).length > 0
		);
	} catch {
		return false;
	}
}

function relativeToCwd(cwd: string, targetPath: string): string {
	const relative = path.relative(cwd, targetPath) || ".";
	return relative.split(path.sep).join("/");
}
