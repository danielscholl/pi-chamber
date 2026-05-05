/**
 * PromptNode handler — substitutes variables and dispatches a single pi spawn.
 *
 * The executor pre-resolves `resumeSessionId` based on the node's `context`
 * setting (`shared` → prior session, `fresh` or omitted → undefined). The
 * handler does no DAG reasoning of its own.
 *
 * Substitution uses `escapedForBash: false` because the prompt is passed to
 * pi as a single positional argument, not embedded in a shell script.
 */

import type { NodeOutput, PromptNode } from "../schema/index.ts";
import {
	substituteNodeOutputRefs,
	substituteWorkflowVariables,
} from "../substitute.ts";
import type { NodeHandler } from "./types.ts";

export const promptHandler: NodeHandler<PromptNode> = async ({
	node,
	cwd,
	env,
	workflowArgs,
	upstreamOutputs,
	signal,
	resumeSessionId,
	onDelta,
	spawnPi,
}) => {
	const afterArgs = substituteWorkflowVariables(node.prompt, workflowArgs);
	const finalPrompt = substituteNodeOutputRefs(afterArgs, upstreamOutputs, false);

	const result = await spawnPi({
		prompt: finalPrompt,
		cwd,
		env,
		model: node.model,
		allowedTools: node.allowed_tools,
		deniedTools: node.denied_tools,
		systemPrompt: node.systemPrompt,
		resumeSessionId,
		signal,
		onDelta,
	});

	if (result.aborted) {
		const output: NodeOutput = {
			state: "failed",
			output: result.finalText,
			error: `aborted (signal): ${(result.errorMessage ?? result.stderr).slice(0, 500)}`.trim(),
			...(result.sessionId ? { sessionId: result.sessionId } : {}),
			...(result.usage ? { usage: result.usage } : {}),
		};
		return output;
	}
	if (result.exitCode !== 0 || result.stopReason === "error") {
		const output: NodeOutput = {
			state: "failed",
			output: result.finalText,
			error:
				`pi spawn failed (exit ${result.exitCode}` +
				(result.stopReason ? `, stopReason ${result.stopReason}` : "") +
				`): ${(result.errorMessage ?? result.stderr).slice(0, 1000)}`.trim(),
			...(result.sessionId ? { sessionId: result.sessionId } : {}),
			...(result.usage ? { usage: result.usage } : {}),
		};
		return output;
	}

	const output: NodeOutput = {
		state: "completed",
		output: result.finalText,
		...(result.sessionId ? { sessionId: result.sessionId } : {}),
		...(result.usage ? { usage: result.usage } : {}),
	};
	return output;
};
