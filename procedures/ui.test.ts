// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";

import { parseWorkflow } from "./loader.ts";
import type { WorkflowDefinition } from "./schema/index.ts";
import { renderWorkflowDag } from "./ui.ts";

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
