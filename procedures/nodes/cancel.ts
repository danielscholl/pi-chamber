/**
 * CancelNode handler — terminates the run with a reason. Reported as a
 * `failed` NodeOutput so the executor's error aggregation surfaces it; the
 * executor recognizes the cancel state and transitions the run status to
 * `cancelled` instead of `failed` (see executor.ts).
 */

import type { CancelNode, NodeOutput } from "../schema/index.ts";
import type { NodeHandler } from "./types.ts";

export const SENTINEL_CANCELLED_BY_NODE = "__procedure_cancelled_by_node__";

export const cancelHandler: NodeHandler<CancelNode> = async ({ node }) => {
	const reason = node.cancel.trim();
	const output: NodeOutput = {
		state: "failed",
		output: reason,
		error: `${SENTINEL_CANCELLED_BY_NODE}: ${reason}`,
	};
	return output;
};
