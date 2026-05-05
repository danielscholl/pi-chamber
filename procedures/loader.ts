/**
 * Workflow loader — discovers and parses workflow YAML files.
 *
 * Adapted from Archon `packages/workflows/src/loader.ts`. Differences:
 *
 * 1. No logger (pi-chamber stays quiet by default). Warnings are returned as
 *    data on `WorkflowLoadResult.warnings` so the slash-command surface can
 *    render them.
 * 2. Provider validation is reduced to a single check — only `claude` (or
 *    omitted) is accepted in pi-chamber Phase 1. Codex/community providers
 *    error at load. This is documented in procedures README.
 * 3. Adds a `WorkflowLoadWarning` channel for the "Adapted" / "Ignored"
 *    compatibility tiers (e.g. `hooks`, `agents`, `sandbox`, `script`).
 * 4. Discovery walks the three pi-chamber roots: bundled defaults, global
 *    `~/.pi/procedures/`, project `<repo>/.pi/procedures/`, and (for
 *    zero-config Archon reuse) `<repo>/.archon/workflows/`.
 *
 * Behavior we keep identical:
 * - YAML parse via `Bun.YAML.parse`
 * - Mutual exclusivity, command-name validation, retry/loop rules → from
 *   vendored `dagNodeSchema.safeParse`
 * - DAG shape validation (duplicate ids, unknown deps, cycles) → from
 *   `validateDagShape` in `./graph.ts`
 * - Cross-node `$nodeId.output` reference validation
 * - Reject legacy `steps:` workflows
 * - Warn-and-ignore for invalid `modelReasoningEffort`, `webSearchMode`,
 *   `interactive`, `worktree`, `mutates_checkout`, `tags`,
 *   `additionalDirectories`
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";

import { z } from "zod";
import {
	BASH_NODE_AI_FIELDS,
	dagNodeSchema,
	isApprovalNode,
	isBashNode,
	isCancelNode,
	isLoopNode,
	isScriptNode,
	LOOP_NODE_AI_FIELDS,
	modelReasoningEffortSchema,
	SCRIPT_NODE_AI_FIELDS,
	webSearchModeSchema,
	type DagNode,
	type WorkflowDefinition,
	type WorkflowLoadError,
	type WorkflowLoadResult,
	type WorkflowSource,
	type WorkflowWithSource,
} from "./schema/index.ts";
import { validateDagShape } from "./graph.ts";

/**
 * Non-fatal warning from the loader. Distinct from `WorkflowLoadError` (which
 * causes the workflow to be dropped). Warnings are surfaced by the slash
 * command on first run of a workflow, then suppressed.
 */
export interface WorkflowLoadWarning {
	readonly filename: string;
	readonly nodeId?: string;
	readonly kind:
		| "ai_fields_on_non_ai_node"
		| "ignored_capability"
		| "invalid_field_value"
		| "interactive_loop_in_non_interactive_workflow";
	readonly message: string;
}

/**
 * Per-node fields that pi-chamber's Phase 1 runtime does NOT honor at all
 * (warned on every node where they appear). The schema accepts them for
 * cross-runtime portability.
 *
 * Worktree integration, hooks, sandbox, MCP, inline agents, betas, fallback
 * model, max-budget, and script nodes are tracked for Phase 2/3.
 */
const PI_IGNORED_FIELDS_PER_NODE: readonly string[] = [
	"hooks",
	"agents",
	"sandbox",
	"betas",
	"fallbackModel",
	"maxBudgetUsd",
	"mcp",
	"skills",
];

const PI_IGNORED_FIELDS_WORKFLOW: readonly string[] = [
	"sandbox",
	"betas",
	"fallbackModel",
	"additionalDirectories",
	"mutates_checkout",
];

// ---------------------------------------------------------------------------
// YAML parse + raw shape utilities
// ---------------------------------------------------------------------------

declare const Bun: {
	YAML: { parse: (content: string) => unknown };
};

function parseYaml(content: string): unknown {
	return Bun.YAML.parse(content);
}

function formatNodeIssue(id: string, issue: z.ZodIssue): string {
	const pathStr = issue.path.length > 0 ? `'${issue.path.join(".")}' ` : "";
	return `Node '${id}': ${pathStr}${issue.message}`;
}

// ---------------------------------------------------------------------------
// Per-node parsing
// ---------------------------------------------------------------------------

interface ParseNodeContext {
	filename: string;
	errors: string[];
	warnings: WorkflowLoadWarning[];
}

