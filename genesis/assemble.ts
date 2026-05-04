// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import { existsSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins.
// @ts-ignore
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type GenesisConfig,
	loadGenesisConfig,
	slugify,
} from "./core.ts";
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
import type { SpawnGenesisFn } from "./spawn.ts";
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

export const ASSEMBLE_BATCH_CONCURRENCY = 3;
export const ASSEMBLE_PROGRESS_WIDGET_KEY = "genesis-assemble-progress";

export const ASSEMBLE_OPEN_FLOOR_DEFAULTS = {
	maxTurns: 6,
	minRounds: 1,
	maxSpeakerRepeats: 2,
	endVoteThreshold: 0.5,
} as const;

export interface AssembleArgs {
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
	};
	waitForIdle?(): Promise<void>;
}

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
// /genesis:assemble entry point
// ---------------------------------------------------------------------------

export async function runAssembleCommand(
	rawArgs: string,
	ctx: AssembleCommandContext,
	deps: AssembleDeps,
): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"/genesis:assemble requires interactive UI. Run it from a Pi session with UI enabled.",
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
		setStatus(ctx, "genesis ready");
		notify(
			ctx,
			'No project description and no readable signals (README, AGENTS.md, CLAUDE.md, manifest). Try: /genesis:assemble "what you\'re building"',
			"error",
		);
		return;
	}

	notify(ctx, renderSignalsSummary(signals), "info");

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
		setStatus(ctx, "genesis ready");
		notify(ctx, `Team proposer failed: ${errorMessage(error)}`, "error");
		return;
	}

	const approved = await runConfirmationLoop(
		proposal,
		ctx,
		signals,
		args,
		deps.spawnSubagent,
	);
	if (!approved) {
		setStatus(ctx, "genesis ready");
		notify(ctx, "Team assembly cancelled. No files were written.", "info");
		return;
	}

	let validated: AssembleProposal;
	try {
		validated = validateProposalForAuthoring(approved, ctx.cwd, config);
	} catch (error) {
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
		notify(
			ctx,
			renderAuthoringSummary(validated, succeeded, failed, undefined, undefined),
			"error",
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
	notify(
		ctx,
		renderAuthoringSummary(validated, succeeded, failed, savedRoom, lensResult),
		failed.length ? "warning" : "info",
	);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseAssembleArgs(raw: string): AssembleArgs {
	const args: AssembleArgs = {
		noUniverse: false,
		scanOnly: false,
	};
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return args;

	const tokens = tokenize(trimmed);
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

async function proposeTeam(
	signals: RepoSignals,
	args: AssembleArgs,
	feedback: string | undefined,
	previous: AssembleProposal | undefined,
	cwd: string,
	spawnSubagent: SpawnGenesisFn,
): Promise<AssembleProposal> {
	const input: AssembleProposalInput = {
		signals,
		sizeOverride: args.size,
		universeOverride: args.universe,
		noUniverse: args.noUniverse,
		feedback,
		previousProposal: previous,
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
	return parseAssembleProposalJson(result.finalText);
}

// ---------------------------------------------------------------------------
// Confirmation loop UX
// ---------------------------------------------------------------------------

async function runConfirmationLoop(
	initial: AssembleProposal,
	ctx: AssembleCommandContext,
	signals: RepoSignals,
	args: AssembleArgs,
	spawnSubagent: SpawnGenesisFn,
): Promise<AssembleProposal | undefined> {
	let current: AssembleProposal = initial;
	while (true) {
		notify(ctx, renderProposal(current, signals), "info");
		const select = ctx.ui.select;
		if (!select) {
			notify(
				ctx,
				"UI does not support select; cannot confirm proposal.",
				"error",
			);
			return undefined;
		}
		const choice = await select.call(ctx.ui, "Team proposal:", [
			"Approve and author",
			"Drop a member",
			"Edit a member",
			"Regenerate",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") return undefined;
		if (choice === "Approve and author") return current;

		if (choice === "Drop a member") {
			if (current.members.length <= 1) {
				notify(
					ctx,
					"Cannot drop: team would be empty. Use Regenerate or Cancel instead.",
					"warning",
				);
				continue;
			}
			const dropChoice = await select.call(
				ctx.ui,
				"Drop which member?",
				current.members.map((m) => memberLabel(m)),
			);
			if (!dropChoice) continue;
			const idx = current.members.findIndex(
				(m) => memberLabel(m) === dropChoice,
			);
			if (idx >= 0) {
				const dropped = current.members[idx];
				current = {
					...current,
					members: current.members.filter((_, i) => i !== idx),
				};
				notify(ctx, `Dropped ${dropped.name} (${dropped.slug}).`, "info");
			}
			continue;
		}

		if (choice === "Edit a member") {
			const memberChoice = await select.call(
				ctx.ui,
				"Edit which member?",
				current.members.map((m) => memberLabel(m)),
			);
			if (!memberChoice) continue;
			const idx = current.members.findIndex(
				(m) => memberLabel(m) === memberChoice,
			);
			if (idx < 0) continue;
			const fieldChoice = await select.call(ctx.ui, "Edit which field?", [
				"name",
				"role",
				"voice",
				"voiceDescription",
				"Cancel",
			]);
			if (!fieldChoice || fieldChoice === "Cancel") continue;
			const input = ctx.ui.input;
			if (!input) {
				notify(ctx, "UI does not support input; cannot edit fields.", "error");
				continue;
			}
			const target = current.members[idx];
			const placeholder =
				(target as unknown as Record<string, string>)[fieldChoice] ?? "";
			const value = (await input.call(
				ctx.ui,
				`New ${fieldChoice}:`,
				placeholder,
			))?.trim();
			if (!value) {
				notify(ctx, "No change made.", "info");
				continue;
			}
			let updated: AssembleProposalMember = {
				...target,
				[fieldChoice]: value,
			} as AssembleProposalMember;
			if (fieldChoice === "name") {
				const newSlug = slugify(value);
				if (!newSlug) {
					notify(
						ctx,
						"Name must contain ASCII letters or numbers.",
						"warning",
					);
					continue;
				}
				const otherSlugs = new Set(
					current.members.filter((_, i) => i !== idx).map((m) => m.slug),
				);
				const existingSet = new Set(
					signals.existingMinds.map((m) => m.slug),
				);
				if (otherSlugs.has(newSlug)) {
					notify(
						ctx,
						`Slug "${newSlug}" already used in this proposal.`,
						"warning",
					);
					continue;
				}
				if (existingSet.has(newSlug)) {
					notify(
						ctx,
						`Slug "${newSlug}" collides with an existing mind.`,
						"warning",
					);
					continue;
				}
				updated = { ...updated, slug: newSlug };
			}
			const newMembers = current.members.slice();
			newMembers[idx] = updated;
			current = { ...current, members: newMembers };
			notify(ctx, `Updated ${fieldChoice}.`, "info");
			continue;
		}

		if (choice === "Regenerate") {
			const input = ctx.ui.input;
			const feedback = input
				? (
						await input.call(
							ctx.ui,
							"What should the next proposal do differently? (Enter to skip)",
							"",
						)
					)?.trim()
				: "";
			setStatus(ctx, "assembling: regenerating…");
			try {
				current = await proposeTeam(
					signals,
					args,
					feedback || undefined,
					current,
					ctx.cwd,
					spawnSubagent,
				);
			} catch (error) {
				notify(ctx, `Regenerate failed: ${errorMessage(error)}`, "error");
			}
			setStatus(ctx, "assembling: ready");
			continue;
		}
	}
}

function memberLabel(m: AssembleProposalMember): string {
	return `${m.name} (${m.slug}) — ${m.role}`;
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

async function authorTeamMembers(
	proposal: AssembleProposal,
	ctx: AssembleCommandContext,
	config: GenesisConfig,
	authorMind: AuthorMindFn,
): Promise<MemberAuthoringResult[]> {
	const total = proposal.members.length;
	const states: Array<"queued" | "running" | "done" | "failed"> = new Array(total).fill("queued");
	const elapsed: number[] = new Array(total).fill(0);

	const setWidget = (ctx.ui as { setWidget?: SetWidgetFn }).setWidget;
	const renderProgress = () => {
		const lines = ["assembling team:"];
		for (let i = 0; i < total; i++) {
			const m = proposal.members[i];
			const status = states[i];
			const tag =
				status === "done"
					? `done ${(elapsed[i] / 1000).toFixed(1)}s`
					: status === "failed"
						? "failed"
						: status === "running"
							? "…"
							: "queued";
			lines.push(`  [${tag}] ${m.name} (${m.slug}) — ${m.role}`);
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
	updateWidget();

	const results = await mapWithConcurrencyLimit(
		proposal.members,
		ASSEMBLE_BATCH_CONCURRENCY,
		async (member, idx): Promise<MemberAuthoringResult> => {
			states[idx] = "running";
			updateWidget();
			const startedAt = Date.now();
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
					durationMs: Date.now() - startedAt,
				};
			}
			elapsed[idx] = result.durationMs;
			states[idx] = result.ok ? "done" : "failed";
			updateWidget();
			return { member, result };
		},
	);

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

function renderSignalsSummary(signals: RepoSignals): string {
	const lines: string[] = ["Reading project signals"];
	if (signals.description) {
		lines.push(`  description: ${truncate(signals.description, 100)}`);
	}
	if (signals.readme) {
		lines.push(
			`  README.md (${signals.readme.content.length} chars${signals.readme.truncated ? ", truncated" : ""})`,
		);
	}
	if (signals.agentsMd) {
		lines.push(
			`  AGENTS.md (${signals.agentsMd.content.length} chars${signals.agentsMd.truncated ? ", truncated" : ""})`,
		);
	}
	if (signals.claudeMd) {
		lines.push(
			`  CLAUDE.md (${signals.claudeMd.content.length} chars${signals.claudeMd.truncated ? ", truncated" : ""})`,
		);
	}
	if (signals.manifest) {
		lines.push(
			`  ${signals.manifest.kind} (${signals.manifest.content.length} chars${signals.manifest.truncated ? ", truncated" : ""})`,
		);
	}
	lines.push(
		`  top-level dirs: ${signals.topLevelDirs.length ? signals.topLevelDirs.join(", ") : "(none)"}`,
	);
	lines.push(
		`  existing minds: ${signals.existingMinds.length}${signals.existingMinds.length ? ` (${signals.existingMinds.map((m) => m.slug).join(", ")})` : ""}`,
	);
	return lines.join("\n");
}

function renderProposal(
	proposal: AssembleProposal,
	signals: RepoSignals,
): string {
	const lines: string[] = [];
	lines.push(`TEAM PROPOSAL — ${proposal.team_name} (${proposal.universe})`);
	lines.push(`  team slug: ${proposal.team_slug}`);
	lines.push(`  project:   ${proposal.project}`);
	lines.push(`  rationale: ${proposal.rationale}`);
	lines.push("");
	for (let i = 0; i < proposal.members.length; i++) {
		const m = proposal.members[i];
		lines.push(`  ${i + 1}. ${m.name}  ·  ${m.slug}  ·  ${m.role}`);
		lines.push(`     voice: ${m.voice}`);
		lines.push(`     ${m.voiceDescription}`);
		if (m.rationale) lines.push(`     why: ${m.rationale}`);
	}
	if (signals.existingMinds.length > 0) {
		lines.push("");
		lines.push(
			`existing preserved: ${signals.existingMinds.map((e) => e.slug).join(", ")}`,
		);
	}
	return lines.join("\n");
}

function renderAuthoringSummary(
	proposal: AssembleProposal,
	succeeded: MemberAuthoringResult[],
	failed: MemberAuthoringResult[],
	savedRoom: SavedRoom | undefined,
	lens: { lensSlug: string; created: boolean } | undefined,
): string {
	const lines: string[] = [];
	lines.push("TEAM ASSEMBLED");
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
	return lines.join("\n");
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function notify(
	ctx: AssembleCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") throw new Error(message);
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
