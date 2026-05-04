// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { randomUUID } from "node:crypto";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, rmSync, writeFileSync } from "node:fs";
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
	type GenesisAuthoringContent,
	type GenesisConfig,
	type GenesisPaths,
	loadGenesisConfig,
	normalizeVoiceDescription,
	parseGenesisAuthoringJson,
	type PendingGenesisRequest,
	parseGenesisArgs,
	resolveGenesisPaths,
	slugify,
	validateMind,
} from "./core.ts";
import {
	buildAgentShim,
	buildGenesisSubagentAuthoringPrompt,
} from "./prompts.ts";
import {
	spawnGenesisAuthoring,
	type SpawnGenesisFn,
	type SpawnGenesisResult,
} from "./spawn.ts";
import {
	findGenesisStarterByName,
	GENESIS_STARTERS,
	type GenesisStarter,
} from "./starters.ts";
import { listGenesisMinds } from "../mind/core.ts";
import {
	loadObservatoryConfig,
	removeNewspaperLens,
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
		setStatus?(key: string, value: string): void;
	};
};

export interface GenesisExtensionDeps {
	/**
	 * Spawn helper used to run the authoring prompt in a child Pi process.
	 * Defaults to {@link spawnGenesisAuthoring}; tests inject a stub.
	 */
	spawnSubagent?: SpawnGenesisFn;
}

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

export default function (
	pi: ExtensionAPI,
	deps: GenesisExtensionDeps = {},
) {
	const pending = new Map<string, PendingGenesisRequest>();
	const spawnSubagent: SpawnGenesisFn =
		deps.spawnSubagent ?? spawnGenesisAuthoring;

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
				startedMessage: `Authoring ${starter.name} (${starter.slug}).`,
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

		notify(
			ctx,
			options.startedMessage ?? `Authoring ${name} (${slug}).`,
			"info",
		);
		const stopProgress = startGenesisProgress(ctx, slug);

		let spawnResult: SpawnGenesisResult;
		try {
			const prompt = buildGenesisSubagentAuthoringPrompt(request);
			spawnResult = await spawnSubagent({
				slug: request.slug,
				prompt,
				cwd: request.cwd,
			});
		} catch (error) {
			stopProgress();
			pending.delete(request.requestId);
			setStatus(ctx, "genesis ready");
			notify(
				ctx,
				`Genesis subagent failed to start: ${errorMessage(error)}. Scaffolded directories remain at ${relativeToCwd(paths.cwd, paths.mindPath)}; delete before retrying.`,
				"error",
			);
			return;
		}

		stopProgress();

		if (spawnResult.aborted) {
			pending.delete(request.requestId);
			notify(
				ctx,
				`Genesis subagent was aborted. Scaffolded directories remain at ${relativeToCwd(paths.cwd, paths.mindPath)}; delete before retrying.`,
				"warning",
			);
			return;
		}

		if (spawnResult.exitCode !== 0) {
			pending.delete(request.requestId);
			const detail = spawnResult.stderr.trim()
				? ` Stderr: ${spawnResult.stderr.trim().slice(0, 400)}`
				: "";
			notify(
				ctx,
				`Genesis subagent exited with code ${spawnResult.exitCode}.${detail} Scaffolded directories remain at ${relativeToCwd(paths.cwd, paths.mindPath)}; delete before retrying.`,
				"error",
			);
			return;
		}

		let parsed: GenesisAuthoringContent;
		try {
			parsed = parseGenesisAuthoringJson(spawnResult.finalText);
		} catch (error) {
			pending.delete(request.requestId);
			setStatus(ctx, "genesis ready");
			notify(
				ctx,
				`Genesis subagent output was not valid JSON: ${errorMessage(error)} Scaffolded directories remain at ${relativeToCwd(paths.cwd, paths.mindPath)}; delete before retrying.`,
				"error",
			);
			return;
		}

		let completion: ReturnType<typeof completeGenesisRequest>;
		try {
			completion = completeGenesisRequest({
				requestId: request.requestId,
				...parsed,
			});
		} catch (error) {
			setStatus(ctx, "genesis ready");
			notify(
				ctx,
				`Genesis write failed: ${errorMessage(error)} Scaffolded directories remain at ${relativeToCwd(paths.cwd, paths.mindPath)}; delete before retrying.`,
				"error",
			);
			return;
		}

		setStatus(ctx, "genesis ready");
		notify(ctx, completion.message, "info");
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

function setStatus(ctx: GenesisCommandContext, value: string): void {
	if (!ctx.hasUI) return;
	const setter = ctx.ui.setStatus;
	if (typeof setter !== "function") return;
	try {
		setter.call(ctx.ui, "genesis", value);
	} catch {
		/* status updates are best-effort */
	}
}

const GENESIS_SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];

