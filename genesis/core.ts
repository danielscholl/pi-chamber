// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { fileURLToPath } from "node:url";

// Where the bundled shared doctrine templates live, relative to this module.
// Resolved at load time so seedSharedDoctrine can read them without callers
// having to know about the package layout.
const SHARED_TEMPLATES_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"shared",
);

export const IDEA_FOLDERS = [
	"inbox",
	"domains",
	"expertise",
	"initiatives",
	"Archive",
] as const;
export const SHARED_MIND_DIR = "_shared";
export const SHARED_IDEA_FILE = "IDEA.md";
export const SHARED_OBSERVATORY_FILE = "OBSERVATORY.md";
export const WORKING_MEMORY_DIR = ".working-memory";
export const WORKING_MEMORY_FILES = [
	"memory.md",
	"rules.md",
	"log.md",
] as const;

export interface GenesisConfig {
	basePath: string;
	agentShimPath: string;
	defaultRole: string;
	defaultVoice: string;
	commit: false;
	seedLensViews: boolean;
	bootstrapSkills: false;
}

export interface GenesisArgs {
	name: string;
	role: string;
	voice: string;
}

export interface GenesisPaths {
	cwd: string;
	slug: string;
	basePath: string;
	agentShimPath: string;
	mindPath: string;
	shimPath: string;
	ideaFolders: string[];
	sharedMindPath: string;
	sharedIdeaPath: string;
	sharedObservatoryPath: string;
	workingMemoryPath: string;
	soulPath: string;
	mindIndexPath: string;
	memoryPath: string;
	rulesPath: string;
	logPath: string;
}

export interface PendingGenesisRequest {
	requestId: string;
	createdAt: number;
	cwd: string;
	name: string;
	slug: string;
	role: string;
	voice: string;
	voiceDescription: string;
	normalizedVoiceDescription: string;
	paths: GenesisPaths;
	config: GenesisConfig;
	source?: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: string[];
	missing: string[];
	invalid: string[];
}

export const DEFAULT_GENESIS_CONFIG: GenesisConfig = {
	basePath: "./.pi/minds",
	agentShimPath: "./.pi/agents",
	defaultRole: "OSDU Assistant",
	defaultVoice: "clear, practical, technically sharp",
	commit: false,
	seedLensViews: true,
	bootstrapSkills: false,
};

export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
}

export function parseGenesisArgs(args: string): Partial<GenesisArgs> {
	const tokens = tokenizeArgs(args);
	const parsed: Partial<GenesisArgs> = {};
	const positional: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token.startsWith("--")) {
			const withoutPrefix = token.slice(2);
			const eq = withoutPrefix.indexOf("=");
			const key = eq >= 0 ? withoutPrefix.slice(0, eq) : withoutPrefix;
			if (!isGenesisArgKey(key)) {
				if (eq < 0 && shouldSkipUnknownFlagValue(tokens[i + 1])) i++;
				continue;
			}
			const value = eq >= 0 ? withoutPrefix.slice(eq + 1) : (tokens[++i] ?? "");
			parsed[key] = value;
			continue;
		}

		const eq = token.indexOf("=");
		if (eq > 0) {
			const key = token.slice(0, eq);
			if (isGenesisArgKey(key)) {
				parsed[key] = token.slice(eq + 1);
				continue;
			}
		}

		positional.push(token);
	}

	if (!parsed.name && positional.length > 0) {
		parsed.name = positional.join(" ");
	}

	return parsed;
}

export function normalizeVoiceDescription(voice: string): string {
	const trimmed = voice.trim();
	if (!trimmed) return "";

	const words = trimmed.split(/\s+/).filter(Boolean);
	const isShortPersona =
		words.length <= 4 && trimmed.length <= 50 && !/[.!?]/.test(trimmed);
	if (isShortPersona) {
		return `Character/voice: ${quoteYamlString(trimmed)}`;
	}
	return trimmed;
}