function parseDagNode(raw: unknown, index: number, ctx: ParseNodeContext): DagNode | null {
	const rawId =
		raw !== null && typeof raw === "object" && "id" in raw
			? String((raw as Record<string, unknown>).id)
			: "";
	const id = rawId.trim() || `#${String(index + 1)}`;

	const result = dagNodeSchema.safeParse(raw);
	if (!result.success) {
		for (const issue of result.error.issues) {
			ctx.errors.push(formatNodeIssue(id, issue));
		}
		return null;
	}

	const node = result.data;
	const rawObj = (raw as Record<string, unknown>) ?? {};

	// Warn about AI-specific fields on non-AI nodes (matches Archon's loader).
	let nonAi: { type: string; fields: readonly string[] } | undefined;
	if (isCancelNode(node)) nonAi = { type: "cancel", fields: BASH_NODE_AI_FIELDS };
	else if (isApprovalNode(node)) nonAi = { type: "approval", fields: BASH_NODE_AI_FIELDS };
	else if (isLoopNode(node)) nonAi = { type: "loop", fields: LOOP_NODE_AI_FIELDS };
	else if (isScriptNode(node)) nonAi = { type: "script", fields: SCRIPT_NODE_AI_FIELDS };
	else if ("bash" in node && typeof node.bash === "string") {
		nonAi = { type: "bash", fields: BASH_NODE_AI_FIELDS };
	}
	if (nonAi) {
		const present = nonAi.fields.filter((f) => rawObj[f] !== undefined);
		if (present.length > 0) {
			ctx.warnings.push({
				filename: ctx.filename,
				nodeId: node.id,
				kind: "ai_fields_on_non_ai_node",
				message: `AI-only fields on ${nonAi.type} node are ignored at runtime: ${present.join(", ")}`,
			});
		}
	}

	// Warn about pi-chamber Phase 1 ignored fields, regardless of node type.
	const ignoredPresent = PI_IGNORED_FIELDS_PER_NODE.filter(
		(f) => rawObj[f] !== undefined && (nonAi?.fields.includes(f) ?? false) === false,
	);
	if (ignoredPresent.length > 0) {
		ctx.warnings.push({
			filename: ctx.filename,
			nodeId: node.id,
			kind: "ignored_capability",
			message: `pi-chamber does not honor these node fields in Phase 1 (workflow still runs, fields dropped): ${ignoredPresent.join(", ")}`,
		});
	}

	// Phase 1 doesn't run script nodes — flag at load so the user sees it before run.
	if (isScriptNode(node)) {
		ctx.warnings.push({
			filename: ctx.filename,
			nodeId: node.id,
			kind: "ignored_capability",
			message: `'script' nodes are not implemented in pi-chamber Phase 1; this node will fail at runtime`,
		});
	}

	return node;
}

// ---------------------------------------------------------------------------
// Cross-node $nodeId.output reference validation (mirrors Archon)
// ---------------------------------------------------------------------------