const GENESIS_BIRTH_PHRASES = [
	"systems initializing",
	"drafting soul",
	"writing memory",
	"encoding rules",
	"indexing knowledge",
	"awaiting genesis",
];

const PROGRESS_FRAME_INTERVAL_MS = 120;
const PROGRESS_PHRASE_INTERVAL_MS = 1800;
const PROGRESS_WIDGET_KEY = "genesis-progress";

type SetWidgetFn = (
	key: string,
	content: string[] | undefined,
	options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

function startGenesisProgress(
	ctx: GenesisCommandContext,
	slug: string,
): () => void {
	if (!ctx.hasUI) return () => {};

	const setWidget = (
		ctx.ui as { setWidget?: SetWidgetFn }
	).setWidget;

	const startedAt = Date.now();
	let frame = 0;
	let stopped = false;

	const renderLine = () => {
		const elapsedMs = Date.now() - startedAt;
		const seconds = Math.floor(elapsedMs / 1000);
		const phraseIndex =
			Math.floor(elapsedMs / PROGRESS_PHRASE_INTERVAL_MS) %
			GENESIS_BIRTH_PHRASES.length;
		const spinner =
			GENESIS_SPINNER_FRAMES[frame % GENESIS_SPINNER_FRAMES.length];
		return `${spinner} genesis ${slug} | ${GENESIS_BIRTH_PHRASES[phraseIndex]}… ${seconds}s`;
	};

	const tick = () => {
		if (stopped) return;
		const line = renderLine();
		if (typeof setWidget === "function") {
			try {
				setWidget(PROGRESS_WIDGET_KEY, [line], { placement: "aboveEditor" });
			} catch {
				/* widget updates are best-effort */
			}
		}
		setStatus(ctx, line);
		frame += 1;
	};

	tick();
	const handle = setInterval(tick, PROGRESS_FRAME_INTERVAL_MS);
	if (typeof handle === "object" && handle !== null && "unref" in handle) {
		try {
			(handle as { unref(): void }).unref();
		} catch {
			/* unref is best-effort; not all runtimes expose it */
		}
	}

	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(handle as unknown as ReturnType<typeof setInterval>);
		if (typeof setWidget === "function") {
			try {
				setWidget(PROGRESS_WIDGET_KEY, undefined);
			} catch {
				/* clearing the widget is best-effort */
			}
		}
		setStatus(ctx, "genesis ready");
	};
}

function relativeToCwd(cwd: string, targetPath: string): string {
	const relative = path.relative(cwd, targetPath) || ".";
	return normalizePathSeparators(relative);
}

// ---------------------------------------------------------------------------
// authorMindOnce — module-level single-mind authoring used by /assembly (and
// any future caller that needs end-to-end authoring as a callable primitive).
//
// Mirrors the spawn → parse → write → audit pipeline of
// startGenesisAuthoringRequest but returns a structured result instead of
// driving UI directly. The existing /genesis flow continues to use
// startGenesisAuthoringRequest for its richer progress-widget UX.
// ---------------------------------------------------------------------------

export interface AuthorMindFields {
	name: string;
	role: string;
	voice: string;
	voiceDescription: string;
	slug?: string;
	source?: string;
}

export interface AuthorMindOnceResult {
	ok: boolean;
	slug: string;
	mindPath?: string;
	shimPath?: string;
	error?: string;
	durationMs: number;
}

type AppendEntryFn = (
	stream: string,
	entry: Record<string, unknown>,
) => void;