export function loadGenesisConfig(cwd: string): GenesisConfig {
	const config = { ...DEFAULT_GENESIS_CONFIG };
	const settingsPath = path.join(cwd, ".pi", "settings.json");
	if (!existsSync(settingsPath)) {
		return config;
	}

	const raw = readFileSync(settingsPath, "utf-8");
	let settings: { genesis?: Record<string, unknown> };
	try {
		settings = JSON.parse(raw) as { genesis?: Record<string, unknown> };
	} catch (error) {
		throw new Error(
			`Failed to parse .pi/settings.json for Genesis config: ${errorMessage(error)}`,
		);
	}
	const genesis = settings.genesis;
	if (!genesis || typeof genesis !== "object") {
		return config;
	}

	return {
		...config,
		basePath:
			typeof genesis.basePath === "string" ? genesis.basePath : config.basePath,
		agentShimPath:
			typeof genesis.agentShimPath === "string"
				? genesis.agentShimPath
				: config.agentShimPath,
		defaultRole:
			typeof genesis.defaultRole === "string"
				? genesis.defaultRole
				: config.defaultRole,
		defaultVoice:
			typeof genesis.defaultVoice === "string"
				? genesis.defaultVoice
				: config.defaultVoice,
		commit: false,
		seedLensViews: false,
		bootstrapSkills: false,
	};
}

export function resolveGenesisPaths(
	cwd: string,
	slug: string,
	config: GenesisConfig = DEFAULT_GENESIS_CONFIG,
): GenesisPaths {
	const root = path.resolve(cwd);
	const basePath = resolveProjectRelativePath(
		root,
		config.basePath,
		"basePath",
	);
	const agentShimPath = resolveProjectRelativePath(
		root,
		config.agentShimPath,
		"agentShimPath",
	);
	const mindPath = path.join(basePath, slug);
	const sharedMindPath = path.join(basePath, SHARED_MIND_DIR);
	const sharedIdeaPath = path.join(sharedMindPath, SHARED_IDEA_FILE);
	const sharedObservatoryPath = path.join(sharedMindPath, SHARED_OBSERVATORY_FILE);
	const shimPath = path.join(agentShimPath, `${slug}.md`);
	const workingMemoryPath = path.join(mindPath, WORKING_MEMORY_DIR);

	assertInsideProject(root, mindPath, "mindPath");
	assertInsideProject(root, sharedMindPath, "sharedMindPath");
	assertInsideProject(root, sharedIdeaPath, "sharedIdeaPath");
	assertInsideProject(root, sharedObservatoryPath, "sharedObservatoryPath");
	assertInsideProject(root, shimPath, "shimPath");

	return {
		cwd: root,
		slug,
		basePath,
		agentShimPath,
		mindPath,
		shimPath,
		ideaFolders: IDEA_FOLDERS.map((folder) => path.join(mindPath, folder)),
		sharedMindPath,
		sharedIdeaPath,
		sharedObservatoryPath,
		workingMemoryPath,
		soulPath: path.join(mindPath, "SOUL.md"),
		mindIndexPath: path.join(mindPath, "mind-index.md"),
		memoryPath: path.join(workingMemoryPath, "memory.md"),
		rulesPath: path.join(workingMemoryPath, "rules.md"),
		logPath: path.join(workingMemoryPath, "log.md"),
	};
}

export function createMindStructure(paths: GenesisPaths): void {
	mkdirSync(paths.mindPath, { recursive: true });
	for (const folder of paths.ideaFolders) {
		mkdirSync(folder, { recursive: true });
	}
	mkdirSync(paths.workingMemoryPath, { recursive: true });
	mkdirSync(paths.sharedMindPath, { recursive: true });
	mkdirSync(path.dirname(paths.shimPath), { recursive: true });

	for (const placeholderPath of [
		paths.memoryPath,
		paths.rulesPath,
		paths.logPath,
	]) {
		if (!existsSync(placeholderPath)) {
			writeFileSync(placeholderPath, "", "utf-8");
		}
	}
}