function validateOutputRefs(nodes: readonly DagNode[]): string | null {
	const ids = new Set(nodes.map((n) => n.id));
	const refPattern = /\$([a-zA-Z_][a-zA-Z0-9_-]*)\.output/g;
	const stripMarkdownCode = (s: string): string =>
		s.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");

	for (const node of nodes) {
		const sources: string[] = [];
		if (node.when) sources.push(node.when);
		if ("prompt" in node && typeof node.prompt === "string") {
			sources.push(stripMarkdownCode(node.prompt));
		}
		if (isLoopNode(node)) {
			sources.push(stripMarkdownCode(node.loop.prompt));
		}
		for (const source of sources) {
			let m: RegExpExecArray | null;
			refPattern.lastIndex = 0;
			while ((m = refPattern.exec(source)) !== null) {
				const refId = m[1];
				if (refId !== undefined && !ids.has(refId)) {
					return `Node '${node.id}' references unknown node '$${refId}.output'`;
				}
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Top-level parseWorkflow
// ---------------------------------------------------------------------------

export type ParseResult =
	| { workflow: WorkflowDefinition; warnings: WorkflowLoadWarning[]; error: null }
	| { workflow: null; warnings: WorkflowLoadWarning[]; error: WorkflowLoadError };

export function parseWorkflow(content: string, filename: string): ParseResult {
	const warnings: WorkflowLoadWarning[] = [];
	let raw: unknown;
	try {
		raw = parseYaml(content);
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		const lineMatch = /line (\d+)/i.exec(message);
		const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : "";
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: `YAML parse error${lineInfo}: ${message}`,
				errorType: "parse_error",
			},
		};
	}

	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: "YAML file is empty or does not contain an object",
				errorType: "validation_error",
			},
		};
	}
	const obj = raw as Record<string, unknown>;

	if (!obj.name || typeof obj.name !== "string") {
		return {
			workflow: null,
			warnings,
			error: { filename, error: "Missing required field 'name'", errorType: "validation_error" },
		};
	}
	if (!obj.description || typeof obj.description !== "string") {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: "Missing required field 'description'",
				errorType: "validation_error",
			},
		};
	}

	if (Array.isArray(obj.steps) && obj.steps.length > 0) {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error:
					"`steps:` format has been removed. Workflows now use `nodes:` (DAG) format exclusively.",
				errorType: "validation_error",
			},
		};
	}
	if (!Array.isArray(obj.nodes) || (obj.nodes as unknown[]).length === 0) {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: "Workflow must have a non-empty 'nodes:' array",
				errorType: "validation_error",
			},
		};
	}

	// Per-node parse
	const nodeErrors: string[] = [];
	const ctx: ParseNodeContext = { filename, errors: nodeErrors, warnings };
	const nodes = (obj.nodes as unknown[])
		.map((n, i) => parseDagNode(n, i, ctx))
		.filter((n): n is DagNode => n !== null);
	if (nodes.length !== (obj.nodes as unknown[]).length) {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: `DAG node validation failed: ${nodeErrors.join("; ")}`,
				errorType: "validation_error",
			},
		};
	}

	// DAG shape (uses our ported validateDagShape — same coverage as Archon's
	// validateDagStructure for ids/deps/cycles, but returns structured errors).
	const shapeErrors = validateDagShape(nodes);
	if (shapeErrors.length > 0) {
		const messages = shapeErrors
			.map((e) => {
				switch (e.kind) {
					case "duplicate_id":
						return `Duplicate node id: '${e.id}'`;
					case "unknown_dependency":
						return `Node '${e.nodeId}' depends_on unknown node '${e.missing}'`;
					case "self_dependency":
						return `Node '${e.nodeId}' depends on itself`;
					case "cycle":
						return `Cycle detected among nodes: ${e.nodeIds.join(", ")}`;
				}
			})
			.join("; ");
		return {
			workflow: null,
			warnings,
			error: { filename, error: messages, errorType: "validation_error" },
		};
	}

	// Cross-node output ref validation
	const refError = validateOutputRefs(nodes);
	if (refError) {
		return {
			workflow: null,
			warnings,
			error: { filename, error: refError, errorType: "validation_error" },
		};
	}

	// Provider — pi-chamber Phase 1 only honors 'claude' (or omitted).
	const provider =
		typeof obj.provider === "string" && obj.provider.trim().length > 0
			? obj.provider.trim()
			: undefined;
	if (provider !== undefined && provider !== "claude") {
		return {
			workflow: null,
			warnings,
			error: {
				filename,
				error: `Provider '${provider}' is not supported in pi-chamber Phase 1; only 'claude' (or omitting the field) is accepted.`,
				errorType: "validation_error",
			},
		};
	}
	for (const node of nodes) {
		if (node.provider !== undefined && node.provider !== "claude") {
			return {
				workflow: null,
				warnings,
				error: {
					filename,
					error: `Node '${node.id}': provider '${node.provider}' is not supported in pi-chamber Phase 1.`,
					errorType: "validation_error",
				},
			};
		}
	}

	// Warn-and-ignore scalars
	const model = typeof obj.model === "string" ? obj.model : undefined;

	const mreResult = modelReasoningEffortSchema.safeParse(obj.modelReasoningEffort);
	const modelReasoningEffort = mreResult.success ? mreResult.data : undefined;
	if (obj.modelReasoningEffort !== undefined && !mreResult.success) {
		warnings.push({
			filename,
			kind: "invalid_field_value",
			message: `invalid 'modelReasoningEffort' value (ignored); valid: ${modelReasoningEffortSchema.options.join(", ")}`,
		});
	}

	const wsmResult = webSearchModeSchema.safeParse(obj.webSearchMode);
	const webSearchMode = wsmResult.success ? wsmResult.data : undefined;
	if (obj.webSearchMode !== undefined && !wsmResult.success) {
		warnings.push({
			filename,
			kind: "invalid_field_value",
			message: `invalid 'webSearchMode' value (ignored); valid: ${webSearchModeSchema.options.join(", ")}`,
		});
	}

	const additionalDirectories = Array.isArray(obj.additionalDirectories)
		? obj.additionalDirectories.filter((d): d is string => typeof d === "string")
		: undefined;

	const interactive = typeof obj.interactive === "boolean" ? obj.interactive : undefined;
	if (obj.interactive !== undefined && typeof obj.interactive !== "boolean") {
		warnings.push({
			filename,
			kind: "invalid_field_value",
			message: `invalid 'interactive' value (ignored); expected boolean`,
		});
	}
	if (!interactive) {
		const hasInteractiveLoop = nodes.some((n) => isLoopNode(n) && n.loop.interactive === true);
		if (hasInteractiveLoop) {
			warnings.push({
				filename,
				kind: "interactive_loop_in_non_interactive_workflow",
				message:
					"workflow has an interactive loop but is not marked top-level interactive — gate messages will not pause for input",
			});
		}
	}

	let worktreePolicy: { enabled?: boolean } | undefined;
	if (
		obj.worktree &&
		typeof obj.worktree === "object" &&
		!Array.isArray(obj.worktree)
	) {
		const enabled = (obj.worktree as Record<string, unknown>).enabled;
		if (typeof enabled === "boolean") worktreePolicy = { enabled };
	}

	let mutatesCheckout: boolean | undefined;
	if (typeof obj.mutates_checkout === "boolean") mutatesCheckout = obj.mutates_checkout;

	let tags: string[] | undefined;
	if (Array.isArray(obj.tags)) {
		tags = [
			...new Set(
				obj.tags
					.filter((t): t is string => typeof t === "string")
					.map((t) => t.trim())
					.filter((t) => t.length > 0),
			),
		];
	}

	// Workflow-level Phase 1 ignored capability warnings
	for (const field of PI_IGNORED_FIELDS_WORKFLOW) {
		if (obj[field] !== undefined) {
			warnings.push({
				filename,
				kind: "ignored_capability",
				message: `pi-chamber does not honor workflow-level '${field}' in Phase 1 (field dropped)`,
			});
		}
	}

	const workflow: WorkflowDefinition = {
		name: obj.name,
		description: obj.description,
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
		...(modelReasoningEffort !== undefined ? { modelReasoningEffort } : {}),
		...(webSearchMode !== undefined ? { webSearchMode } : {}),
		...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
		...(interactive !== undefined ? { interactive } : {}),
		...(mutatesCheckout !== undefined ? { mutates_checkout: mutatesCheckout } : {}),
		nodes,
		...(worktreePolicy ? { worktree: worktreePolicy } : {}),
		...(tags !== undefined ? { tags } : {}),
	};

	return { workflow, warnings, error: null };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface DiscoveryRoot {
	dir: string;
	source: WorkflowSource;
}

