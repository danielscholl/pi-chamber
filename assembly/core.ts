// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import { existsSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import path from "node:path";
import {
	ExtensionEditorComponent,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { type GenesisConfig, loadGenesisConfig } from "../genesis/core.ts";
import type {
	AuthorMindFields,
	AuthorMindOnceResult,
} from "../genesis/index.ts";
import {
	type AssembleProposal,
	type AssembleProposalInput,
	type AssembleProposalMember,
	buildAssembleProposalPrompt,
	parseAssembleProposalJson,
} from "./prompts.ts";
import {
	collectRepoSignals,
	type RepoSignals,
} from "./signals.ts";
import type { SpawnGenesisFn } from "../genesis/spawn.ts";
import { listGenesisMinds } from "../mind/core.ts";
import {
	loadObservatoryConfig,
	resolveLensesRoot,
	scaffoldTeamStatusBoard,
} from "../observatory/core.ts";
import {
	resolveSavedRoomPaths,
	type SavedRoom,
	writeSavedRoom,
} from "../room/core.ts";
import { mapWithConcurrencyLimit } from "../room/spawn.ts";
import {
	createTransientPanel,
	notify,
	startWorkingPanel,
} from "../shared/notice.ts";
import {
	parseProposalFromToml,
	serializeProposalToToml,
} from "./proposal-toml.ts";

export const ASSEMBLE_BATCH_CONCURRENCY = 3;
export const ASSEMBLE_PROGRESS_WIDGET_KEY = "genesis-assemble-progress";
export const ASSEMBLE_PANEL_WIDGET_KEY = "assembly-panel";

// Transient panel for multi-line /assembly content: signals summary, the
// team proposal preview during the confirmation loop, and the final
// authoring recap. 60s TTL is a generous safety net — successive emits with
// the same widgetKey replace prior content immediately, and exit paths
// dismiss explicitly. The TTL only matters if the flow crashes silently.
const emitAssemblyPanel = createTransientPanel({
	widgetKey: ASSEMBLE_PANEL_WIDGET_KEY,
	ttlMs: 60000,
	placement: "aboveEditor",
});

// Phrases rotated through the working panel while the proposer subagent is
// running. Loose-narrative ordering — "convening" first since the user just
// triggered /assembly, then drifting toward the artifacts the proposer is
// shaping. Order is loose; the widget rotates by elapsed time, not phase.
const ASSEMBLE_PROGRESS_PHRASES = [
	"convening casting",
	"consulting the universe",
	"drafting roster",
	"weighing roles",
	"naming faces",
	"shaping rationale",
] as const;

export const ASSEMBLE_OPEN_FLOOR_DEFAULTS = {
	maxTurns: 6,
	minRounds: 1,
	maxSpeakerRepeats: 2,
	endVoteThreshold: 0.5,
} as const;

export interface AssembleArgs {
	mode: "convene" | "adjourn";
	adjournSlug?: string;
	description?: string;
	size?: number;
	universe?: string;
	noUniverse: boolean;
	scanOnly: boolean;
}

export interface AssembleCommandContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, value: string): void;
		select?(prompt: string, options: string[]): Promise<string | undefined>;
		input?(title: string, placeholder?: string): Promise<string | undefined>;
		setWidget?(
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		/**
		 * Renders a custom focusable component (used for the proposal review
		 * overlay). Mirrors pi-tui's ExtensionUIContext shape; we accept the
		 * factory generically so the assembly layer doesn't have to import
		 * pi-tui types directly.
		 */
		custom?<T>(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: {
				overlay?: boolean;
				overlayOptions?: Record<string, unknown>;
			},
		): Promise<T>;
	};
	waitForIdle?(): Promise<void>;
}

export type AuthorMindFn = (
	fields: AuthorMindFields,
	config: GenesisConfig,
	cwd: string,
) => Promise<AuthorMindOnceResult>;