export async function authorMindOnce(
	fields: AuthorMindFields,
	config: GenesisConfig,
	cwd: string,
	spawnSubagent: SpawnGenesisFn,
	appendEntry: AppendEntryFn,
): Promise<AuthorMindOnceResult> {
	const startedAt = Date.now();
	const fail = (slug: string, error: string): AuthorMindOnceResult => ({
		ok: false,
		slug,
		error,
		durationMs: Date.now() - startedAt,
	});

	const name = fields.name.trim();
	const role = fields.role.trim() || config.defaultRole;
	const voice = fields.voice.trim() || config.defaultVoice;
	const voiceDescription = fields.voiceDescription.trim();
	const slug = fields.slug?.trim() || slugify(name);
	if (!slug) {
		return fail("", "name must contain at least one ASCII letter or number");
	}

	let paths;
	try {
		paths = resolveGenesisPaths(cwd, slug, config);
		assertGenesisPathsInsideProject(paths);
	} catch (error) {
		return fail(slug, `path configuration invalid: ${errorMessage(error)}`);
	}

	if (existsSync(paths.mindPath)) {
		return fail(
			slug,
			`mind directory already exists: ${relativeToCwd(paths.cwd, paths.mindPath)}`,
		);
	}
	if (existsSync(paths.shimPath)) {
		return fail(
			slug,
			`shim already exists: ${relativeToCwd(paths.cwd, paths.shimPath)}`,
		);
	}

	try {
		createMindStructure(paths);
		seedSharedDoctrine(paths);
	} catch (error) {
		return fail(slug, `scaffold failed: ${errorMessage(error)}`);
	}

	if (config.seedLensViews) {
		try {
			const observatoryConfig = loadObservatoryConfig(paths.cwd);
			const lensesRoot = resolveLensesRoot(paths.cwd, observatoryConfig);
			scaffoldNewspaper(lensesRoot, slug);
		} catch {
			/* non-fatal: operator can author the lens manually */
		}
	}

	const requestId = randomUUID();
	const prompt = buildGenesisSubagentAuthoringPrompt({
		requestId,
		name,
		slug,
		role,
		voiceDescription,
		paths,
	});

	let spawnResult: SpawnGenesisResult;
	try {
		spawnResult = await spawnSubagent({ slug, prompt, cwd: paths.cwd });
	} catch (error) {
		return fail(slug, `subagent spawn failed: ${errorMessage(error)}`);
	}

	if (spawnResult.aborted) {
		return fail(slug, "subagent was aborted");
	}
	if (spawnResult.exitCode !== 0) {
		const detail = spawnResult.stderr.trim()
			? ` Stderr: ${spawnResult.stderr.trim().slice(0, 400)}`
			: "";
		return fail(slug, `subagent exit ${spawnResult.exitCode}.${detail}`);
	}

	let parsed: GenesisAuthoringContent;
	try {
		parsed = parseGenesisAuthoringJson(spawnResult.finalText);
	} catch (error) {
		return fail(slug, `subagent JSON parse failed: ${errorMessage(error)}`);
	}

	const description = collapseOneLine(parsed.description);
	if (parsed.agentInstructions.startsWith("---")) {
		return fail(
			slug,
			"agentInstructions must not start with YAML frontmatter",
		);
	}

	const shim = buildAgentShim({
		name,
		slug,
		description,
		agentInstructions: parsed.agentInstructions,
		paths,
	});

	try {
		writeFileSync(paths.soulPath, ensureTrailingNewline(parsed.soul), "utf-8");
		writeFileSync(
			paths.mindIndexPath,
			ensureTrailingNewline(parsed.mindIndex),
			"utf-8",
		);
		writeFileSync(
			paths.memoryPath,
			ensureTrailingNewline(parsed.memory),
			"utf-8",
		);
		writeFileSync(
			paths.rulesPath,
			ensureTrailingNewline(parsed.rules),
			"utf-8",
		);
		writeFileSync(paths.logPath, ensureTrailingNewline(parsed.log), "utf-8");
		writeFileSync(paths.shimPath, ensureTrailingNewline(shim), "utf-8");
	} catch (error) {
		return fail(slug, `write failed: ${errorMessage(error)}`);
	}

	const validation = validateMind(paths);
	if (!validation.ok) {
		return fail(slug, `validation failed: ${validation.errors.join("; ")}`);
	}

	appendEntry("genesis", {
		slug,
		...(fields.source ? { source: fields.source } : {}),
		mindPath: relativeToCwd(paths.cwd, paths.mindPath),
		shimPath: relativeToCwd(paths.cwd, paths.shimPath),
		createdAt: new Date().toISOString(),
	});

	return {
		ok: true,
		slug,
		mindPath: relativeToCwd(paths.cwd, paths.mindPath),
		shimPath: relativeToCwd(paths.cwd, paths.shimPath),
		durationMs: Date.now() - startedAt,
	};
}