/**
 * Discover workflows from a list of roots. Higher-precedence roots later in the
 * list override same-named earlier ones (caller orders: bundled, global,
 * project, .archon/workflows).
 *
 * Surfaces both successful loads and errors so the caller can render both.
 * Warnings are aggregated separately on the returned object.
 */
export interface DiscoveryResult extends WorkflowLoadResult {
	readonly warnings: readonly WorkflowLoadWarning[];
}

export function discoverWorkflows(roots: readonly DiscoveryRoot[]): DiscoveryResult {
	const byName = new Map<string, WorkflowWithSource>();
	const errors: WorkflowLoadError[] = [];
	const warnings: WorkflowLoadWarning[] = [];

	for (const root of roots) {
		let entries: string[];
		try {
			if (!fs.existsSync(root.dir)) continue;
			entries = fs.readdirSync(root.dir);
		} catch (err) {
			errors.push({
				filename: root.dir,
				error: `failed to read discovery root: ${(err as Error).message}`,
				errorType: "read_error",
			});
			continue;
		}
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
			const filePath = path.join(root.dir, entry);
			let content: string;
			try {
				const stat = fs.statSync(filePath);
				if (!stat.isFile()) continue;
				content = fs.readFileSync(filePath, "utf-8");
			} catch (err) {
				errors.push({
					filename: filePath,
					error: `failed to read file: ${(err as Error).message}`,
					errorType: "read_error",
				});
				continue;
			}
			const result = parseWorkflow(content, filePath);
			for (const w of result.warnings) warnings.push(w);
			if (result.error) {
				errors.push(result.error);
				continue;
			}
			const wf = result.workflow;
			byName.set(wf.name, { workflow: wf, source: root.source, path: filePath });
		}
	}

	return {
		workflows: Array.from(byName.values()),
		errors,
		warnings,
	};
}
