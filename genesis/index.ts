// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { randomUUID } from "node:crypto";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, writeFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
	assertInsideProject,
	collapseOneLine,
	createMindStructure,
	seedSharedDoctrine,
	ensureTrailingNewline,
	type GenesisConfig,
	type GenesisPaths,
	loadGenesisConfig,
	normalizeVoiceDescription,
	type PendingGenesisRequest,
	parseGenesisArgs,
	resolveGenesisPaths,
	slugify,
	validateMind,
} from "./core.ts";
import {
	buildAgentShim,
	buildGenesisAuthoringPrompt,
} from "./prompts.ts";
import {
	findGenesisStarterByName,
	GENESIS_STARTERS,
	type GenesisStarter,
} from "./starters.ts";
import { listGenesisMinds } from "../mind/core.ts";
import {
	loadObservatoryConfig,
	resolveLensesRoot,
	scaffoldNewspaper,
} from "../observatory/core.ts";

const REQUEST_EXPIRATION_MS = 10 * 60 * 1000;

const GenesisWriteFilesSchema = Type.Object({
	requestId: Type.String(),
	description: Type.String(),
	soul: Type.String(),
	agentInstructions: Type.String(),
	memory: Type.String(),
	rules: Type.String(),
	log: Type.String(),
	mindIndex: Type.String(),
});

type GenesisWriteFilesParams = {
	requestId: string;
	description: string;
	soul: string;
	agentInstructions: string;
	memory: string;
	rules: string;
	log: string;
	mindIndex: string;
};

type GenesisAuthoringFields = {
	name: string;
	role: string;
	voice: string;
	voiceDescription: string;
	slug?: string;
	source?: string;
};

type GenesisAuthoringOptions = {
	alreadyExistsLabel?: string;
	startedMessage?: string;
};

