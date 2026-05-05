/**
 * /procedures — the Pi extension entry for the procedures feature.
 *
 * Subcommands:
 *   /procedures                          → list + run hint (Phase 1: text)
 *   /procedures list                     → all discovered workflows
 *   /procedures show <name>              → render the workflow DAG as text
 *   /procedures status [run-id]          → recent runs (or one run's events)
 *   /procedures run <name> [args] [--strict]
 *                                        → execute a workflow
 *   /procedures halt [run-id]            → not implemented in Phase 1; informs the user
 *
 * Compatibility tiers (core / adapted / ignored) are documented in the
 * project README. The loader emits warnings for fields in the "ignored" tier;
 * `--strict` hard-fails the run when any are present.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	discoverProcedures,
	findWorkflow,
	parseArgs,
	resolveProceduresPaths,
} from "./core.ts";
import { executeWorkflow } from "./executor.ts";
import { type WorkflowLoadWarning } from "./loader.ts";
import {
	formatRunCancelled,
	formatRunComplete,
	formatRunFailed,
	formatRunStatus,
	formatStrictRefusal,
	formatUnknownProcedure,
	formatWarnings,
	formatWorkflowList,
} from "./prompts.ts";
import { createRun, listRuns, readEvents, resolveRunPaths } from "./store.ts";
import {
	emitNodeNotice,
	renderWorkflowDag,
	startProcedurePanel,
} from "./ui.ts";

// ---------------------------------------------------------------------------
// Command context contract — mirrors AssembleCommandContext
// ---------------------------------------------------------------------------

export interface ProceduresCommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, value: string): void;
		setWidget?(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	};
}

// ---------------------------------------------------------------------------
// Pi extension default export
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("procedures", {
		description:
			"Run an Archon-compatible workflow procedure. Subcommands: list, run <name>, show <name>, status, halt.",
		handler: async (args, ctx) => {
			const cmdCtx = ctx as unknown as ProceduresCommandContext;
			await runProceduresCommand(args ?? "", cmdCtx);
		},
	});
}

// ---------------------------------------------------------------------------
// Subcommand router (exported for tests)
// ---------------------------------------------------------------------------

export async function runProceduresCommand(
	rawArgs: string,
	ctx: ProceduresCommandContext,
): Promise<void> {
	const parsed = parseArgs(rawArgs);
	const paths = resolveProceduresPaths({ cwd: ctx.cwd });

	switch (parsed.mode) {
		case "picker":
		case "list":
			return runListCommand(ctx, paths);
		case "show":
			return runShowCommand(ctx, paths, parsed.name);
		case "status":
			return runStatusCommand(ctx, paths, parsed.runId);
		case "halt":
			ctx.ui.notify(
				"/procedures halt is not implemented in Phase 1. Use Ctrl-C to abort the in-flight run; future phases will support clean halt + resume.",
				"warning",
			);
			return;
		case "run":
			return runRunCommand(ctx, paths, parsed.name, parsed.runArgs, parsed.strict);
		case "error":
			ctx.ui.notify(parsed.message, "error");
			return;
	}
}

// ---------------------------------------------------------------------------
// Per-mode handlers
// ---------------------------------------------------------------------------

function runListCommand(
	ctx: ProceduresCommandContext,
	paths: ReturnType<typeof resolveProceduresPaths>,
): void {
	const discovery = discoverProcedures(paths);
	ctx.ui.notify(formatWorkflowList(discovery.workflows), "info");
	for (const err of discovery.errors) {
		ctx.ui.notify(`load error: ${err.filename}: ${err.error}`, "warning");
	}
}

function runShowCommand(
	ctx: ProceduresCommandContext,
	paths: ReturnType<typeof resolveProceduresPaths>,
	name: string,
): void {
	const discovery = discoverProcedures(paths);
	const found = findWorkflow(discovery, name);
	if (!found) {
		ctx.ui.notify(formatUnknownProcedure(name), "error");
		return;
	}
	ctx.ui.notify(renderWorkflowDag(found.workflow), "info");
}

function runStatusCommand(
	ctx: ProceduresCommandContext,
	paths: ReturnType<typeof resolveProceduresPaths>,
	runId: string | undefined,
): void {
	if (runId) {
		const runPaths = resolveRunPaths(paths.runsDir, runId);
		const events = readEvents(runPaths.eventsLogPath);
		if (events.length === 0) {
			ctx.ui.notify(`No events recorded for run ${runId}.`, "warning");
			return;
		}
		const lines = [`Events for ${runId}:`];
		for (const e of events) {
			const node = e.nodeId ? ` [${e.nodeId}]` : "";
			lines.push(`  ${e.timestamp}  ${e.type}${node}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}
	const summaries = listRuns(paths.runsDir);
	ctx.ui.notify(formatRunStatus(summaries), "info");
}

async function runRunCommand(
	ctx: ProceduresCommandContext,
	paths: ReturnType<typeof resolveProceduresPaths>,
	name: string,
	workflowArgs: string[],
	strict: boolean,
): Promise<void> {
	const discovery = discoverProcedures(paths);
	const found = findWorkflow(discovery, name);
	if (!found) {
		ctx.ui.notify(formatUnknownProcedure(name), "error");
		return;
	}

	// Surface loader warnings for THIS workflow.
	const warningsForThis: WorkflowLoadWarning[] = discovery.warnings.filter(
		(w) => w.filename === found.path,
	);
	if (warningsForThis.length > 0) {
		ctx.ui.notify(formatWarnings(warningsForThis), "warning");
		if (strict) {
			ctx.ui.notify(formatStrictRefusal(warningsForThis), "error");
			return;
		}
	}

	const { paths: runPaths, run } = createRun({
		runsDir: paths.runsDir,
		workflow_name: found.workflow.name,
		user_message: workflowArgs.join(" "),
	});
	ctx.ui.notify(`Started procedure run ${run.id} (${found.workflow.name}).`, "info");

	const stopPanel = startProcedurePanel(ctx, found.workflow, run.id);
	const controller = new AbortController();
	try {
		const result = await executeWorkflow({
			workflow: found.workflow,
			runId: run.id,
			paths: runPaths,
			cwd: ctx.cwd,
			workflowArgs,
			signal: controller.signal,
			commandRoots: paths.commandRoots,
			onDelta: undefined,
		});

		// Per-node summary lines after run completes (so the user sees the shape).
		for (const [nodeId, output] of result.nodeOutputs.entries()) {
			const detail = output.state === "failed" ? truncate(output.error ?? "", 200) : undefined;
			emitNodeNotice(
				ctx,
				output.state === "completed"
					? "completed"
					: output.state === "failed"
						? "failed"
						: "skipped",
				nodeId,
				detail,
			);
		}

		switch (result.finalStatus) {
			case "completed":
				ctx.ui.notify(formatRunComplete(result.runId, result.durationMs), "info");
				break;
			case "cancelled":
				ctx.ui.notify(
					formatRunCancelled(result.runId, result.cancelReason ?? "unknown reason"),
					"warning",
				);
				break;
			case "failed": {
				const summary = result.failedNodes.join(", ") || "see node outputs";
				ctx.ui.notify(formatRunFailed(result.runId, summary), "error");
				break;
			}
			default:
				ctx.ui.notify(`Procedure run ended with status ${result.finalStatus}.`, "info");
		}
	} finally {
		stopPanel();
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