// Seed the project's shared mind doctrine (IDEA.md, OBSERVATORY.md) from
// the bundled templates, but only when the target files don't already
// exist. Returns the absolute paths of any files actually written, so the
// caller can surface "seeded N files" feedback. Never overwrites; if the
// operator has customized doctrine already, this is a no-op for that file.
export function seedSharedDoctrine(paths: GenesisPaths): string[] {
	mkdirSync(paths.sharedMindPath, { recursive: true });
	const targets: Array<{ target: string; template: string }> = [
		{
			target: paths.sharedIdeaPath,
			template: path.join(SHARED_TEMPLATES_DIR, SHARED_IDEA_FILE),
		},
		{
			target: paths.sharedObservatoryPath,
			template: path.join(SHARED_TEMPLATES_DIR, SHARED_OBSERVATORY_FILE),
		},
	];
	const seeded: string[] = [];
	for (const { target, template } of targets) {
		if (existsSync(target)) continue;
		if (!existsSync(template)) continue;
		writeFileSync(target, readFileSync(template, "utf-8"), "utf-8");
		seeded.push(target);
	}
	return seeded;
}

export function validateMind(paths: GenesisPaths): ValidationResult {
	const missing: string[] = [];
	const invalid: string[] = [];
	const errors: string[] = [];

	for (const folder of [
		paths.mindPath,
		...paths.ideaFolders,
		paths.workingMemoryPath,
	]) {
		if (!isDirectory(folder)) {
			missing.push(folder);
			errors.push(`Missing directory: ${folder}`);
		}
	}

	for (const file of [
		paths.soulPath,
		paths.mindIndexPath,
		paths.memoryPath,
		paths.rulesPath,
		paths.logPath,
		paths.shimPath,
	]) {
		if (!existsSync(file)) {
			missing.push(file);
			errors.push(`Missing file: ${file}`);
			continue;
		}
		if (!isNonEmptyFile(file)) {
			invalid.push(file);
			errors.push(`Empty file: ${file}`);
		}
	}

	if (existsSync(paths.shimPath) && isNonEmptyFile(paths.shimPath)) {
		const shim = readFileSync(paths.shimPath, "utf-8");
		const frontmatter = parseFrontmatter(shim);
		if (!frontmatter) {
			invalid.push(paths.shimPath);
			errors.push(`Invalid shim frontmatter: ${paths.shimPath}`);
		} else {
			if (!frontmatter.name?.trim()) {
				invalid.push(paths.shimPath);
				errors.push(
					`Shim frontmatter missing non-empty name: ${paths.shimPath}`,
				);
			}
			if (!frontmatter.description?.trim()) {
				invalid.push(paths.shimPath);
				errors.push(
					`Shim frontmatter missing non-empty description: ${paths.shimPath}`,
				);
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
		missing,
		invalid,
	};
}

export function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

export function collapseOneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function quoteYamlString(value: string): string {
	const oneLine = collapseOneLine(value);
	const escaped = oneLine
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "")
		.replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

export function assertInsideProject(
	cwd: string,
	targetPath: string,
	label = "path",
): void {
	const root = path.resolve(cwd);
	const resolved = path.resolve(targetPath);
	const relative = path.relative(root, resolved);
	if (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	) {
		return;
	}
	throw new Error(`${label} escapes project root: ${targetPath}`);
}

export function resolveProjectRelativePath(
	cwd: string,
	configuredPath: string,
	label = "path",
): string {
	if (!configuredPath || typeof configuredPath !== "string") {
		throw new Error(`${label} must be a non-empty relative path`);
	}
	if (path.isAbsolute(configuredPath)) {
		throw new Error(`${label} must be relative to the project root`);
	}
	const resolved = path.resolve(cwd, configuredPath);
	assertInsideProject(cwd, resolved, label);
	return resolved;
}

function tokenizeArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | "" = "";
	let escaping = false;

	for (const char of args) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = "";
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function isGenesisArgKey(key: string): key is keyof GenesisArgs {
	return key === "name" || key === "role" || key === "voice";
}

function shouldSkipUnknownFlagValue(nextToken: string | undefined): boolean {
	return Boolean(
		nextToken && !nextToken.startsWith("--") && !isKeyValueToken(nextToken),
	);
}

function isKeyValueToken(token: string): boolean {
	const eq = token.indexOf("=");
	return eq > 0 && isGenesisArgKey(token.slice(0, eq));
}

function isDirectory(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function isNonEmptyFile(filePath: string): boolean {
	try {
		return (
			statSync(filePath).isFile() &&
			readFileSync(filePath, "utf-8").trim().length > 0
		);
	} catch {
		return false;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseFrontmatter(content: string): Record<string, string> | null {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|\s*$)/);
	if (!match) return null;

	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}
	return fields;
}
