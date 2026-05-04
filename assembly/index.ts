import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { authorMindOnce } from "../genesis/index.ts";
import {
	spawnGenesisAuthoring,
	type SpawnGenesisFn,
} from "../genesis/spawn.ts";
import {
	type AssembleCommandContext,
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

	pi.registerCommand("assembly", {
		description:
			"Propose and author a team of Genesis minds for the current project (auto-saves an open-floor room and a status-board lens).",
		handler: async (args, ctx) => {
			await runAssembleCommand(
				args ?? "",
				ctx as unknown as AssembleCommandContext,
				{
					pi,
					spawnSubagent,
					authorMind: (fields, config, cwd) =>
						authorMindOnce(
							fields,
							config,
							cwd,
							spawnSubagent,
							(stream, entry) => {
								try {
									pi.appendEntry(stream, entry);
								} catch {
									/* audit is best-effort */
								}
							},
						),
				},
			);
		},
	});
}