// ---------------------------------------------------------------------------
// removeMindOnce — module-level inverse of authorMindOnce. Used by /assembly
// adjourn to take down a mind cleanly: deletes the mind directory, the shim,
// and the per-mind newspaper lens. Idempotent (missing files are no-ops).
// Appends a single audit entry under the `genesis` stream with action: "remove".
// ---------------------------------------------------------------------------

export interface RemoveMindOnceResult {
	ok: boolean;
	slug: string;
	removed: {
		mind: boolean;
		shim: boolean;
		newspaper: boolean;
	};
	error?: string;
	/**
	 * Lens-removal error, if any. Non-fatal — `ok` stays true even when this is
	 * set. Surfaces silent failures so callers can include them in summaries.
	 */
	newspaperError?: string;
	durationMs: number;
}

export interface RemoveMindOptions {
	/** Reason for removal; recorded in the audit entry. */
	source?: string;
}

export async function removeMindOnce(
	slug: string,
	cwd: string,
	config: GenesisConfig,
	appendEntry: AppendEntryFn,
	options: RemoveMindOptions = {},
): Promise<RemoveMindOnceResult> {
	const startedAt = Date.now();
	const fail = (error: string): RemoveMindOnceResult => ({
		ok: false,
		slug,
		removed: { mind: false, shim: false, newspaper: false },
		error,
		durationMs: Date.now() - startedAt,
	});

	const trimmed = slug?.trim();
	if (!trimmed) {
		return fail("slug must contain at least one ASCII letter or number");
	}

	let paths;
	try {
		paths = resolveGenesisPaths(cwd, trimmed, config);
		assertGenesisPathsInsideProject(paths);
	} catch (error) {
		return fail(`path configuration invalid: ${errorMessage(error)}`);
	}

	const removed = { mind: false, shim: false, newspaper: false };

	try {
		if (existsSync(paths.mindPath)) {
			rmSync(paths.mindPath, { recursive: true, force: true });
			removed.mind = true;
		}
	} catch (error) {
		return fail(`failed to remove mind directory: ${errorMessage(error)}`);
	}

	try {
		if (existsSync(paths.shimPath)) {
			rmSync(paths.shimPath, { force: true });
			removed.shim = true;
		}
	} catch (error) {
		return fail(`failed to remove shim: ${errorMessage(error)}`);
	}

	let newspaperError: string | undefined;
	try {
		const observatoryConfig = loadObservatoryConfig(paths.cwd);
		const lensesRoot = resolveLensesRoot(paths.cwd, observatoryConfig);
		const lensResult = removeNewspaperLens(lensesRoot, trimmed);
		removed.newspaper = lensResult.removed;
	} catch (error) {
		newspaperError = errorMessage(error);
	}

	try {
		appendEntry("genesis", {
			action: "remove",
			slug: trimmed,
			...(options.source ? { source: options.source } : {}),
			removed,
			...(newspaperError ? { newspaperError } : {}),
			removedAt: new Date().toISOString(),
		});
	} catch {
		/* audit is best-effort */
	}

	return {
		ok: true,
		slug: trimmed,
		removed,
		...(newspaperError ? { newspaperError } : {}),
		durationMs: Date.now() - startedAt,
	};
}

function normalizePathSeparators(value: string): string {
	return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