type GenesisCommandContext = {
	cwd: string;
	hasUI: boolean;
	waitForIdle(): Promise<void>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

export default function (pi: ExtensionAPI) {
	const pending = new Map<string, PendingGenesisRequest>();

	function pruneExpiredRequests(now = Date.now()): void {
		for (const [requestId, request] of pending) {
			if (now - request.createdAt > REQUEST_EXPIRATION_MS) {
				pending.delete(requestId);
			}
		}
	}

	pi.registerTool(
		defineTool({
			name: "genesis_write_files",
			label: "Genesis write files",
			description:
				"Finish a pending /genesis request by handing authored mind files to the Genesis extension for validation and safe project-local writes.",
			promptSnippet:
				"genesis_write_files: complete a pending /genesis request; use exactly once with the requestId from the Genesis prompt.",
			promptGuidelines: [
				"When a /genesis prompt gives you a requestId, call genesis_write_files exactly once to finish /genesis.",
				"Do not write Genesis mind files directly; genesis_write_files validates and writes SOUL.md, memory, rules, log, mind-index, and the runnable shim.",
			],
			parameters: GenesisWriteFilesSchema,
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				const result = completeGenesisRequest(
					params as GenesisWriteFilesParams,
				);
				return {
					content: [{ type: "text", text: result.message }],
					details: result.details,
					terminate: true,
				};
			},
		}),
	);

	function registerStarterCommand(
		commandSlug: string,
		starter: GenesisStarter,
	) {
		pi.registerCommand(`genesis:${commandSlug}`, {
			description: starter.tagline,
			handler: async (_args, ctx) => {
				pruneExpiredRequests();
				let config: GenesisConfig;
				try {
					config = loadGenesisConfig(ctx.cwd);
				} catch (error) {
					notify(
						ctx,
						`Genesis configuration could not be loaded: ${errorMessage(error)}`,
						"error",
					);
					return;
				}
				await startStarterGenesis(starter, config, ctx);
			},
		});
	}

	for (const starter of GENESIS_STARTERS) {
		registerStarterCommand(starter.slug, starter);
	}

	pi.registerCommand("genesis", {
		description:
			"Create a persistent Genesis mind and runnable pi-subagents shim.",
		getArgumentCompletions: (prefix: string) =>
			genesisArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			pruneExpiredRequests();

			let config: GenesisConfig;
			try {
				config = loadGenesisConfig(ctx.cwd);
			} catch (error) {
				notify(
					ctx,
					`Genesis configuration could not be loaded: ${errorMessage(error)}`,
					"error",
				);
				return;
			}

			const value = (args || "").trim();
			const lower = value.toLowerCase();

			if (lower === "help" || lower === "?") {
				notify(
					ctx,
					`${genesisUsageText()}${genesisStartersSuffix()}${existingMindsSuffix(ctx.cwd)}`,
					"info",
				);
				return;
			}

			if (lower === "list") {
				showGenesisList(ctx);
				return;
			}

			if (lower && lower !== "custom") {
				const starter = findGenesisStarterByInput(lower);
				if (starter) {
					await startStarterGenesis(starter, config, ctx);
					return;
				}
			}

			if (!value && ctx.hasUI) {
				const starterName = await ctx.ui.select("Genesis starter:", [
					"Custom mind",
					...GENESIS_STARTERS.map((starter) => starter.name),
				]);
				if (!starterName) return;
				const starter = findGenesisStarterByName(starterName);
				if (starter) {
					await startStarterGenesis(starter, config, ctx);
					return;
				}
			}

			const parsed = parseGenesisArgs(lower === "custom" ? "" : value);
			const fields = await collectGenesisFields(parsed, config, ctx);
			if (!fields) return;

			await startGenesisAuthoringRequest(fields, config, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("genesis", "genesis ready");
	});

	async function startStarterGenesis(
		starter: GenesisStarter,
		config: GenesisConfig,
		ctx: GenesisCommandContext,
	): Promise<void> {
		await startGenesisAuthoringRequest(
			{
				name: starter.name,
				slug: starter.slug,
				role: starter.role,
				voice: starter.voice,
				voiceDescription: starter.voiceDescription,
				source: starter.slug,
			},
			config,
			ctx,
			{
				alreadyExistsLabel: "Genesis starter",
				startedMessage: `Genesis started for ${starter.name}. The model should call genesis_write_files to finish the ${starter.name} preset.`,
			},
		);
	}

	async function startGenesisAuthoringRequest(
		fields: GenesisAuthoringFields,
		config: GenesisConfig,
		ctx: GenesisCommandContext,
		options: GenesisAuthoringOptions = {},
	): Promise<void> {
		const name = fields.name.trim();
		const role = fields.role.trim() || config.defaultRole;
		const voice = fields.voice.trim() || config.defaultVoice;
		const voiceDescription = fields.voiceDescription.trim();
		const slug = fields.slug?.trim() || slugify(name);

		if (!slug) {
			notify(
				ctx,
				"Genesis mind name must contain at least one ASCII letter or number.",
				"error",
			);
			return;
		}

		let paths;
		try {
			paths = resolveGenesisPaths(ctx.cwd, slug, config);
			assertGenesisPathsInsideProject(paths);
		} catch (error) {
			notify(
				ctx,
				`Genesis path configuration is invalid: ${errorMessage(error)}`,
				"error",
			);
			return;
		}

		const alreadyExistsLabel = options.alreadyExistsLabel ?? "Genesis mind";
		if (existsSync(paths.mindPath)) {
			notify(
				ctx,
				`${alreadyExistsLabel} already exists: ${relativeToCwd(paths.cwd, paths.mindPath)}. Delete it before retrying.`,
				"error",
			);
			return;
		}
		if (existsSync(paths.shimPath)) {
			notify(
				ctx,
				`${alreadyExistsLabel} shim already exists: ${relativeToCwd(paths.cwd, paths.shimPath)}. Delete it before retrying.`,
				"error",
			);
			return;
		}

		try {
			createMindStructure(paths);
			seedSharedDoctrine(paths);
		} catch (error) {
			notify(
				ctx,
				`Genesis could not create scaffold directories: ${errorMessage(error)}`,
				"error",
			);
			return;
		}

		if (config.seedLensViews) {
			try {
				const observatoryConfig = loadObservatoryConfig(paths.cwd);
				const lensesRoot = resolveLensesRoot(paths.cwd, observatoryConfig);
				scaffoldNewspaper(lensesRoot, slug);
			} catch (error) {
				// Non-fatal: genesis still proceeds. The operator can author
				// the lens manually under .pi/observatory/lenses/<slug>-newspaper/.
				notify(
					ctx,
					`Genesis could not seed starter newspaper: ${errorMessage(error)}`,
					"warning",
				);
			}
		}

		const request: PendingGenesisRequest = {
			requestId: randomUUID(),
			createdAt: Date.now(),
			cwd: paths.cwd,
			name,
			slug,
			role,
			voice,
			voiceDescription,
			normalizedVoiceDescription: voiceDescription,
			paths,
			config,
			source: fields.source,
		};
		pending.set(request.requestId, request);

		const prompt = buildGenesisAuthoringPrompt(request);
		try {
			await ctx.waitForIdle();
			pi.sendUserMessage(prompt);
		} catch (error) {
			pending.delete(request.requestId);
			notify(
				ctx,
				`Genesis could not start authoring prompt: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		notify(
			ctx,
			options.startedMessage ??
				`Genesis started for ${name}. The model should call genesis_write_files to finish.`,
			"info",
		);
	}

	function completeGenesisRequest(params: GenesisWriteFilesParams) {
		pruneExpiredRequests();

		const requestId = params.requestId?.trim();
		const request = requestId ? pending.get(requestId) : undefined;
		if (!request) {
			throw new Error(
				"Unknown or expired Genesis requestId. Re-run /genesis to create a fresh pending request.",
			);
		}

		const paths = resolveGenesisPaths(
			request.cwd,
			request.slug,
			request.config,
		);
		assertInsideProject(request.cwd, paths.mindPath, "mindPath");
		assertInsideProject(request.cwd, paths.shimPath, "shimPath");
		assertStoredPathsUnchanged(request, paths);

		const content = validateGenesisContent(params);
		const description = collapseOneLine(content.description);
		if (content.agentInstructions.startsWith("---")) {
			throw new Error(
				"agentInstructions must not start with YAML frontmatter; Genesis owns shim frontmatter generation.",
			);
		}

		const shim = buildAgentShim({
			name: request.name,
			slug: request.slug,
			description,
			agentInstructions: content.agentInstructions,
			paths,
		});

		writeFileSync(paths.soulPath, ensureTrailingNewline(content.soul), "utf-8");
		writeFileSync(
			paths.mindIndexPath,
			ensureTrailingNewline(content.mindIndex),
			"utf-8",
		);
		writeFileSync(
			paths.memoryPath,
			ensureTrailingNewline(content.memory),
			"utf-8",
		);
		writeFileSync(
			paths.rulesPath,
			ensureTrailingNewline(content.rules),
			"utf-8",
		);
		writeFileSync(paths.logPath, ensureTrailingNewline(content.log), "utf-8");
		writeFileSync(paths.shimPath, ensureTrailingNewline(shim), "utf-8");

		const validation = validateMind(paths);
		if (!validation.ok) {
			throw new Error(
				`Genesis validation failed after writes:\n${validation.errors.join("\n")}`,
			);
		}

		pending.delete(request.requestId);
		try {
			pi.appendEntry("genesis", {
				slug: request.slug,
				...(request.source ? { source: request.source } : {}),
				mindPath: relativeToCwd(paths.cwd, paths.mindPath),
				shimPath: relativeToCwd(paths.cwd, paths.shimPath),
				createdAt: new Date(request.createdAt).toISOString(),
			});
		} catch {
			// Audit entries are helpful but not required for Genesis completion.
		}

		const mindPath = relativeToCwd(paths.cwd, paths.mindPath);
		const shimPath = relativeToCwd(paths.cwd, paths.shimPath);
		const message = [
			"Genesis complete.",
			`Mind: ${mindPath}`,
			`Runnable agent: ${shimPath}`,
			`Try direct chat: /mind ${request.slug}`,
			`Try delegated task: /run ${request.slug} "Introduce yourself and read your memory first."`,
			"Note: If the delegated agent does not appear immediately, run /reload or open /agents.",
		].join("\n");

		return {
			message,
			details: {
				slug: request.slug,
				mindPath,
				shimPath,
			},
		};
	}
}

function genesisArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const slugs = safeListGenesisMinds(".");
	const items: AutocompleteItem[] = [
		{
			value: "help",
			label: "help",
			description: "Show /genesis usage, examples, and starter presets",
		},
		{
			value: "list",
			label: "list",
			description: "List existing Genesis minds and built-in starters",
		},
		{
			value: "custom",
			label: "custom",
			description: "Start an interactive custom mind creation flow",
		},
		...GENESIS_STARTERS.map((starter) => ({
			value: starter.slug,
			label: starter.slug,
			description: `Create the ${starter.name} preset — ${starter.description}`,
		})),
		{
			value:
				'name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
			label: 'name="Ariadne" role="..." voice="..."',
			description: "Create a custom mind from inline fields",
		},
		...slugs.map((slug) => ({
			value: slug,
			label: slug,
			description: `Existing mind ${slug}; use /mind ${slug} to activate it`,
		})),
	];
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function genesisUsageText(): string {
	return [
		"Usage: /genesis, /genesis custom, /genesis <starter>, /genesis list, or /genesis help.",
		'Custom inline: /genesis name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
		"After Genesis completes, activate the mind with /mind <slug> or delegate with /run <slug> <task>.",
	].join("\n");
}

function genesisStartersSuffix(): string {
	return `\n\nBuilt-in starters:\n${GENESIS_STARTERS.map(
		(starter) => `- ${starter.slug}: ${starter.description}`,
	).join("\n")}`;
}

function existingMindsSuffix(cwd: string): string {
	const slugs = safeListGenesisMinds(cwd);
	return slugs.length
		? `\n\nExisting complete minds: ${slugs.join(", ")}. Use /mind <slug> to activate.`
		: "\n\nNo complete Genesis minds found yet. Start with /genesis custom or /genesis moneypenny.";
}

function showGenesisList(ctx: GenesisCommandContext): void {
	const slugs = safeListGenesisMinds(ctx.cwd);
	const existing = slugs.length
		? slugs.map((slug) => `- ${slug}`).join("\n")
		: "- none yet";
	const starters = GENESIS_STARTERS.map(
		(starter) => `- ${starter.slug}: ${starter.description}`,
	).join("\n");
	notify(
		ctx,
		`Existing complete Genesis minds:\n${existing}\n\nBuilt-in starters:\n${starters}\n\nCreate one with /genesis custom, /genesis <starter>, or /genesis name="Ariadne" role="..." voice="...".`,
		"info",
	);
}

function findGenesisStarterByInput(input: string): GenesisStarter | undefined {
	return GENESIS_STARTERS.find(
		(starter) => starter.slug === input || starter.name.toLowerCase() === input,
	);
}

function safeListGenesisMinds(cwd: string): string[] {
	try {
		return listGenesisMinds(cwd);
	} catch {
		return [];
	}
}

async function collectGenesisFields(
	parsed: Partial<{ name: string; role: string; voice: string }>,
	config: { defaultRole: string; defaultVoice: string },
	ctx: {
		hasUI: boolean;
		ui: {
			input(title: string, placeholder?: string): Promise<string | undefined>;
			notify(message: string, type?: "info" | "warning" | "error"): void;
		};
	},
): Promise<
	| {
			name: string;
			role: string;
			voice: string;
			voiceDescription: string;
	  }
	| undefined
> {
	let name = parsed.name?.trim() ?? "";
	let role = parsed.role?.trim() ?? "";
	let voice = parsed.voice?.trim() ?? "";

	if (!name) {
		if (!ctx.hasUI) {
			notify(
				ctx,
				'Usage: /genesis name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
				"error",
			);
			return undefined;
		}
		name = (await ctx.ui.input("Genesis mind name:", "Ariadne"))?.trim() ?? "";
	}

	if (!name) {
		notify(ctx, "Genesis mind name is required.", "error");
		return undefined;
	}

	if (!role && ctx.hasUI) {
		role =
			(await ctx.ui.input("Genesis mind role:", config.defaultRole))?.trim() ??
			"";
	}
	if (!voice && ctx.hasUI) {
		voice =
			(
				await ctx.ui.input("Genesis mind voice:", config.defaultVoice)
			)?.trim() ?? "";
	}

	role = role || config.defaultRole;
	voice = voice || config.defaultVoice;

	return {
		name,
		role,
		voice,
		voiceDescription: normalizeVoiceDescription(voice),
	};
}

function validateGenesisContent(params: GenesisWriteFilesParams) {
	const content = {
		description: params.description?.trim() ?? "",
		soul: params.soul?.trim() ?? "",
		agentInstructions: params.agentInstructions?.trim() ?? "",
		memory: params.memory?.trim() ?? "",
		rules: params.rules?.trim() ?? "",
		log: params.log?.trim() ?? "",
		mindIndex: params.mindIndex?.trim() ?? "",
	};

	const missing = Object.entries(content)
		.filter(([, value]) => !value)
		.map(([key]) => key);
	if (missing.length > 0) {
		throw new Error(
			`Genesis requires non-empty content for: ${missing.join(", ")}. No files were written.`,
		);
	}

	return content;
}

function assertGenesisPathsInsideProject(paths: GenesisPaths): void {
	for (const [label, targetPath] of [
		["mindPath", paths.mindPath],
		["sharedMindPath", paths.sharedMindPath],
		["sharedIdeaPath", paths.sharedIdeaPath],
		["shimPath", paths.shimPath],
		["soulPath", paths.soulPath],
		["mindIndexPath", paths.mindIndexPath],
		["memoryPath", paths.memoryPath],
		["rulesPath", paths.rulesPath],
		["logPath", paths.logPath],
	] as const) {
		assertInsideProject(paths.cwd, targetPath, label);
	}
}

function assertStoredPathsUnchanged(
	request: PendingGenesisRequest,
	resolved: PendingGenesisRequest["paths"],
): void {
	const pairs: Array<[string, string, string]> = [
		["mindPath", request.paths.mindPath, resolved.mindPath],
		["sharedMindPath", request.paths.sharedMindPath, resolved.sharedMindPath],
		["sharedIdeaPath", request.paths.sharedIdeaPath, resolved.sharedIdeaPath],
		["shimPath", request.paths.shimPath, resolved.shimPath],
		["soulPath", request.paths.soulPath, resolved.soulPath],
		["mindIndexPath", request.paths.mindIndexPath, resolved.mindIndexPath],
		["memoryPath", request.paths.memoryPath, resolved.memoryPath],
		["rulesPath", request.paths.rulesPath, resolved.rulesPath],
		["logPath", request.paths.logPath, resolved.logPath],
	];

	for (const [label, stored, rerun] of pairs) {
		if (path.resolve(stored) !== path.resolve(rerun)) {
			throw new Error(`Genesis ${label} changed before write; aborting.`);
		}
	}
}

function notify(
	ctx: {
		hasUI: boolean;
		ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	},
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") {
		throw new Error(message);
	}
}

function relativeToCwd(cwd: string, targetPath: string): string {
	const relative = path.relative(cwd, targetPath) || ".";
	return normalizePathSeparators(relative);
}

function normalizePathSeparators(value: string): string {
	return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
