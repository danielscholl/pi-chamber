/**
 * Canned message strings used by the slash-command surface and the executor.
 * Centralized so wording is consistent and easy to audit / translate.
 */

import type { WorkflowLoadWarning } from "./loader.ts";
import type { RunSummary } from "./store.ts";
import type { WorkflowSource, WorkflowWithSource } from "./schema/index.ts";

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

export function formatRunComplete(runId: string, durationMs: number): string {
	const seconds = (durationMs / 1000).toFixed(1);
	return `Procedure run ${runId} completed in ${seconds}s.`;
}

export function formatRunFailed(runId: string, errorSummary: string): string {
	return `Procedure run ${runId} failed: ${errorSummary}`;
}

export function formatRunCancelled(runId: string, reason: string): string {
	return `Procedure run ${runId} cancelled: ${reason}`;
}
