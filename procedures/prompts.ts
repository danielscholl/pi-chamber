/**
 * Canned message strings used by the slash-command surface and the executor.
 * Centralized so wording is consistent and easy to audit / translate.
 */

import type { WorkflowLoadWarning } from "./loader.ts";
import type { RunSummary } from "./store.ts";
import type {
	NodeOutput,
	WorkflowDefinition,
	WorkflowRunStatus,
	WorkflowSource,
	WorkflowWithSource,
} from "./schema/index.ts";

const SOURCE_LABEL: Record<WorkflowSource, string> = {
	bundled: "bundled",
	global: "global",
	project: "project",
};

export function formatWorkflowList(workflows: readonly WorkflowWithSource[]): string {
	if (workflows.length === 0) {
		return (
			"No procedures discovered. Add YAML files under .pi/procedures/ (project), " +
			"~/.pi/procedures/ (global), or .archon/workflows/ (Archon-compatible)."
		);
	}
	const lines = ["Discovered procedures:"];
	for (const w of workflows) {
		lines.push(`  - ${w.workflow.name}  [${SOURCE_LABEL[w.source]}]  ${w.workflow.description.split("\n")[0]}`);
	}
	return lines.join("\n");
}

export const PROCEDURE_OPTION_PREFIX = "▸";

const PROCEDURE_OPTION_DESC_LIMIT = 60;

/**
 * Compact one-liner for a workflow used in `/procedures` interactive picker
 * rows. Mirrors the `▸ slug · meta · detail` shape `/room` uses for saved-room
 * options so the two pickers feel like the same UI.
 */
export function formatProcedureOption(w: WorkflowWithSource): string {
	const firstLine = w.workflow.description.split("\n")[0]?.trim() ?? "";
	const desc =
		firstLine.length > PROCEDURE_OPTION_DESC_LIMIT
			? `${firstLine.slice(0, PROCEDURE_OPTION_DESC_LIMIT - 1)}…`
			: firstLine;
	const tail = desc ? ` · ${desc}` : "";
	return `${PROCEDURE_OPTION_PREFIX} ${w.workflow.name} · ${SOURCE_LABEL[w.source]}${tail}`;
}

/**
 * Map a picker selection back to a workflow name. Returns undefined if the
 * choice doesn't match any known procedure (e.g. a synthetic entry).
 */
export function parseProcedureChoice(
	choice: string,
	workflows: readonly WorkflowWithSource[],
): string | undefined {
	const match = choice.match(/^▸\s+(\S+)\s/);
	if (!match) return undefined;
	const name = match[1];
	return workflows.some((w) => w.workflow.name === name) ? name : undefined;
}

export function formatRunStatus(summaries: readonly RunSummary[]): string {
	if (summaries.length === 0) return "No procedure runs recorded yet.";
	const lines = ["Recent procedure runs:"];
	for (const s of summaries.slice(0, 20)) {
		const completed = s.completed_at ? ` → ${s.completed_at}` : "";
		lines.push(`  ${s.runId}  [${s.status}]  ${s.workflow_name}  (${s.started_at}${completed})`);
	}
	return lines.join("\n");
}

export function formatWarnings(warnings: readonly WorkflowLoadWarning[]): string {
	if (warnings.length === 0) return "";
	const lines = ["Loader warnings (workflow still runs):"];
	for (const w of warnings) {
		const where = w.nodeId ? `[${w.nodeId}] ` : "";
		lines.push(`  - ${w.filename} ${where}${w.message}`);
	}
	return lines.join("\n");
}

export function formatStrictRefusal(warnings: readonly WorkflowLoadWarning[]): string {
	const summary = formatWarnings(warnings);
	return (
		`/procedures run --strict refused: workflow uses fields pi-chamber doesn't honor in Phase 1.\n` +
		`${summary}\n` +
		`Drop --strict to run with the listed fields ignored, or remove them from the workflow.`
	);
}

export function formatUnknownProcedure(name: string): string {
	return (
		`No procedure named '${name}'. Run '/procedures list' to see available procedures, ` +
		`or place the YAML file under .pi/procedures/<name>.yaml.`
	);
}

export function formatHaltConfirmation(runId: string): string {
	return `Halt requested for run ${runId}.`;
}

// ---------------------------------------------------------------------------
// Receipt — the multi-line summary widget shown after a /procedures run
// ---------------------------------------------------------------------------

export interface ProcedureReceiptInput {
	readonly workflow: WorkflowDefinition;
	readonly runId: string;
	readonly finalStatus: WorkflowRunStatus;
	readonly durationMs: number;
	readonly nodeOutputs: ReadonlyMap<string, NodeOutput>;
	readonly cancelReason?: string;
}

const RECEIPT_EXCERPT_LIMIT = 80;

const RECEIPT_STATUS_ICON: Record<string, string> = {
	completed: "✓",
	failed: "✗",
	cancelled: "⊘",
};

/**
 * Render the post-run receipt as an array of lines. Layout:
 *
 *   ✓ <name> <status> in <Ns> · run <runId>
 *     ✓ <id>[: <excerpt>]      ← prompt/command nodes excerpt their final text
 *     ✗ <id>[: <reason>]
 *     · <id> (skipped)
 *     view: /procedures status <runId>
 *
 * Bash node output is intentionally omitted from the excerpt (can be huge,
 * not human-readable). The user sees the full output via /procedures status
 * or the per-node text under .pi/procedures/runs/<id>/nodes/.
 */
export function formatProcedureReceipt(input: ProcedureReceiptInput): string[] {
	const seconds = (input.durationMs / 1000).toFixed(1);
	const headerIcon = RECEIPT_STATUS_ICON[input.finalStatus] ?? "·";
	const lines: string[] = [
		`${headerIcon} ${input.workflow.name} ${input.finalStatus} in ${seconds}s · run ${input.runId}`,
	];
	if (input.cancelReason) {
		lines.push(`  cancel: ${input.cancelReason}`);
	}

	const kindOf = new Map<string, "prompt" | "command" | "bash" | "other">();
	for (const node of input.workflow.nodes) {
		if ("prompt" in node && typeof node.prompt === "string") kindOf.set(node.id, "prompt");
		else if ("command" in node && typeof node.command === "string") kindOf.set(node.id, "command");
		else if ("bash" in node && typeof node.bash === "string") kindOf.set(node.id, "bash");
		else kindOf.set(node.id, "other");
	}

	for (const [nodeId, output] of input.nodeOutputs) {
		const kind = kindOf.get(nodeId) ?? "other";
		if (output.state === "completed") {
			const excerpt =
				kind === "prompt" || kind === "command" ? excerptForReceipt(output.output) : "";
			lines.push(excerpt ? `  ✓ ${nodeId}: ${excerpt}` : `  ✓ ${nodeId}`);
		} else if (output.state === "failed") {
			const reason = output.error ? excerptForReceipt(output.error) : "";
			lines.push(reason ? `  ✗ ${nodeId}: ${reason}` : `  ✗ ${nodeId}`);
		} else if (output.state === "skipped") {
			lines.push(`  · ${nodeId} (skipped)`);
		}
	}

	lines.push(`  view: /procedures status ${input.runId}`);
	return lines;
}

function excerptForReceipt(s: string): string {
	const single = s.replace(/\s+/g, " ").trim();
	if (single.length <= RECEIPT_EXCERPT_LIMIT) return single;
	return `${single.slice(0, RECEIPT_EXCERPT_LIMIT - 1)}…`;
}
