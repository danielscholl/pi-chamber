/**
 * Status emission for procedure runs — wraps the shared transient-panel /
 * working-panel primitives so the slash command surface stays small.
 *
 * For Phase 1 the UI is intentionally text-mode:
 *   - one-line notify per node start / completion / skip / failure
 *   - an animated working panel during the in-flight portion of the run
 *
 * A richer DAG-graph status board lens is deferred to Phase 1.5.
 */

import type { NoticeContext } from "../shared/notice.ts";
import { notify, startWorkingPanel } from "../shared/notice.ts";
import type { WorkflowDefinition } from "./schema/index.ts";

export const PROCEDURES_PROGRESS_WIDGET_KEY = "procedures-progress";
export const PROCEDURES_RECEIPT_WIDGET_KEY = "procedures-receipt";

const RECEIPT_TTL_MS = 12_000;

function createReceiptEmitter(ttlMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return function emit(ctx: NoticeContext, lines: readonly string[]): void {
		if (!ctx.hasUI || !ctx.ui.setWidget) {
			notify(ctx, lines.join("\n"), "info");
			return;
		}
		const setWidget = ctx.ui.setWidget;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		setWidget(PROCEDURES_RECEIPT_WIDGET_KEY, [...lines], { placement: "aboveEditor" });
		timer = setTimeout(() => {
			timer = undefined;
			try {
				setWidget(PROCEDURES_RECEIPT_WIDGET_KEY, undefined);
			} catch {
				// ctx may be torn down by the time the timer fires
			}
		}, ttlMs);
		timer.unref?.();
	};
}

/**
 * Post the post-run receipt as a transient widget anchored above the editor.
 * Auto-clears after RECEIPT_TTL_MS so stale receipts don't pile up. Falls back
 * to a single notify when no UI / setWidget is available (so headless runs
 * still see the full summary).
 */
export const emitProcedureReceipt = createReceiptEmitter(RECEIPT_TTL_MS);

const RUN_PHRASES = [
	"queueing nodes",
	"walking the DAG",
	"running steps",
	"settling outputs",
	"checking conditions",
	"writing artifacts",
] as const;

/**
 * Start an animated working-panel for the procedure run. Returns a stop
 * function the caller is expected to invoke in the `finally` of the run
 * promise so the widget always clears.
 */
export function startProcedurePanel(
	ctx: NoticeContext,
	workflow: WorkflowDefinition,
	runId: string,
): () => void {
	return startWorkingPanel(ctx, {
		widgetKey: PROCEDURES_PROGRESS_WIDGET_KEY,
		label: `procedure: ${workflow.name}`,
		phrases: RUN_PHRASES as unknown as readonly string[],
		footer: [
			`run-id: ${runId}`,
			`nodes: ${workflow.nodes.length}`,
		],
	});
}

/** Render a workflow as a compact text DAG (used by /procedures show). */
export function renderWorkflowDag(workflow: WorkflowDefinition): string {
	const lines: string[] = [
		`Procedure: ${workflow.name}`,
		`  ${workflow.description.split("\n")[0]}`,
		"",
		"Nodes:",
	];
	for (const node of workflow.nodes) {
		const kind = nodeKind(node);
		const deps = node.depends_on?.length ? `  ← ${node.depends_on.join(", ")}` : "";
		const when = node.when ? `  when: ${node.when}` : "";
		const trigger = node.trigger_rule ? `  rule: ${node.trigger_rule}` : "";
		lines.push(`  - ${node.id}  [${kind}]${deps}${when}${trigger}`);
	}
	return lines.join("\n");
}

function nodeKind(
	node: WorkflowDefinition["nodes"][number],
): "command" | "prompt" | "bash" | "loop" | "approval" | "cancel" | "script" | "?" {
	if ("command" in node && typeof node.command === "string") return "command";
	if ("prompt" in node && typeof node.prompt === "string") return "prompt";
	if ("bash" in node && typeof node.bash === "string") return "bash";
	if ("loop" in node && node.loop) return "loop";
	if ("approval" in node && node.approval) return "approval";
	if ("cancel" in node && typeof node.cancel === "string") return "cancel";
	if ("script" in node && typeof node.script === "string") return "script";
	return "?";
}

