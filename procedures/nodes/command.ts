/**
 * CommandNode handler — resolves the named command from a `.pi/commands/` or
 * `.archon/commands/` markdown file and runs it as a PromptNode.
 *
 * Compatibility: pi-chamber Phase 1 doesn't ship a curated command library
 * (see procedures/README on the "command-library" decision). Workflows that
 * reference a command file the consuming project doesn't supply will fail at
 * this node with a clear error pointing the user at the bring-your-own
 * command roots.
 */

import type { CommandNode, NodeOutput } from "../schema/index.ts";
import {
	substituteNodeOutputRefs,
	substituteWorkflowVariables,
} from "../substitute.ts";
import type { NodeHandler } from "./types.ts";

export const commandHandler: NodeHandler<CommandNode> = async ({
	node,
	cwd,
	workflowArgs,
	upstreamOutputs,
	signal,
	resumeSessionId,
	onDelta,
	spawnPi,
	resolveCommand,
}) => {
	const body = await resolveCommand(node.command);
	if (body === null) {
		const output: NodeOutput = {
			state: "failed",
			output: "",
			error:
				`command '${node.command}' not found. ` +
				`pi-chamber looks for command files under .pi/commands/<name>.md and .archon/commands/<name>.md. ` +
				`Add the file to either root, or replace this node with an inline 'prompt:' field.`,
		};
		return output;
	}

	const afterArgs = substituteWorkflowVariables(body, workflowArgs);
	const finalPrompt = substituteNodeOutputRefs(afterArgs, upstreamOutputs, false);

	const result = await spawnPi({
		prompt: finalPrompt,
		cwd,
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
		};
		return output;
	}

	const output: NodeOutput = {
		state: "completed",
		output: result.finalText,
		...(result.sessionId ? { sessionId: result.sessionId } : {}),
	};
	return output;
};