export interface AssembleDeps {
	pi: ExtensionAPI;
	spawnSubagent: SpawnGenesisFn;
	authorMind: AuthorMindFn;
}

interface MemberAuthoringResult {
	member: AssembleProposalMember;
	result: AuthorMindOnceResult;
}

type SetWidgetFn = (
	key: string,
	content: string[] | undefined,
	options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

// ---------------------------------------------------------------------------
// /assembly entry point
// ---------------------------------------------------------------------------

export async function runAssembleCommand(
	rawArgs: string,
	ctx: AssembleCommandContext,
	deps: AssembleDeps,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"/assembly requires interactive UI. Run it from a Pi session with UI enabled.",
			"error",
		);
		return;
	}

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

	const args = parseAssembleArgs(rawArgs);
	setStatus(ctx, "assembling: reading signals…");

	let signals: RepoSignals;
	try {
		signals = collectRepoSignals(ctx.cwd, { description: args.description });
	} catch (error) {
		setStatus(ctx, "genesis ready");
		notify(
			ctx,
			`Repo signal collection failed: ${errorMessage(error)}`,
			"error",
		);
		return;
	}

	if (
		!signals.description &&
		!signals.readme &&
		!signals.agentsMd &&
		!signals.claudeMd &&
		!signals.manifest
	) {
		// Empty workspace + no description — prompt the user inline rather
		// than hard-erroring. We prefer ctx.ui.custom so the wizard supports
		// multi-line text + paste with preserved newlines (matters when
		// users paste a structured prompt or a bullet list). Falls back to
		// single-line ctx.ui.input for runtimes that don't expose custom
		// overlays. Hard error if neither path is available.
		setStatus(ctx, "assembling: awaiting description…");
		const typed = await promptForDescription(ctx);
		if (typed === null) {
			// No UI path available — surface the original error so headless
			// callers see the recourses spelled out.
			setStatus(ctx, "genesis ready");
			notify(ctx, renderEmptySignalsError(ctx.cwd), "error");
			return;
		}
		if (!typed) {
			setStatus(ctx, "genesis ready");
			notify(ctx, "Assembly cancelled.", "info");
			return;
		}
		// Re-run signal collection with the supplied description. The other
		// signal fields are still empty, but the proposer has something to
		// ground the proposal in.
		try {
			signals = collectRepoSignals(ctx.cwd, { description: typed });
		} catch (error) {
			setStatus(ctx, "genesis ready");
			notify(
				ctx,
				`Repo signal collection failed: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
	}

	// Animate the working panel during the proposer call. Spinner + rotating
	// phrase + elapsed seconds in the header; compressed signals footer for
	// context. Stops on success or error and clears the widget so the
	// proposal panel takes over cleanly.
	const stopProgress = startWorkingPanel(ctx, {
		widgetKey: ASSEMBLE_PANEL_WIDGET_KEY,
		label: "assembly",
		phrases: ASSEMBLE_PROGRESS_PHRASES,
		footer: [renderSignalsFooter(signals)],
		placement: "aboveEditor",
	});

	setStatus(ctx, "assembling: convening casting…");
	let proposal: AssembleProposal;
	try {
		proposal = await proposeTeam(
			signals,
			args,
			undefined,
			undefined,
			ctx.cwd,
			deps.spawnSubagent,
		);
	} catch (error) {
		stopProgress();
		setStatus(ctx, "genesis ready");
		notify(ctx, `Team proposer failed: ${errorMessage(error)}`, "error");
		return;
	}

	// Proposer returned. Stop the ticker (clears the widget) before the
	// proposal panel takes over so the two views don't compete for the slot.
	stopProgress();

	const approved = await runConfirmationLoop(proposal, ctx);
	if (!approved) {
		emitAssemblyPanel(ctx, undefined);
		setStatus(ctx, "genesis ready");
		notify(ctx, "Team assembly cancelled. No files were written.", "info");
		return;
	}

	let validated: AssembleProposal;
	try {
		validated = validateProposalForAuthoring(approved, ctx.cwd, config);
	} catch (error) {
		emitAssemblyPanel(ctx, undefined);
		setStatus(ctx, "genesis ready");
		notify(ctx, `Cannot author team: ${errorMessage(error)}`, "error");
		return;
	}

	setStatus(ctx, "assembling: authoring members…");
	const authoringResults = await authorTeamMembers(
		validated,
		ctx,
		config,
		deps.authorMind,
	);

	const succeeded = authoringResults.filter((r) => r.result.ok);
	const failed = authoringResults.filter((r) => !r.result.ok);

	if (succeeded.length === 0) {
		setStatus(ctx, "genesis ready");
		emitAssemblyPanel(
			ctx,
			renderAuthoringSummary(validated, succeeded, failed, undefined, undefined),
		);
		appendAssembleAudit(deps.pi, validated, {
			succeeded: [],
			failed: failed.map((f) => f.member.slug),
		});
		return;
	}

	const succeededMembers = succeeded.map((r) => r.member);
	let savedRoom: SavedRoom | undefined;
	try {
		savedRoom = saveTeamRoom(
			ctx.cwd,
			validated,
			succeededMembers.map((m) => m.slug),
		);
	} catch (error) {
		notify(
			ctx,
			`Could not save team room: ${errorMessage(error)}`,
			"warning",
		);
	}

	let lensResult: { lensSlug: string; created: boolean } | undefined;
	try {
		const lens = saveTeamLens(ctx.cwd, validated, succeededMembers);
		lensResult = { lensSlug: lens.lensSlug, created: lens.created };
	} catch (error) {
		notify(
			ctx,
			`Could not save team lens: ${errorMessage(error)}`,
			"warning",
		);
	}

	appendAssembleAudit(deps.pi, validated, {
		succeeded: succeededMembers.map((m) => m.slug),
		failed: failed.map((f) => f.member.slug),
	});

	setStatus(ctx, "genesis ready");
	emitAssemblyPanel(
		ctx,
		renderAuthoringSummary(validated, succeeded, failed, savedRoom, lensResult),
	);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseAssembleArgs(raw: string): AssembleArgs {
	const args: AssembleArgs = {
		mode: "convene",
		noUniverse: false,
		scanOnly: false,
	};
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return args;

	const tokens = tokenize(trimmed);

	// Adjourn subcommand: first non-flag token is exactly "adjourn".
	// Optional second positional becomes the team slug. Anything beyond is
	// ignored (slugs are single tokens; we don't attempt to combine them).
	// Slugs are canonical lowercase; we lowercase here so users can type
	// `adjourn ASSEMBLY` without getting a confusing "no saved room" error.
	if (tokens.length > 0 && tokens[0] === "adjourn") {
		args.mode = "adjourn";
		if (tokens[1] && !tokens[1].startsWith("--")) {
			args.adjournSlug = tokens[1].toLowerCase();
		}
		return args;
	}

	const remaining: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--no-universe") {
			args.noUniverse = true;
			continue;
		}
		if (token === "--scan") {
			args.scanOnly = true;
			continue;
		}
		if (token.startsWith("--size=")) {
			const value = token.slice("--size=".length);
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
				args.size = parsed;
			}
			continue;
		}
		if (token === "--size") {
			const next = tokens[i + 1];
			if (next) {
				const parsed = Number.parseInt(next, 10);
				if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
					args.size = parsed;
				}
				i++;
			}
			continue;
		}
		if (token.startsWith("--universe=")) {
			const value = token.slice("--universe=".length).trim();
			if (value) args.universe = value;
			continue;
		}
		if (token === "--universe") {
			const next = tokens[i + 1];
			if (next) {
				const value = next.trim();
				if (value) args.universe = value;
				i++;
			}
			continue;
		}
		remaining.push(token);
	}
	if (remaining.length > 0) {
		args.description = remaining.join(" ").trim() || undefined;
	}
	return args;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | "" = "";
	for (const char of input) {
		if (quote) {
			if (char === quote) {
				quote = "";
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

// ---------------------------------------------------------------------------
// Proposal generation (subagent call)
// ---------------------------------------------------------------------------

export const ASSEMBLE_DEFAULT_TEAM_SLUG = "assembly";
export const ASSEMBLE_DEFAULT_TEAM_NAME = "Assembly";

async function proposeTeam(
	signals: RepoSignals,
	args: AssembleArgs,
	feedback: string | undefined,
	previous: AssembleProposal | undefined,
	cwd: string,
	spawnSubagent: SpawnGenesisFn,
	options: { lockMetadata?: boolean } = {},
): Promise<AssembleProposal> {
	// When the user has manually edited team metadata, suppress both the prompt
	// directive and the post-parse override so a regenerate doesn't quietly
	// undo their choice.
	const defaultTeamSlug = options.lockMetadata
		? undefined
		: isDefaultTeamSlugAvailable(cwd)
			? ASSEMBLE_DEFAULT_TEAM_SLUG
			: undefined;

	const input: AssembleProposalInput = {
		signals,
		sizeOverride: args.size,
		universeOverride: args.universe,
		noUniverse: args.noUniverse,
		feedback,
		previousProposal: previous,
		defaultTeamSlug,
	};
	const prompt = buildAssembleProposalPrompt(input);
	const result = await spawnSubagent({
		slug: "assemble-proposer",
		prompt,
		cwd,
	});
	if (result.aborted) {
		throw new Error("Team proposer was aborted.");
	}
	if (result.exitCode !== 0) {
		const detail = result.stderr.trim()
			? ` Stderr: ${result.stderr.trim().slice(0, 400)}`
			: "";
		throw new Error(
			`Team proposer exited with code ${result.exitCode}.${detail}`,
		);
	}
	const proposal = parseAssembleProposalJson(result.finalText);

	// Belt-and-suspenders override only fires when the proposer also chose a
	// generic team_name. If it picked a contextual name (e.g. "Strike Team"),
	// treat that as a deliberate signal that the project demands a contextual
	// slug — respect it, even though the prompt asked for `assembly`.
	if (defaultTeamSlug && proposal.team_slug !== defaultTeamSlug) {
		const proposedName = proposal.team_name?.trim() ?? "";
		const isGenericName =
			!proposedName ||
			proposedName.toLowerCase() ===
				ASSEMBLE_DEFAULT_TEAM_NAME.toLowerCase();
		if (isGenericName && isDefaultTeamSlugAvailable(cwd)) {
			return {
				...proposal,
				team_slug: defaultTeamSlug,
				team_name: ASSEMBLE_DEFAULT_TEAM_NAME,
			};
		}
	}
	return proposal;
}

function isDefaultTeamSlugAvailable(cwd: string): boolean {
	try {
		const { roomDir } = resolveSavedRoomPaths(
			cwd,
			ASSEMBLE_DEFAULT_TEAM_SLUG,
		);
		return !existsSync(roomDir);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Confirmation loop UX
// ---------------------------------------------------------------------------

// Open the same ExtensionEditorComponent we use for the description prompt,
// prefilled with the generated proposal serialized as TOML. The user edits
// freely (paste, multi-line) and submits to author or cancels to abandon.
// On parse/validation error we notify and reopen with their text intact so
// no edits are lost.
async function runConfirmationLoop(
	initial: AssembleProposal,
	ctx: AssembleCommandContext,
): Promise<AssembleProposal | undefined> {
	const customRender = ctx.ui.custom;
	if (!customRender) {
		notify(
			ctx,
			"UI does not support overlays; cannot review proposal.",
			"error",
		);
		return undefined;
	}

	let prefill = serializeProposalToToml(initial);
	while (true) {
		const submitted = await customRender<string | undefined>(
			(tui, _theme, keybindings, done) => {
				let settled = false;
				const finish = (result: string | undefined) => {
					if (settled) return;
					settled = true;
					done(result);
				};
				const editor = new ExtensionEditorComponent(
					tui as TUI,
					keybindings as KeybindingsManager,
					"Review proposal — edit and submit, or esc to cancel",
					prefill,
					(text) => finish(text),
					() => finish(undefined),
				);
				const c = editor.children;
				editor.children = [c[0], c[2], c[4], c[c.length - 1]];
				// pi-tui's Editor caps its visible viewport at 30% of
				// terminal.rows (editor.js, hardcoded). For a 30-50 line TOML
				// proposal that's only ~10-15 visible lines and the rest of
				// the 95% overlay is empty padding. Proxy the inner editor's
				// `tui.terminal.rows` to report 2.5x the real value — that
				// brings the effective cap to ~75% of the real terminal,
				// leaving room inside the 95% overlay for the title, both
				// borders, and the editor's own top/bottom rule lines.
				const innerEditor = c[4] as { tui?: TUI };
				if (innerEditor.tui) {
					const realTui = innerEditor.tui;
					innerEditor.tui = new Proxy(realTui, {
						get(target, prop, receiver) {
							if (prop === "terminal") {
								const t = (target as { terminal: object }).terminal;
								return new Proxy(t, {
									get(inner, p) {
										if (p === "rows") {
											const real = Reflect.get(inner, p);
											return typeof real === "number"
												? Math.floor(real * 2.5)
												: 60;
										}
										return Reflect.get(inner, p);
									},
								});
							}
							return Reflect.get(target, prop, receiver);
						},
					}) as TUI;
				}
				return editor;
			},
			{
				// Proposal TOML is long (~30-50 lines); render as a near-fullscreen
				// centered overlay instead of inline so the user can see the whole
				// thing without scrolling.
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "95%",
					maxHeight: "95%",
				},
			},
		);
		if (submitted === undefined) return undefined;
		const parsed = parseProposalFromToml(submitted);
		if (parsed.ok) return parsed.proposal;
		notify(ctx, `Proposal invalid: ${parsed.error}`, "error");
		prefill = submitted;
	}
}

// ---------------------------------------------------------------------------
// Pre-author validation
// ---------------------------------------------------------------------------

export function validateProposalForAuthoring(
	proposal: AssembleProposal,
	cwd: string,
	config: GenesisConfig,
): AssembleProposal {
	let existing: string[];
	try {
		existing = listGenesisMinds(cwd, config);
	} catch {
		existing = [];
	}
	const existingSet = new Set(existing);
	const seenSlugs = new Set<string>();
	for (const m of proposal.members) {
		if (existingSet.has(m.slug)) {
			throw new Error(
				`Member slug "${m.slug}" collides with an existing mind. Edit or regenerate.`,
			);
		}
		if (seenSlugs.has(m.slug)) {
			throw new Error(`Duplicate slug in proposal: "${m.slug}".`);
		}
		seenSlugs.add(m.slug);
	}

	let roomDir: string;
	try {
		roomDir = resolveSavedRoomPaths(cwd, proposal.team_slug).roomDir;
	} catch (error) {
		throw new Error(
			`Team slug "${proposal.team_slug}" is not a valid room slug: ${errorMessage(error)}`,
		);
	}
	if (existsSync(roomDir)) {
		throw new Error(
			`Team slug "${proposal.team_slug}" already exists as a saved room. Edit or regenerate.`,
		);
	}
	return proposal;
}

// ---------------------------------------------------------------------------
// Batch authoring
// ---------------------------------------------------------------------------

// Spinner + phrase pair mirrors /genesis's startGenesisProgress so the team
// authoring view feels of-a-piece with single-mind authoring. /assembly
// runs N copies of /genesis under the hood; surfacing the same animation
// per row makes that lineage obvious to the operator.
const AUTHORING_SPINNER_FRAMES = [
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
] as const;
const AUTHORING_BIRTH_PHRASES = [
	"drafting soul",
	"writing memory",
	"encoding rules",
	"indexing knowledge",
	"awaiting genesis",
] as const;
const AUTHORING_FRAME_INTERVAL_MS = 120;
const AUTHORING_PHRASE_INTERVAL_MS = 1800;

async function authorTeamMembers(
	proposal: AssembleProposal,
	ctx: AssembleCommandContext,
	config: GenesisConfig,
	authorMind: AuthorMindFn,
): Promise<MemberAuthoringResult[]> {
	const total = proposal.members.length;
	const states: Array<"queued" | "running" | "done" | "failed"> = new Array(total).fill("queued");
	const elapsed: number[] = new Array(total).fill(0);
	const startedAt: Array<number | undefined> = new Array(total).fill(undefined);
	let frame = 0;

	const setWidget = (ctx.ui as { setWidget?: SetWidgetFn }).setWidget;

	const renderProgress = () => {
		const spinner =
			AUTHORING_SPINNER_FRAMES[frame % AUTHORING_SPINNER_FRAMES.length] ??
			"·";
		const lines = ["assembling team:"];
		for (let i = 0; i < total; i++) {
			const m = proposal.members[i];
			const status = states[i];
			let glyph: string;
			let tail: string;
			if (status === "done") {
				glyph = "✓";
				tail = `${(elapsed[i] / 1000).toFixed(1)}s`;
			} else if (status === "failed") {
				glyph = "✕";
				tail = "failed";
			} else if (status === "running") {
				glyph = spinner;
				const since =
					startedAt[i] !== undefined
						? Math.floor((Date.now() - (startedAt[i] ?? 0)) / 1000)
						: 0;
				const phraseIndex =
					Math.floor(
						(Date.now() - (startedAt[i] ?? Date.now())) /
							AUTHORING_PHRASE_INTERVAL_MS,
					) % AUTHORING_BIRTH_PHRASES.length;
				const phrase =
					AUTHORING_BIRTH_PHRASES[phraseIndex] ?? "drafting soul";
				tail = `${phrase}… ${since}s`;
			} else {
				glyph = "◌";
				tail = "queued";
			}
			lines.push(
				`  ${glyph} ${m.name} (${m.slug}) — ${m.role}  ${tail}`,
			);
		}
		return lines;
	};

	const updateWidget = () => {
		if (typeof setWidget !== "function") return;
		try {
			setWidget(ASSEMBLE_PROGRESS_WIDGET_KEY, renderProgress(), {
				placement: "aboveEditor",
			});
		} catch {
			/* widget updates are best-effort */
		}
	};

	// Frame ticker keeps the spinner moving and the elapsed counter ticking
	// while members are running. We don't gate it on "any running" — it's
	// cheap and the per-row glyph picks the right state. unref() so a long
	// tick doesn't keep the process alive on shutdown.
	let ticker: ReturnType<typeof setInterval> | undefined;
	const startTicker = () => {
		if (ticker || typeof setWidget !== "function") return;
		ticker = setInterval(() => {
			frame += 1;
			updateWidget();
		}, AUTHORING_FRAME_INTERVAL_MS);
		(ticker as { unref?: () => void }).unref?.();
	};
	const stopTicker = () => {
		if (ticker) {
			clearInterval(ticker);
			ticker = undefined;
		}
	};

	updateWidget();
	startTicker();

	let results: MemberAuthoringResult[];
	try {
		results = await mapWithConcurrencyLimit(
			proposal.members,
			ASSEMBLE_BATCH_CONCURRENCY,
			async (member, idx): Promise<MemberAuthoringResult> => {
				states[idx] = "running";
				startedAt[idx] = Date.now();
				updateWidget();
				const memberStartedAt = Date.now();
				let result: AuthorMindOnceResult;
				try {
					result = await authorMind(
						{
							name: member.name,
							role: member.role,
							voice: member.voice,
							voiceDescription: member.voiceDescription,
							slug: member.slug,
							source: `assemble:${proposal.team_slug}`,
						},
						config,
						ctx.cwd,
					);
				} catch (error) {
					result = {
						ok: false,
						slug: member.slug,
						error: errorMessage(error),
						durationMs: Date.now() - memberStartedAt,
					};
				}
				elapsed[idx] = result.durationMs;
				states[idx] = result.ok ? "done" : "failed";
				updateWidget();
				return { member, result };
			},
		);
	} finally {
		stopTicker();
	}

	if (typeof setWidget === "function") {
		try {
			setWidget(ASSEMBLE_PROGRESS_WIDGET_KEY, undefined);
		} catch {
			/* clear is best-effort */
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveTeamRoom(
	cwd: string,
	proposal: AssembleProposal,
	authoredSlugs: string[],
): SavedRoom {
	const now = new Date().toISOString();
	const room: SavedRoom = {
		slug: proposal.team_slug,
		name: proposal.team_name,
		mode: "open-floor",
		participants: authoredSlugs,
		createdAt: now,
		updatedAt: now,
		openFloor: { ...ASSEMBLE_OPEN_FLOOR_DEFAULTS },
		opener: "chairman",
		synthesizer: "chairman",
		assembledBy: "assembly",
	};
	return writeSavedRoom(cwd, room);
}

function saveTeamLens(
	cwd: string,
	proposal: AssembleProposal,
	members: AssembleProposalMember[],
): { lensSlug: string; created: boolean } {
	const observatoryConfig = loadObservatoryConfig(cwd);
	const lensesRoot = resolveLensesRoot(cwd, observatoryConfig);
	const result = scaffoldTeamStatusBoard(
		lensesRoot,
		proposal.team_slug,
		members.map((m) => ({ slug: m.slug, role: m.role })),
	);
	return { lensSlug: result.lensSlug, created: result.created };
}

function appendAssembleAudit(
	pi: ExtensionAPI,
	proposal: AssembleProposal,
	results: { succeeded: string[]; failed: string[] },
): void {
	try {
		pi.appendEntry("genesis-assemble", {
			teamSlug: proposal.team_slug,
			teamName: proposal.team_name,
			universe: proposal.universe,
			project: proposal.project,
			succeeded: results.succeeded,
			failed: results.failed,
			createdAt: new Date().toISOString(),
		});
	} catch {
		/* audit is best-effort */
	}
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

// Built when the signal scan returned nothing usable. Surfaces the cwd Pi
// actually scanned so the operator can tell "wrong directory" apart from a
// genuine missing-files case, and lists the recourse paths inline.
function renderEmptySignalsError(cwd: string): string {
	return [
		`No project description and no readable signals in ${cwd}.`,
		"Looked for: README.md, AGENTS.md, CLAUDE.md, or a manifest (package.json, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle[.kts], Gemfile, composer.json).",
		'Either run /assembly from the project root, or pass a description: /assembly "what you\'re building".',
	].join(" ");
}

// One-line signal recap shown as the static footer beneath the working
// panel's animated header during the proposer wait. Same data as
// renderSignalsSummary but compressed onto a single line so it doesn't
// crowd the spinner.
function renderSignalsFooter(signals: RepoSignals): string {
	const parts: string[] = [];
	if (signals.description) {
		parts.push(`description: ${truncate(signals.description, 60)}`);
	}
	if (signals.readme) parts.push("README.md");
	if (signals.agentsMd) parts.push("AGENTS.md");
	if (signals.claudeMd) parts.push("CLAUDE.md");
	if (signals.manifest) parts.push(signals.manifest.kind);
	if (signals.topLevelDirs.length > 0) {
		parts.push(`top-level dirs: ${signals.topLevelDirs.length}`);
	}
	if (signals.existingMinds.length > 0) {
		parts.push(
			`existing minds: ${signals.existingMinds.length} (${signals.existingMinds.map((m) => m.slug).join(", ")})`,
		);
	}
	return parts.length ? parts.join(" · ") : "(no signals)";
}

function renderAuthoringSummary(
	proposal: AssembleProposal,
	succeeded: MemberAuthoringResult[],
	failed: MemberAuthoringResult[],
	savedRoom: SavedRoom | undefined,
	lens: { lensSlug: string; created: boolean } | undefined,
): string[] {
	const lines: string[] = [];
	// Header carries severity. When nothing was authored, "ASSEMBLED" would be
	// misleading; surface "FAILED" so the panel header alone communicates the
	// outcome without needing a parallel error toast.
	lines.push(succeeded.length === 0 ? "TEAM ASSEMBLY FAILED" : "TEAM ASSEMBLED");
	lines.push(
		`  authored: ${succeeded.length}${succeeded.length ? ` (${succeeded.map((s) => s.member.slug).join(", ")})` : ""}`,
	);
	if (failed.length) {
		lines.push(`  failed:   ${failed.length}`);
		for (const f of failed) {
			lines.push(`    ${f.member.slug}: ${f.result.error ?? "unknown"}`);
		}
	}
	if (savedRoom) {
		lines.push(`  room:     .pi/rooms/${savedRoom.slug}/room.json (open-floor)`);
	}
	if (lens) {
		lines.push(`  lens:     .pi/observatory/lenses/${lens.lensSlug}/`);
	}
	if (succeeded.length > 0) {
		lines.push("");
		lines.push("NEXT");
		if (savedRoom) {
			lines.push(`  /room ${savedRoom.slug}`);
		}
		if (succeeded[0]) {
			lines.push(`  /mind ${succeeded[0].member.slug}`);
		}
		lines.push("  /observatory");
	}
	return lines;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function setStatus(ctx: AssembleCommandContext, value: string): void {
	if (!ctx.hasUI) return;
	const setter = ctx.ui.setStatus;
	if (typeof setter !== "function") return;
	try {
		setter.call(ctx.ui, "genesis", value);
	} catch {
		/* status updates are best-effort */
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Returns the trimmed description, or undefined if the user cancelled.
// Returns null when no UI path is available — caller surfaces the
// renderEmptySignalsError fallback.
async function promptForDescription(
	ctx: AssembleCommandContext,
): Promise<string | undefined | null> {
	const customRender = ctx.ui.custom;
	if (customRender) {
		const typed = await customRender<string | undefined>(
			(tui, _theme, keybindings, done) => {
				let settled = false;
				const finish = (result: string | undefined) => {
					if (settled) return;
					settled = true;
					done(result);
				};
				const editor = new ExtensionEditorComponent(
					tui as TUI,
					keybindings as KeybindingsManager,
					"What are you building?",
					undefined,
					(text) => finish(text.trim() || undefined),
					() => finish(undefined),
				);
				// ExtensionEditorComponent's default chrome is:
				//   [border, spacer, title, spacer, editor, spacer, hint, spacer, border]
				// For the empty-signals prompt we want a tight chat-style
				// input: keep the borders + title + editor; drop the four
				// spacers and the hint footer (Enter/Shift+Enter/Esc behave
				// the way users expect from any chat input).
				const c = editor.children;
				editor.children = [c[0], c[2], c[4], c[c.length - 1]];
				return editor;
			},
			{ overlay: false },
		);
		return typed?.trim() || undefined;
	}
	const inputFn = ctx.ui.input;
	if (inputFn) {
		const typed = (
			await inputFn.call(
				ctx.ui,
				"What are you building? (esc to cancel)",
				"",
			)
		)?.trim();
		return typed || undefined;
	}
	return null;
}
