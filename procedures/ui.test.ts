// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import { parseWorkflow } from "./loader.ts";
import type { WorkflowDefinition } from "./schema/index.ts";
import {
	emitProcedureReceipt,
	PROCEDURES_RECEIPT_WIDGET_KEY,
	renderWorkflowDag,
} from "./ui.ts";

function makeWorkflow(yaml: string): WorkflowDefinition {
	const result = parseWorkflow(yaml, "test.yaml");
	if (result.error) throw new Error(`fixture failed: ${result.error.error}`);
	return result.workflow;
}

describe("renderWorkflowDag", () => {
	test("renders header + node list with kinds", () => {
		const wf = makeWorkflow(`
name: triage
description: classify and act
nodes:
  - id: scope
    bash: echo scope
  - id: classify
    depends_on: [scope]
    prompt: classify
  - id: bug
    depends_on: [classify]
    when: "$classify.output == 'BUG'"
    bash: echo bug
`);
		const dag = renderWorkflowDag(wf);
		expect(dag).toContain("Procedure: triage");
		expect(dag).toContain("classify and act");
		expect(dag).toContain("- scope  [bash]");
		expect(dag).toContain("- classify  [prompt]  ← scope");
		expect(dag).toContain("- bug  [bash]  ← classify");
		expect(dag).toMatch(/when:/);
	});

	test("renders trigger_rule when set", () => {
		const wf = makeWorkflow(`
name: collector
description: fan-in collector
nodes:
  - id: a
    bash: echo a
  - id: b
    bash: echo b
  - id: collect
    depends_on: [a, b]
    trigger_rule: all_done
    bash: echo collect
`);
		const dag = renderWorkflowDag(wf);
		expect(dag).toContain("rule: all_done");
	});

	test("kinds are correctly identified for cancel and command nodes", () => {
		const wf = makeWorkflow(`
name: kinds
description: cancel + command
nodes:
  - id: precheck
    bash: echo p
  - id: stop
    cancel: bad
    depends_on: [precheck]
`);
		const dag = renderWorkflowDag(wf);
		expect(dag).toContain("[bash]");
		expect(dag).toContain("[cancel]");
	});
});

describe("emitProcedureReceipt", () => {
	test("UI path: posts a multi-line widget aboveEditor and clears on TTL", async () => {
		const setWidgetCalls: Array<{
			key: string;
			content: string[] | undefined;
			placement?: string;
		}> = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify: () => {
					throw new Error("notify should not run when setWidget is available");
				},
				setWidget: (
					key: string,
					content: string[] | undefined,
					options?: { placement?: "aboveEditor" | "belowEditor" },
				) => {
					setWidgetCalls.push({ key, content, placement: options?.placement });
				},
			},
		};
		emitProcedureReceipt(ctx, ["row 1", "row 2"]);
		expect(setWidgetCalls).toHaveLength(1);
		expect(setWidgetCalls[0]).toEqual({
			key: PROCEDURES_RECEIPT_WIDGET_KEY,
			content: ["row 1", "row 2"],
			placement: "aboveEditor",
		});

		// Re-emitting clears the prior timer; the widget remains set to the new content.
		emitProcedureReceipt(ctx, ["row 3"]);
		expect(setWidgetCalls).toHaveLength(2);
		expect(setWidgetCalls[1].content).toEqual(["row 3"]);
	});

	test("headless path (hasUI=false): joined receipt lands on stdout via shared notify", () => {
		const captured: string[] = [];
		const original = console.log;
		console.log = (msg?: unknown) => {
			captured.push(String(msg));
		};
		try {
			emitProcedureReceipt(
				{
					hasUI: false,
					ui: {
						notify: () => {
							throw new Error("ctx.ui.notify should not be called when hasUI=false");
						},
					},
				},
				["a", "b", "c"],
			);
		} finally {
			console.log = original;
		}
		expect(captured).toEqual(["a\nb\nc"]);
	});

	test("UI without setWidget: also falls through to notify", () => {
		const notifies: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify: (message: string) => {
					notifies.push(message);
				},
			},
		};
		emitProcedureReceipt(ctx, ["only"]);
		expect(notifies).toEqual(["only"]);
	});
});
