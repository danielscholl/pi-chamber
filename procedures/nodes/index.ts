/**
 * Public surface for per-node handlers. The executor selects the correct
 * handler from `selectHandler(node)` based on the node's discriminant.
 *
 * Phase 1 implements: prompt, command, bash, cancel.
 * Phase 2+ adds: loop, approval, script.
 *
 * Unsupported node types throw at executor dispatch time with a clear
 * Phase-1 message so the user gets actionable feedback.
 */

import type { DagNode, NodeOutput } from "../schema/index.ts";
import {
	isApprovalNode,
	isBashNode,
	isCancelNode,
	isLoopNode,
	isScriptNode,
} from "../schema/index.ts";
import { bashHandler } from "./bash.ts";
import { cancelHandler } from "./cancel.ts";
import { commandHandler } from "./command.ts";
import { promptHandler } from "./prompt.ts";
import type { NodeExecuteInput, NodeHandler } from "./types.ts";

export type {
	BashSpawnFn,
	BashSpawnInput,
	BashSpawnResult,
	NodeExecuteInput,
	NodeHandler,
	SpawnPiFn,
} from "./types.ts";
export { SENTINEL_CANCELLED_BY_NODE } from "./cancel.ts";

/**
 * Pick the handler for a node based on its discriminant. Returns a function
 * that throws a Phase 1 message for loop/approval/script nodes (they parse
 * fine but the runtime can't run them yet).
 */
export function selectHandler(node: DagNode): NodeHandler {
	const id = node.id;
	if (isCancelNode(node)) return cancelHandler as NodeHandler;
	if (isBashNode(node)) return bashHandler as NodeHandler;
	if (isLoopNode(node)) return notImplementedHandler("loop");
	if (isApprovalNode(node)) return notImplementedHandler("approval");
	if (isScriptNode(node)) return notImplementedHandler("script");
	if ("command" in node && typeof node.command === "string") return commandHandler as NodeHandler;
	if ("prompt" in node && typeof node.prompt === "string") return promptHandler as NodeHandler;
	// Schema enforces mutual exclusivity, so this should be unreachable.
	throw new Error(`selectHandler: node '${id}' has no known mode field`);
}

function notImplementedHandler(kind: "loop" | "approval" | "script"): NodeHandler {
	return async (input: NodeExecuteInput): Promise<NodeOutput> => {
		const nodeId = (input.node as { id: string }).id;
		return {
			state: "failed",
			output: "",
			error:
				`'${kind}' nodes are not implemented in pi-chamber Phase 1 (node id: '${nodeId}'). ` +
				`Phase 2 will add loop + approval; script lands in Phase 3. ` +
				`See procedures/README compatibility table.`,
		};
	};
}
