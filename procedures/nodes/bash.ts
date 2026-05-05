/**
 * BashNode handler — runs the node's `bash:` script via `Bun.spawn` (or the
 * injected stub for tests).
 *
 * Behavior:
 *   - Substitutes `$ARGUMENTS` / `$1..$9` and `$nodeId.output[.field]` into
 *     the script body BEFORE shell-out, with `escapedForBash=true` so
 *     interpolated values are single-quoted (defends against injection from
 *     upstream node outputs).
 *   - Runs under `bash -c <script>` so heredocs, pipelines, and `&&` chains
 *     work as authors expect.
 *   - Captures stdout as the node's output. stderr is appended to the
 *     `error` channel only on non-zero exit.
 *   - Honors `timeout` from the node (ms). Default: no timeout (matches Archon).
 *   - The `env` argument is inherited from the executor and already contains
 *     workflow + upstream context.
 */

import type { BashNode, NodeOutput } from "../schema/index.ts";
import {
	substituteNodeOutputRefs,
	substituteWorkflowVariables,
} from "../substitute.ts";
import type { NodeHandler } from "./types.ts";

export const bashHandler: NodeHandler<BashNode> = async ({
	node,
	cwd,
	env,
	workflowArgs,
	upstreamOutputs,
	signal,
	spawnBash,
}) => {
	// Two-pass substitution: workflow vars first (no escaping; positional args
	// are already unescaped strings the user typed), then upstream output refs
	// with shell-escaping so a quote in a prior node's output can't break out
	// of the script.
	const afterArgs = substituteWorkflowVariables(node.bash, workflowArgs);
	const finalScript = substituteNodeOutputRefs(afterArgs, upstreamOutputs, true);

	const result = await spawnBash({
		script: finalScript,
		cwd,
		env,
		timeoutMs: node.timeout,
		signal,
	});

	if (result.aborted) {
		const output: NodeOutput = {
			state: "failed",
			output: result.stdout,
			error: `aborted (signal): ${result.stderr.slice(0, 500)}`.trim(),
		};
		return output;
	}
	if (result.timedOut) {
		const output: NodeOutput = {
			state: "failed",
			output: result.stdout,
			error: `timed out after ${node.timeout ?? "?"}ms: ${result.stderr.slice(0, 500)}`.trim(),
		};
		return output;
	}
	if (result.exitCode !== 0) {
		const output: NodeOutput = {
			state: "failed",
			output: result.stdout,
			error: `exit ${result.exitCode}: ${result.stderr.slice(0, 1000)}`.trim(),
		};
		return output;
	}

	const output: NodeOutput = {
		state: "completed",
		output: result.stdout.trimEnd(),
	};
	return output;
};
