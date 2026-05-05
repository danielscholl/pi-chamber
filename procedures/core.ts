/**
 * Workflow discovery + run-lifecycle helpers — the surface used by the
 * slash-command layer (procedures/index.ts) to translate user input into store
 * + executor calls.
 *
 * Stays pure(-ish): only filesystem and arg-parsing logic, no Pi runtime
 * coupling. Side effects happen via `procedures/store.ts`.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import {
	discoverWorkflows,
	type DiscoveryResult,
	type DiscoveryRoot,
} from "./loader.ts";
import type { WorkflowSource, WorkflowWithSource } from "./schema/index.ts";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * The set of canonical paths used by the procedures feature, all resolved
 * relative to `cwd` (the project root) and `os.homedir()`.
 */
export interface ProceduresPaths {
	/** `<cwd>/.pi/procedures/` — root for project-local procedures + runs. */
	readonly rootDir: string;
	/** `<rootDir>/runs/` — per-run state directories live here. */
	readonly runsDir: string;
	/**
	 * Discovery roots in *precedence order* (later overrides earlier on name
	 * collisions). Bundled defaults < global < project < .archon/workflows.
	 */
	readonly discoveryRoots: readonly DiscoveryRoot[];
	/** `<cwd>/.pi/commands/` and `<cwd>/.archon/commands/` — looked up for `command:` node resolution. */
	readonly commandRoots: readonly string[];
}

export interface ResolvePathsOptions {
	cwd: string;
	/** Optional override for the bundled defaults dir. Used by tests. */
	bundledDir?: string;
	/** Optional override for the user's home dir. Used by tests. */
	homeDir?: string;
}

export function resolveProceduresPaths(opts: ResolvePathsOptions): ProceduresPaths {
	const home = opts.homeDir ?? os.homedir();
	const bundled =
		opts.bundledDir ?? path.join(import.meta.dir, "defaults");
	const rootDir = path.join(opts.cwd, ".pi", "procedures");
	const runsDir = path.join(rootDir, "runs");

	const discoveryRoots: DiscoveryRoot[] = [
		{ dir: bundled, source: "bundled" },
		{ dir: path.join(home, ".pi", "procedures"), source: "global" },
		{ dir: rootDir, source: "project" },
		{ dir: path.join(opts.cwd, ".archon", "workflows"), source: "project" },
	];

	const commandRoots = [
		path.join(opts.cwd, ".pi", "commands"),
		path.join(opts.cwd, ".archon", "commands"),
	];

	return { rootDir, runsDir, discoveryRoots, commandRoots };
}

// ---------------------------------------------------------------------------
// Workflow discovery
// ---------------------------------------------------------------------------

/**
 * Discover all procedures from the canonical roots, returning the de-duplicated
 * set with their source labels and any non-fatal warnings.
 */
export function discoverProcedures(paths: ProceduresPaths): DiscoveryResult {
	return discoverWorkflows(paths.discoveryRoots);
}

/** Find a single workflow by exact name across discovered roots. */
export function findWorkflow(
	discovery: DiscoveryResult,
	name: string,
): WorkflowWithSource | undefined {
	return discovery.workflows.find((w) => w.workflow.name === name);
}

/**
 * Group discovered workflows by their source for picker rendering. Order
 * matches the tier the user expects to see first (project on top).
 */
export function groupBySource(
	discovery: DiscoveryResult,
): Record<WorkflowSource, WorkflowWithSource[]> {
	const groups: Record<WorkflowSource, WorkflowWithSource[]> = {
		project: [],
		global: [],
		bundled: [],
	};
	for (const w of discovery.workflows) {
		groups[w.source].push(w);
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Argument parsing for /procedures subcommands
// ---------------------------------------------------------------------------

export type ParsedArgs =
	| { mode: "picker" }
	| { mode: "list" }
	| { mode: "show"; name: string }
	| { mode: "status"; runId?: string }
	| { mode: "halt"; runId?: string }
	| { mode: "run"; name: string; runArgs: string[]; strict: boolean }
	| { mode: "error"; message: string };

/**
 * Parse the raw argument string supplied to the `/procedures` slash command.
 *
 * Recognized forms:
 *   (empty)                → picker
 *   list                   → list
 *   show <name>            → show
 *   status [<run-id>]      → status
 *   halt [<run-id>]        → halt
 *   run <name> [args...]   → run (use `--strict` to fail on ignored fields)
 *
 * Unrecognized first tokens become an error result so the caller can render a
 * usage message.
 */
export function parseArgs(raw: string | undefined): ParsedArgs {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return { mode: "picker" };

	const tokens = tokenize(trimmed);
	const head = tokens[0];

	switch (head) {
		case "list":
			return { mode: "list" };
		case "show": {
			const name = tokens[1];
			if (!name) return { mode: "error", message: "Usage: /procedures show <name>" };
			return { mode: "show", name };
		}
		case "status":
			return { mode: "status", runId: tokens[1] };
		case "halt":
			return { mode: "halt", runId: tokens[1] };
		case "run": {
			const name = tokens[1];
			if (!name) return { mode: "error", message: "Usage: /procedures run <name> [args...]" };
			let strict = false;
			const runArgs: string[] = [];
			for (const tok of tokens.slice(2)) {
				if (tok === "--strict") strict = true;
				else runArgs.push(tok);
			}
			return { mode: "run", name, runArgs, strict };
		}
		default:
			return {
				mode: "error",
				message: `Unknown subcommand '${head}'. Try: /procedures, /procedures list, /procedures run <name>, /procedures show <name>, /procedures status, /procedures halt`,
			};
	}
}

/**
 * Split a command-line-ish input string into tokens, respecting double-quoted
 * runs. No backslash escaping (mirrors how Pi slash-command args usually
 * arrive — simple words with optional quoted phrases).
 */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(c)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += c;
	}
	if (current) tokens.push(current);
	return tokens;
}

// ---------------------------------------------------------------------------
// Command-file resolution (for `command:` nodes)
// ---------------------------------------------------------------------------

/**
 * Resolve a command name to a markdown file under one of the configured
 * command roots. Returns the first match in root order (`<cwd>/.pi/commands/`
 * before `<cwd>/.archon/commands/`).
 *
 * Returns `null` if no command file is found. Caller decides whether to fail
 * the node or skip it.
 */
export function resolveCommandFile(
	commandRoots: readonly string[],
	commandName: string,
): string | null {
	for (const root of commandRoots) {
		for (const ext of [".md", ".prompt.md"]) {
			const candidate = path.join(root, `${commandName}${ext}`);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return null;
}
