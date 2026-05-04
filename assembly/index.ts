import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { authorMindOnce } from "../genesis/index.ts";
import {
	spawnGenesisAuthoring,
	type SpawnGenesisFn,
} from "../genesis/spawn.ts";
import { runAdjournCommand } from "./adjourn.ts";
import {
	type AssembleCommandContext,
	parseAssembleArgs,
	runAssembleCommand,
} from "./core.ts";

export interface AssemblyExtensionDeps {
	/**
	 * Spawn helper used to run the proposal and per-member authoring prompts in
	 * child Pi processes. Defaults to {@link spawnGenesisAuthoring}; tests inject
	 * a stub.
	 */
	spawnSubagent?: SpawnGenesisFn;
}

export default function (
	pi: ExtensionAPI,
	deps: AssemblyExtensionDeps = {},
) {
	const spawnSubagent: SpawnGenesisFn =
		deps.spawnSubagent ?? spawnGenesisAuthoring;

	const safeAppendEntry = (
		stream: string,
		entry: Record<string, unknown>,
	) => {
		try {
			pi.appendEntry(stream, entry);
		} catch {
			/* audit is best-effort */
		}
	};

	pi.registerCommand("assembly", {
		description:
			"Convene a team of Genesis minds for the project (default), or `/assembly adjourn [slug]` to take one apart.",
		handler: async (args, ctx) => {
			const raw = args ?? "";
			const parsed = parseAssembleArgs(raw);
			const cmdCtx = ctx as unknown as AssembleCommandContext;

			if (parsed.mode === "adjourn") {
				await runAdjournCommand(
					{ adjournSlug: parsed.adjournSlug },
					cmdCtx,
					{ pi, appendEntry: safeAppendEntry },
				);
				return;
			}

			await runAssembleCommand(raw, cmdCtx, {
				pi,
				spawnSubagent,
				authorMind: (fields, config, cwd) =>
					authorMindOnce(
						fields,
						config,
						cwd,
						spawnSubagent,
						safeAppendEntry,
					),
			});
		},
	});
}
