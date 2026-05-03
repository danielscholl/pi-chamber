import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	appendRoomTranscriptTurn,
	buildRoomHistoryFromEntries,
	DEFAULT_GROUP_CHAT_MAX_TURNS,
	DEFAULT_GROUP_CHAT_MIN_ROUNDS,
	DEFAULT_GROUP_CHAT_REPEAT_CAP,
	DEFAULT_ROOM_MODE,
	deleteSavedRoom,
	describeRoomState,
	dropRoomSessions,
	latestRoomState,
	listSavedRooms,
	normalizeRoomSlug,
	parseRoomArgs,
	resolveRoomSessionPath,
	ROOM_MODES,
	ROOM_STATE_CUSTOM_TYPE,
	type RoomCommand,
	type RoomMode,
	type RoomState,
	type RoomTranscriptTurnV2,
	readRoomTranscript,
	readSavedRoom,
	resolveRoomParticipants,
	safeReadSavedRoom,
	type SavedRoom,
	type SavedRoomSummary,
	validateRoomState,
	writeSavedRoom,
} from "./core.ts";
import {
	buildMindModeSystemPrompt,
	listGenesisMinds,
	loadMindConfig,
	loadMindContext,
} from "../mind/core.ts";
import { registerExitCommand, registerExitTarget } from "../shared/session-exit.ts";
import {
	buildChairmanPersona,
	CHAIRMAN_SLUG,
	type ChamberHistoryTurn,
	type ModeratorPhase,
} from "./prompts.ts";
import {
	type DirectorOverrides,
	executeStrategy,
	type GroupChatConfig,
	type MindSpec,
	type OrchestrationContext,
	type SpeechRole,
	type SpawnFn,
} from "./strategies.ts";
import {
	spawnMind,
	type SpawnMindResult,
} from "./spawn.ts";
import {
	ROOM_CUSTOM_TYPES,
	type RoomStateView,
	formatDurationMs,
	mindSpeechRenderer,
	type MindSpeechDetails,
	moderatorDecisionRenderer,
	type ModeratorDecisionDetails,
	type ParticipantStateView,
	type ParticipantStatus,
	paletteIndexForSlug,
	renderParticipantBarLines,
	roundMetricsRenderer,
	type RoundMetricsDetails,
	userRoomMessageRenderer,
} from "./ui.ts";
import {
	type ObservatoryParticipant,
	type ObservatoryRoomSnapshot,
	clearChamberObservatoryLens,
	paletteNameForIndex,
	writeChamberObservatoryLens,
} from "./observatory.ts";

type RoomSessionManager = {
	getEntries(): Array<Record<string, unknown>>;
	getSessionFile?(): string | undefined;
	appendCustomEntry?(customType: string, data?: unknown): string;
	appendSessionInfo?(name: string): string;
};

type RoomCommandContext = {
	cwd: string;
	hasUI: boolean;
	sessionManager: RoomSessionManager;
	signal?: AbortSignal;
	abort?: () => void;
	waitForIdle?(): Promise<void>;
	newSession?(options?: {
		parentSession?: string;
		setup?: (sessionManager: RoomSessionManager) => Promise<void> | void;
		withSession?: (ctx: RoomCommandContext) => Promise<void> | void;
	}): Promise<{ cancelled?: boolean }>;
	switchSession?(
		sessionPath: string,
		options?: {
			withSession?: (ctx: RoomCommandContext) => Promise<void> | void;
		},
	): Promise<{ cancelled?: boolean }>;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		select?(prompt: string, options: string[]): Promise<string | undefined>;
		input?(prompt: string, defaultValue?: string): Promise<string | undefined>;
		setStatus(key: string, value: string | undefined): void;
		setWidget?: ExtensionAPI extends { on: unknown }
			?
					| ((
							key: string,
							content: string[] | undefined,
							options?: { placement?: "aboveEditor" | "belowEditor" },
					  ) => void)
					| ((
							key: string,
							factory: unknown,
							options?: { placement?: "aboveEditor" | "belowEditor" },
					  ) => void)
			: never;
		setWorkingIndicator?: (options?: {
			frames?: string[];
			intervalMs?: number;
		}) => void;
	};
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

type ParticipantTracker = {
	slug: string;
	role: "speaker" | "moderator";
	status: ParticipantStatus;
	paletteIndex: number;
};

const STATE_STREAM = ROOM_STATE_CUSTOM_TYPE;
const STATUS_KEY = "room";
const ROOM_STATUS_ICON = "\u{F0C0}"; // nf-fa-users
const PARTICIPANT_WIDGET_KEY = "room-stage";
const SPINNER_FRAMES = ["·", "•", "●", "•"];

export default function (pi: ExtensionAPI) {
	let activeRoom: RoomState | undefined;
	let lastInactiveRoom: RoomState | undefined;
	let activeDiskTranscript: RoomTranscriptTurnV2[] = [];
	let persistedRoundCount = 0;
	let participantTrackers: ParticipantTracker[] = [];
	let mindSpecCache = new Map<string, MindSpec>();
	let cachedMindCwd: string | undefined;
	let activeAbort: AbortController | undefined;
	let roundStartedAt = 0;
	let statusInterval: ReturnType<typeof setInterval> | undefined;
	let speechBuffers = new Map<string, { slug: string; text: string }>();
	let messageCounter = 0;
	let pendingDirectorOverrides: DirectorOverrides = {};
	let lastReplyBySlug = new Map<string, string>();
	let turnCountBySlug = new Map<string, number>();
	let lastRoomMetrics:
		| { mode: string; turns: number; durationMs: number }
		| undefined;
	let activeRoomStartedAt: string | undefined;

	pi.registerMessageRenderer(
		ROOM_CUSTOM_TYPES.userMessage,
		// biome-ignore lint/suspicious/noExplicitAny: theme types from pi-coding-agent.
		(message, options, theme: any) =>
			userRoomMessageRenderer(message as never, options, theme),
	);
	pi.registerMessageRenderer(
		ROOM_CUSTOM_TYPES.mindSpeech,
		// biome-ignore lint/suspicious/noExplicitAny: theme types from pi-coding-agent.
		(message, options, theme: any) =>
			mindSpeechRenderer(message as never, options, theme),
	);
	pi.registerMessageRenderer(
		ROOM_CUSTOM_TYPES.moderatorDecision,
		// biome-ignore lint/suspicious/noExplicitAny: theme types from pi-coding-agent.
		(message, options, theme: any) =>
			moderatorDecisionRenderer(message as never, options, theme),
	);
	pi.registerMessageRenderer(
		ROOM_CUSTOM_TYPES.roundMetrics,
		// biome-ignore lint/suspicious/noExplicitAny: theme types from pi-coding-agent.
		(message, options, theme: any) =>
			roundMetricsRenderer(message as never, options, theme),
	);

	function nextMessageId(): string {
		messageCounter += 1;
		return `room-msg-${messageCounter}-${Date.now()}`;
	}

	function resetTranscriptState(): void {
		activeDiskTranscript = [];
		persistedRoundCount = 0;
	}

	function loadTranscriptForActive(cwd: string): void {
		if (!activeRoom?.active || !activeRoom.slug) {
			resetTranscriptState();
			return;
		}
		try {
			activeDiskTranscript = readRoomTranscript(cwd, activeRoom.slug);
		} catch {
			activeDiskTranscript = [];
		}
		persistedRoundCount = 0;
	}

	function persistState(entry: RoomState): void {
		try {
			pi.appendEntry(STATE_STREAM, entry);
		} catch {
			// Persistence failures must not block ordinary /room use.
		}
	}

	function setRoomStatus(
		ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
		state = activeRoom,
		extra?: string,
	): void {
		if (!ctx.hasUI) return;
		if (!state?.active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const base = `${ROOM_STATUS_ICON} room ${state.mode}:${state.participants.length}`;
		ctx.ui.setStatus(STATUS_KEY, extra ? `${base} · ${extra}` : base);
	}

	function buildParticipantTrackers(
		cwd: string,
		state: RoomState,
	): ParticipantTracker[] {
		const saved = state.slug ? safeReadSavedRoom(cwd, state.slug) : undefined;
		const synthesizer = saved?.synthesizer;
		const concurrentSynthRaw = saved?.concurrentSynthesis;
		const concurrentSynthSlug =
			state.mode === "concurrent" && concurrentSynthRaw
				? concurrentSynthRaw === true || concurrentSynthRaw === "chairman"
					? CHAIRMAN_SLUG
					: typeof concurrentSynthRaw === "string"
						? concurrentSynthRaw
						: undefined
				: undefined;
		// In group-chat the chairman is the implicit moderator unless the saved
		// room overrides with `synthesizer`. Surface whichever is active so the
		// participant bar / status ticker / observatory reflect the running
		// mind, not just the listed participants.
		const groupChatModerator =
			state.mode === "group-chat"
				? synthesizer ?? CHAIRMAN_SLUG
				: undefined;

		const slugs: string[] = [...state.participants];
		const moderatorSlugs = new Set<string>();
		if (groupChatModerator) {
			moderatorSlugs.add(groupChatModerator);
			if (!slugs.includes(groupChatModerator)) slugs.push(groupChatModerator);
		}
		if (concurrentSynthSlug) {
			moderatorSlugs.add(concurrentSynthSlug);
			if (!slugs.includes(concurrentSynthSlug)) slugs.push(concurrentSynthSlug);
		}

		return slugs.map((slug) => ({
			slug,
			role: moderatorSlugs.has(slug) ? "moderator" : "speaker",
			status: "ready",
			paletteIndex: paletteIndexForSlug(slug),
		}));
	}

	function describeActiveRoom(
		state: RoomState | undefined,
		cwd: string,
	): string {
		const saved = state?.slug ? safeReadSavedRoom(cwd, state.slug) : undefined;
		return describeRoomState(
			state,
			saved
				? {
						synthesizer: saved.synthesizer,
						groupChat: saved.groupChat,
					}
				: undefined,
		);
	}

	function syncParticipantWidget(
		ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
	): void {
		if (!ctx.hasUI) return;
		const setWidget = (
			ctx.ui as {
				setWidget?: (
					key: string,
					content: string[] | undefined,
					options?: { placement?: "aboveEditor" | "belowEditor" },
				) => void;
			}
		).setWidget;
		if (!setWidget) return;
		if (!activeRoom?.active) {
			setWidget(PARTICIPANT_WIDGET_KEY, undefined);
			return;
		}
		const view = buildStateView();
		const lines = renderParticipantBarLines(view);
		setWidget(PARTICIPANT_WIDGET_KEY, lines.length ? lines : undefined, {
			placement: "aboveEditor",
		});
	}

	function buildStateView(): RoomStateView {
		const participants: ParticipantStateView[] = participantTrackers.map(
			(p) => ({
				slug: p.slug,
				role: p.role,
				status: p.status,
				paletteIndex: p.paletteIndex,
			}),
		);
		return {
			active: Boolean(activeRoom?.active),
			mode: activeRoom?.mode ?? "concurrent",
			roomLabel: activeRoom?.name ?? activeRoom?.slug,
			participants,
		};
	}

	function buildObservatorySnapshot(): ObservatoryRoomSnapshot {
		const updatedAt = new Date().toISOString();
		if (!activeRoom?.active) {
			return {
				active: false,
				mode: activeRoom?.mode ?? "concurrent",
				updatedAt,
				participants: [],
			};
		}
		const participants: ObservatoryParticipant[] = participantTrackers.map((p) => ({
			name: p.slug,
			status: p.status,
			role: p.role,
			color: paletteNameForIndex(p.paletteIndex),
			turns: turnCountBySlug.get(p.slug) ?? 0,
			lastReply: lastReplyBySlug.get(p.slug),
		}));
		return {
			active: true,
			mode: activeRoom.mode,
			roomLabel: activeRoom.name ?? activeRoom.slug,
			startedAt: activeRoomStartedAt,
			updatedAt,
			participants,
			lastMetrics: lastRoomMetrics,
		};
	}

	function syncObservatoryLens(cwd: string): void {
		try {
			writeChamberObservatoryLens(cwd, buildObservatorySnapshot());
		} catch {
			// Observatory lens is best-effort. Failures must not block the room turn.
		}
	}

	function resetObservatoryCounters(): void {
		lastReplyBySlug = new Map();
		turnCountBySlug = new Map();
		lastRoomMetrics = undefined;
	}

	function setWorkingIndicator(
		ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
		on: boolean,
	): void {
		if (!ctx.hasUI) return;
		const indicator = (
			ctx.ui as {
				setWorkingIndicator?: (options?: {
					frames?: string[];
					intervalMs?: number;
				}) => void;
			}
		).setWorkingIndicator;
		if (!indicator) return;
		if (on) {
			indicator({ frames: SPINNER_FRAMES, intervalMs: 120 });
		} else {
			indicator();
		}
	}

	function startStatusTicker(
		ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
	): void {
		stopStatusTicker();
		if (!ctx.hasUI) return;
		const tick = () => {
			if (!activeRoom?.active) return;
			const speakers = participantTrackers.filter(
				(p) => p.status === "speaking" || p.status === "thinking",
			);
			const elapsed = formatDurationMs(Date.now() - roundStartedAt);
			let detail = `${speakers.length} active`;
			if (speakers.length === 1) detail = speakers[0].slug;
			setRoomStatus(ctx, activeRoom, `${detail} · ${elapsed}`);
		};
		tick();
		statusInterval = setInterval(tick, 1000) as unknown as ReturnType<
			typeof setInterval
		>;
	}

	function stopStatusTicker(): void {
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = undefined;
		}
	}

	function ensureMindSpec(
		cwd: string,
		slug: string,
	): MindSpec {
		if (cachedMindCwd !== cwd) {
			mindSpecCache.clear();
			cachedMindCwd = cwd;
		}
		const cached = mindSpecCache.get(slug);
		if (cached) return cached;
		if (slug === CHAIRMAN_SLUG) {
			const spec: MindSpec = {
				slug: CHAIRMAN_SLUG,
				persona: buildChairmanPersona(),
				paletteIndex: paletteIndexForSlug(CHAIRMAN_SLUG),
			};
			mindSpecCache.set(slug, spec);
			return spec;
		}
		const ctx = loadMindContext(cwd, slug);
		const persona = buildMindModeSystemPrompt(ctx);
		const config = loadMindConfig(cwd, slug);
		const spec: MindSpec = {
			slug,
			persona,
			paletteIndex: paletteIndexForSlug(slug),
			model: config?.model,
			fallbackModels: config?.fallbackModels,
			tools: config?.tools,
		};
		mindSpecCache.set(slug, spec);
		return spec;
	}

	function buildMindsBySlug(
		cwd: string,
		slugs: string[],
		options: { includeChairman?: boolean } = {},
	): Map<string, MindSpec> {
		const map = new Map<string, MindSpec>();
		for (const slug of slugs) {
			map.set(slug, ensureMindSpec(cwd, slug));
		}
		if (options.includeChairman) {
			map.set(CHAIRMAN_SLUG, ensureMindSpec(cwd, CHAIRMAN_SLUG));
		}
		return map;
	}

	function buildPriorRoundsHistory(
		ctx: Pick<RoomCommandContext, "sessionManager">,
		maxRounds = 2,
	): ChamberHistoryTurn[] {
		const sessionRounds = buildRoomHistoryFromEntries(
			ctx.sessionManager.getEntries(),
			maxRounds,
		);
		const need = Math.max(0, maxRounds - sessionRounds.length);
		const diskPicked = need > 0 ? activeDiskTranscript.slice(-need) : [];
		const turns: ChamberHistoryTurn[] = [];
		// Disk-sourced rounds first (older), then session-sourced (more recent).
		// Disk turns expose per-speaker fidelity; session turns are flat blobs
		// because Pi session entries don't carry per-speaker attribution.
		for (const dt of diskPicked) {
			turns.push({ speaker: "user", content: dt.user });
			for (const inner of dt.turns) {
				turns.push({
					speaker: inner.speaker,
					content: inner.content,
					turnNumber: inner.turnNumber,
					isModerator: inner.role === "synthesis",
				});
			}
		}
		for (const sr of sessionRounds) {
			turns.push({ speaker: "user", content: sr.user });
			turns.push({ speaker: "room", content: sr.assistant });
		}
		return turns;
	}

	function persistRoundToDisk(
		ctx: RoomCommandContext,
		userMessage: string,
		mode: RoomMode | string,
		transcript: ChamberHistoryTurn[],
		startedAt: number,
	): void {
		if (!activeRoom?.active || !activeRoom.slug) return;
		const ts = new Date().toISOString();
		const turn: RoomTranscriptTurnV2 = {
			version: 2,
			user: userMessage,
			mode,
			durationMs: Date.now() - startedAt,
			ts,
			turns: transcript.map((t) => ({
				speaker: t.speaker,
				role: t.isModerator ? "synthesis" : "speaker",
				content: t.content,
				...(typeof t.turnNumber === "number"
					? { turnNumber: t.turnNumber }
					: {}),
				paletteIndex: paletteIndexForSlug(t.speaker),
			})),
		};
		try {
			appendRoomTranscriptTurn(ctx.cwd, activeRoom.slug, turn);
			activeDiskTranscript.push(turn);
			persistedRoundCount += 1;
		} catch {
			// Persistence failures must not block the turn.
		}
	}

	function emitMindSpeechMessage(
		details: MindSpeechDetails,
		text: string,
		messageId: string,
	): void {
		try {
			pi.sendMessage<MindSpeechDetails>({
				customType: ROOM_CUSTOM_TYPES.mindSpeech,
				content: text,
				display: true,
				details: { ...details, messageId } as MindSpeechDetails & {
					messageId: string;
				},
			});
		} catch {
			// session may have ended
		}
	}

	function emitModeratorDecisionMessage(
		details: ModeratorDecisionDetails,
		summary: string,
	): void {
		try {
			pi.sendMessage<ModeratorDecisionDetails>({
				customType: ROOM_CUSTOM_TYPES.moderatorDecision,
				content: summary,
				display: true,
				details,
			});
		} catch {
			// session may have ended
		}
	}

	function emitRoundMetricsMessage(details: RoundMetricsDetails): void {
		try {
			pi.sendMessage<RoundMetricsDetails>({
				customType: ROOM_CUSTOM_TYPES.roundMetrics,
				content: `room round · ${details.turns} turns · ${formatDurationMs(details.durationMs)}`,
				display: true,
				details,
			});
		} catch {
			// session may have ended
		}
	}

	function emitUserRoomMessage(text: string): void {
		try {
			pi.sendMessage({
				customType: ROOM_CUSTOM_TYPES.userMessage,
				content: text,
				display: true,
			});
		} catch {
			// session may have ended
		}
	}

	function setParticipantStatus(
		slug: string,
		status: ParticipantStatus,
		ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
	): void {
		const tracker = participantTrackers.find((p) => p.slug === slug);
		if (tracker) tracker.status = status;
		syncParticipantWidget(ctx);
	}

	function buildOrchestrationContext(
		ctx: RoomCommandContext,
		signal: AbortSignal,
		mode: RoomMode,
		options: { forkPerMindRoomSlug?: string } = {},
	): OrchestrationContext {
		const speechBuffersLocal = speechBuffers;
		const forkRoomSlug = options.forkPerMindRoomSlug;
		const spawn: SpawnFn = (req) =>
			spawnMind({
				slug: req.slug,
				persona: req.persona,
				prompt: req.prompt,
				cwd: req.cwd,
				model: req.model,
				fallbackModels: req.fallbackModels,
				tools: req.tools,
				// Chairman is the built-in stateless moderator; persisting its
				// session would let routing/synthesis decisions accumulate
				// hidden context across turns. Always cold-spawn it.
				sessionFile:
					forkRoomSlug && req.slug !== CHAIRMAN_SLUG
						? resolveRoomSessionPath(req.cwd, forkRoomSlug, req.slug)
						: undefined,
				signal: req.signal,
				onDelta: req.onDelta,
				onAttemptStart: req.onAttemptStart,
				noChildExtensions: true,
			});

		return {
			cwd: ctx.cwd,
			signal,
			spawn,
			emitMindStart: (slug, _role, _turnNumber) => {
				const messageId = nextMessageId();
				speechBuffersLocal.set(messageId, { slug, text: "" });
				setParticipantStatus(slug, "speaking", ctx);
				syncObservatoryLens(ctx.cwd);
				return messageId;
			},
			emitMindDelta: (messageId, _slug, delta) => {
				const buf = speechBuffersLocal.get(messageId);
				if (buf) buf.text += delta;
			},
			emitMindReset: (messageId, _slug) => {
				// Wipe accumulated deltas so a fallback retry's stream is rendered
				// cleanly and the emitMindEnd buffer-fallback never surfaces a
				// concatenation of text from multiple model attempts.
				const buf = speechBuffersLocal.get(messageId);
				if (buf) buf.text = "";
			},
			emitMindEnd: (
				messageId,
				slug,
				role,
				result: SpawnMindResult,
				turnNumber,
			) => {
				const buf = speechBuffersLocal.get(messageId);
				const finalText = result.finalText || (buf?.text ?? "");
				const details: MindSpeechDetails = {
					slug,
					mode,
					role,
					paletteIndex: paletteIndexForSlug(slug),
					turnNumber,
					durationMs: result.durationMs,
					usage: {
						input: result.usage.input,
						output: result.usage.output,
						cost: result.usage.cost,
						turns: result.usage.turns,
					},
					model: result.model,
					aborted: result.aborted,
					stopReason: result.stopReason,
				};
				emitMindSpeechMessage(details, finalText, messageId);
				speechBuffersLocal.delete(messageId);
				setParticipantStatus(slug, result.aborted ? "aborted" : "done", ctx);
				if (finalText.trim().length > 0) {
					lastReplyBySlug.set(slug, finalText);
				}
				turnCountBySlug.set(slug, (turnCountBySlug.get(slug) ?? 0) + 1);
				syncObservatoryLens(ctx.cwd);
			},
			emitModeratorDecision: (moderatorSlug, decision) => {
				emitModeratorDecisionMessage(
					{
						moderatorSlug,
						moderatorPaletteIndex: paletteIndexForSlug(moderatorSlug),
						action: decision.action,
						phase: decision.phase as ModeratorPhase | undefined,
						nextSpeaker: decision.nextSpeaker,
						direction: decision.direction,
					},
					decision.action === "close"
						? `${moderatorSlug} closed the discussion`
						: `${moderatorSlug} → ${decision.nextSpeaker || "?"}`,
				);
			},
			emitRoundMetrics: (metrics) => {
				emitRoundMetricsMessage(metrics);
				lastRoomMetrics = {
					mode: metrics.mode,
					turns: metrics.turns,
					durationMs: metrics.durationMs,
				};
				syncObservatoryLens(ctx.cwd);
			},
			consumeDirectorOverrides: () => {
				if (
					!pendingDirectorOverrides.nextSpeaker &&
					!pendingDirectorOverrides.directionInjection
				) {
					return undefined;
				}
				const consumed: DirectorOverrides = { ...pendingDirectorOverrides };
				pendingDirectorOverrides = {};
				return consumed;
			},
			notifyWarning: (message) => {
				notify(ctx, message, "warning");
			},
		};
	}

	async function handleRoomTurn(
		ctx: RoomCommandContext,
		userMessage: string,
		options: { directAddress?: string } = {},
	): Promise<void> {
		if (!activeRoom?.active) return;
		if (activeAbort) {
			activeAbort.abort();
		}
		activeAbort = new AbortController();
		roundStartedAt = Date.now();
		speechBuffers = new Map();

		const effectiveMode: RoomMode = options.directAddress
			? "concurrent"
			: (activeRoom.mode as RoomMode);
		const effectiveParticipants = options.directAddress
			? [options.directAddress]
			: activeRoom.participants;
		const savedRoomCfg = activeRoom.slug
			? safeReadSavedRoom(ctx.cwd, activeRoom.slug)
			: undefined;
		let effectiveModerator: string | undefined =
			!options.directAddress && effectiveMode === "group-chat"
				? savedRoomCfg?.synthesizer ?? CHAIRMAN_SLUG
				: undefined;

		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		for (const t of participantTrackers) {
			t.status = effectiveParticipants.includes(t.slug) ? "thinking" : "ready";
		}
		syncParticipantWidget(ctx);

		emitUserRoomMessage(userMessage);

		setWorkingIndicator(ctx, true);
		startStatusTicker(ctx);

		try {
			// Resolve concurrent-mode synthesizer (PR 5). false/undefined → off;
			// true or "chairman" → chairman; any other string → participant slug.
			// Direct-address turns (`@slug`) bypass orchestration entirely, so
			// suppress synthesis even though `effectiveMode` is forced to
			// "concurrent" for the spawn.
			const concurrentSynth = savedRoomCfg?.concurrentSynthesis;
			let concurrentSynthSlug: string | undefined =
				!options.directAddress &&
				effectiveMode === "concurrent" &&
				concurrentSynth
					? concurrentSynth === true || concurrentSynth === "chairman"
						? CHAIRMAN_SLUG
						: concurrentSynth
					: undefined;

			const includeChairman =
				(effectiveMode === "group-chat" &&
					effectiveModerator === CHAIRMAN_SLUG) ||
				concurrentSynthSlug === CHAIRMAN_SLUG;
			const minds = buildMindsBySlug(ctx.cwd, effectiveParticipants, {
				includeChairman,
			});
			if (
				effectiveMode === "group-chat" &&
				effectiveModerator &&
				effectiveModerator !== CHAIRMAN_SLUG &&
				!minds.has(effectiveModerator)
			) {
				// Synthesizer is a hand-edited slug from room.json that may have
				// been deleted or never existed. On load failure, warn once and
				// fall back to the built-in chairman so the round still runs.
				try {
					minds.set(
						effectiveModerator,
						ensureMindSpec(ctx.cwd, effectiveModerator),
					);
				} catch (err) {
					notify(
						ctx,
						`Saved-room synthesizer "${effectiveModerator}" is not loadable (${errorMessage(err)}). Falling back to chairman.`,
						"warning",
					);
					effectiveModerator = CHAIRMAN_SLUG;
					if (!minds.has(CHAIRMAN_SLUG)) {
						minds.set(CHAIRMAN_SLUG, ensureMindSpec(ctx.cwd, CHAIRMAN_SLUG));
					}
				}
			}
			if (
				concurrentSynthSlug &&
				concurrentSynthSlug !== CHAIRMAN_SLUG &&
				!minds.has(concurrentSynthSlug)
			) {
				try {
					minds.set(
						concurrentSynthSlug,
						ensureMindSpec(ctx.cwd, concurrentSynthSlug),
					);
				} catch (err) {
					notify(
						ctx,
						`Saved-room concurrentSynthesis mind "${concurrentSynthSlug}" is not loadable (${errorMessage(err)}). Skipping synthesis for this round.`,
						"warning",
					);
					concurrentSynthSlug = undefined;
				}
			}
			const forkPerMindRoomSlug =
				activeRoom.slug && savedRoomCfg?.forkPerMind
					? activeRoom.slug
					: undefined;
			const orchestration = buildOrchestrationContext(
				ctx,
				activeAbort.signal,
				effectiveMode,
				{ forkPerMindRoomSlug },
			);
			const groupChatConfig: GroupChatConfig | undefined =
				effectiveMode === "group-chat"
					? {
							maxTurns:
								savedRoomCfg?.groupChat?.maxTurns ??
								DEFAULT_GROUP_CHAT_MAX_TURNS,
							minRounds:
								savedRoomCfg?.groupChat?.minRounds ??
								DEFAULT_GROUP_CHAT_MIN_ROUNDS,
							maxSpeakerRepeats:
								savedRoomCfg?.groupChat?.maxSpeakerRepeats ??
								DEFAULT_GROUP_CHAT_REPEAT_CAP,
						}
					: undefined;
			const synthesisConfig = concurrentSynthSlug
				? { mode: concurrentSynthSlug }
				: undefined;
			const result = await executeStrategy({
				mode: effectiveMode,
				userMessage,
				mindsBySlug: minds,
				participantOrder: effectiveParticipants,
				moderatorSlug: effectiveModerator,
				roundHistory: buildPriorRoundsHistory(ctx),
				context: orchestration,
				groupChatConfig,
				synthesisConfig,
			});
			persistRoundToDisk(
				ctx,
				options.directAddress
					? `@${options.directAddress} ${userMessage}`
					: userMessage,
				effectiveMode,
				result.transcript,
				roundStartedAt,
			);
		} catch (error) {
			ctx.ui.notify(
				`Chamber round failed: ${errorMessage(error)}`,
				"error",
			);
		} finally {
			stopStatusTicker();
			setWorkingIndicator(ctx, false);
			for (const tracker of participantTrackers) {
				if (tracker.status === "thinking" || tracker.status === "speaking") {
					tracker.status = "done";
				}
			}
			syncParticipantWidget(ctx);
			setRoomStatus(ctx, activeRoom);
			activeAbort = undefined;
		}
	}

	function parseDirectAddress(
		text: string,
		validSlugs: string[],
	): { slug: string; message: string } | null {
		const match = text.match(/^@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\s+([\s\S]+)/);
		if (!match) return null;
		const slug = match[1];
		const message = match[2].trim();
		if (!message) return null;
		return validSlugs.includes(slug) ? { slug, message } : null;
	}

	async function handleRoomCommand(
		args: string,
		ctx: RoomCommandContext,
	): Promise<void> {
		const value = (args || "").trim();
		const lower = value.toLowerCase();
		if (lower === "help" || lower === "?") {
			notify(ctx, `${usageText(ctx.cwd)}${availableSuffix(ctx.cwd)}`, "info");
			return;
		}

		const command = parseRoomArgs(args || "");
		if (command.type === "error") {
			notify(ctx, command.message, "error");
			return;
		}

		switch (command.type) {
			case "setupOrStatus":
				if (activeRoom?.active) {
					showRoomStatus(ctx);
					return;
				}
				await showPickerOrWizard(ctx);
				return;
			case "on":
				await activateRoom(ctx, command);
				return;
			case "status":
				showRoomStatus(ctx);
				return;
			case "list":
				showRoomList(ctx);
				return;
			case "mode":
				updateMode(ctx, command.mode);
				return;
			case "minds":
				updateParticipants(ctx, command.participants);
				return;
			case "reset":
				resetRoomSessions(ctx, command.slug);
				return;
			case "clear":
				clearRoom(ctx);
				return;
		}
	}

	function resetRoomSessions(ctx: RoomCommandContext, slug?: string): void {
		const targetSlug = slug ?? activeRoom?.slug;
		if (!targetSlug) {
			notify(
				ctx,
				"No active room and no slug given. Usage: /room reset [<slug>].",
				"warning",
			);
			return;
		}
		try {
			const dropped = dropRoomSessions(ctx.cwd, targetSlug);
			if (dropped === 0) {
				notify(
					ctx,
					`No per-mind sessions to drop for room "${targetSlug}".`,
					"info",
				);
			} else {
				notify(
					ctx,
					`Dropped ${dropped} per-mind session${dropped === 1 ? "" : "s"} for room "${targetSlug}".`,
					"info",
				);
			}
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
		}
	}

	const roomCommand = {
		description:
			"Pick or create a Chamber-style multi-mind room. Saved rooms persist in .pi/rooms/.",
		getArgumentCompletions: (prefix: string) =>
			roomArgumentCompletions(prefix),
		handler: async (args: string, ctx: unknown) => {
			await handleRoomCommand(args, ctx as RoomCommandContext);
		},
	};

	registerExitTarget(pi, {
		id: "room",
		label: "room",
		priority: 10,
		isActive: (ctx) => {
			const state = latestRoomState(ctx.sessionManager.getEntries());
			return Boolean(activeRoom?.active || state?.active);
		},
		exit: async (ctx) => {
			await deactivateRoom(
				ctx as unknown as RoomCommandContext,
				"exit command",
			);
		},
	});
	registerExitCommand(pi);

	pi.registerCommand("room", roomCommand);

	pi.registerCommand("halt", {
		description:
			"Abort the active room round. Partial replies are kept and marked aborted.",
		handler: async (_args, ctxRaw) => {
			const ctx = ctxRaw as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room round to halt.", "warning");
				return;
			}
			if (!activeAbort) {
				notify(ctx, "No in-flight round to halt.", "warning");
				return;
			}
			try {
				activeAbort.abort();
			} catch {
				/* ignore */
			}
			notify(ctx, "Halt sent. In-flight minds are wrapping up.", "info");
		},
	});

	pi.registerCommand("next", {
		description:
			"Override the moderator's next-speaker pick (group-chat only). Usage: /next <slug>",
		handler: async (args, ctxRaw) => {
			const ctx = ctxRaw as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room. Use /room first.", "error");
				return;
			}
			if (activeRoom.mode !== "group-chat") {
				notify(
					ctx,
					"/next applies only to group-chat mode rooms.",
					"error",
				);
				return;
			}
			// Speakable set excludes the moderator: `executeGroupChat` filters
			// the moderator out of its `speakers` set, so `/next <moderator>`
			// would silently no-op during routing. Reject it up front.
			const savedRoomCfg = activeRoom.slug
				? safeReadSavedRoom(ctx.cwd, activeRoom.slug)
				: undefined;
			const moderatorSlug = savedRoomCfg?.synthesizer ?? CHAIRMAN_SLUG;
			const speakers = activeRoom.participants.filter(
				(p) => p !== moderatorSlug,
			);
			const slug = (args || "").trim().toLowerCase();
			if (!slug) {
				notify(
					ctx,
					`Usage: /next <slug>. Active speakers: ${speakers.join(", ") || "(none)"}.`,
					"error",
				);
				return;
			}
			if (!speakers.includes(slug)) {
				const reason = activeRoom.participants.includes(slug)
					? `is the active moderator and cannot be picked as the next speaker`
					: `must be one of the active speakers: ${speakers.join(", ") || "(none)"}`;
				notify(ctx, `/next "${slug}" ${reason}.`, "error");
				return;
			}
			pendingDirectorOverrides = {
				...pendingDirectorOverrides,
				nextSpeaker: slug,
			};
			notify(ctx, `Director override: next speaker = ${slug}.`, "info");
		},
	});

	pi.registerCommand("inject", {
		description:
			"Prepend a moderator-style direction to the next speaker's prompt (group-chat). Usage: /inject <text>",
		handler: async (args, ctxRaw) => {
			const ctx = ctxRaw as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room. Use /room first.", "error");
				return;
			}
			if (activeRoom.mode !== "group-chat") {
				notify(ctx, "/inject applies only to group-chat mode rooms.", "error");
				return;
			}
			const text = (args || "").trim();
			if (!text) {
				notify(ctx, "Usage: /inject <text>", "error");
				return;
			}
			pendingDirectorOverrides = {
				...pendingDirectorOverrides,
				directionInjection: text,
			};
			notify(
				ctx,
				`Director note queued for the next speaker: "${text}".`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const eventCtx = ctx as unknown as RoomCommandContext;
		const state = latestRoomState(eventCtx.sessionManager.getEntries());
		if (!state?.active) {
			activeRoom = undefined;
			lastInactiveRoom = state;
			participantTrackers = [];
			resetObservatoryCounters();
			activeRoomStartedAt = undefined;
			setRoomStatus(eventCtx, undefined);
			syncParticipantWidget(eventCtx);
			return;
		}

		const validation = validateRoomState(eventCtx.cwd, state);
		if (validation.ok && validation.state) {
			activeRoom = validation.state;
			lastInactiveRoom = undefined;
			loadTranscriptForActive(eventCtx.cwd);
			participantTrackers = buildParticipantTrackers(eventCtx.cwd, activeRoom);
			resetObservatoryCounters();
			activeRoomStartedAt =
				activeRoom.activatedAt ?? new Date().toISOString();
			setRoomStatus(eventCtx, activeRoom);
			syncParticipantWidget(eventCtx);
			syncObservatoryLens(eventCtx.cwd);
			return;
		}

		activeRoom = undefined;
		participantTrackers = [];
		resetTranscriptState();
		resetObservatoryCounters();
		activeRoomStartedAt = undefined;
		lastInactiveRoom = {
			...state,
			active: false,
			deactivatedAt: new Date().toISOString(),
			reason: "restore validation failed",
		};
		persistState(lastInactiveRoom);
		setRoomStatus(eventCtx, undefined);
		syncParticipantWidget(eventCtx);
		try {
			clearChamberObservatoryLens(eventCtx.cwd);
		} catch {
			/* best-effort */
		}
		notify(
			eventCtx,
			`Room restore skipped: ${validation.errors.join(" ")}`,
			"warning",
		);
	});

	pi.on("input", async (event, ctx) => {
		const eventCtx = ctx as unknown as RoomCommandContext;
		const inputEvent = event as {
			text: string;
			source: "interactive" | "rpc" | "extension";
		};
		if (!activeRoom?.active) return { action: "continue" } as const;
		if (inputEvent.source === "extension") {
			return { action: "continue" } as const;
		}
		const text = (inputEvent.text ?? "").trim();
		if (!text) return { action: "continue" } as const;
		if (text.startsWith("/")) return { action: "continue" } as const;

		const validation = validateRoomState(eventCtx.cwd, activeRoom);
		if (!validation.ok || !validation.state) {
			const disabled: RoomState = {
				...activeRoom,
				active: false,
				deactivatedAt: new Date().toISOString(),
				reason: "validation failed before turn",
			};
			activeRoom = undefined;
			participantTrackers = [];
			resetObservatoryCounters();
			activeRoomStartedAt = undefined;
			lastInactiveRoom = disabled;
			persistState(disabled);
			setRoomStatus(eventCtx, undefined);
			syncParticipantWidget(eventCtx);
			try {
				clearChamberObservatoryLens(eventCtx.cwd);
			} catch {
				/* best-effort */
			}
			notify(
				eventCtx,
				`Room disabled because the active room is invalid: ${validation.errors.join(" ")}`,
				"warning",
			);
			return { action: "continue" } as const;
		}
		activeRoom = validation.state;

		const directAddress = parseDirectAddress(text, activeRoom.participants);
		if (directAddress) {
			void handleRoomTurn(eventCtx, directAddress.message, {
				directAddress: directAddress.slug,
			});
			return { action: "handled" } as const;
		}

		void handleRoomTurn(eventCtx, text);
		return { action: "handled" } as const;
	});

	async function showPickerOrWizard(ctx: RoomCommandContext): Promise<void> {
		if (!ctx.hasUI || !ctx.ui.select || !ctx.ui.input) {
			notify(ctx, `${usageText(ctx.cwd)}${availableSuffix(ctx.cwd)}`, "error");
			return;
		}

		let mindSlugs: string[];
		try {
			mindSlugs = listGenesisMinds(ctx.cwd);
		} catch (error) {
			notify(
				ctx,
				`Could not list Genesis minds: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
		if (mindSlugs.length === 0) {
			notify(ctx, "No complete Genesis minds found for /room.", "warning");
			return;
		}

		const saved = listSavedRooms(ctx.cwd);
		if (saved.length === 0) {
			await runCreateRoomWizard(ctx, mindSlugs);
			return;
		}

		const NEW_ROOM = "+ New room";
		const DELETE_ENTRY = "✕ Delete a saved room…";
		const options = [
			NEW_ROOM,
			...saved.map(formatSavedRoomOption),
			DELETE_ENTRY,
		];
		const choice = await ctx.ui.select("Chamber rooms:", options);
		if (!choice) return;

		if (choice === NEW_ROOM) {
			await runCreateRoomWizard(ctx, mindSlugs);
			return;
		}
		if (choice === DELETE_ENTRY) {
			await runDeleteSavedRoom(ctx, saved);
			return;
		}
		const slug = parseSavedRoomChoice(choice, saved);
		if (!slug) {
			notify(ctx, "Could not resolve the selected room.", "warning");
			return;
		}
		await activateSavedRoom(ctx, slug);
	}

	async function runCreateRoomWizard(
		ctx: RoomCommandContext,
		mindSlugs: string[],
	): Promise<void> {
		if (!ctx.hasUI || !ctx.ui.select || !ctx.ui.input) {
			notify(ctx, `${usageText(ctx.cwd)}${availableSuffix(ctx.cwd)}`, "error");
			return;
		}
		const name = await ctx.ui.input(
			"Room name (leave blank for an unsaved one-off):",
			"",
		);
		if (name === undefined) return;

		const selectedMode = await ctx.ui.select("Room mode:", [
			"concurrent — parallel takes from each mind",
			"sequential — ordered critique / refinement chain",
			"group-chat — moderator routes the floor",
		]);
		if (!selectedMode) return;
		const mode = modeFromSelection(selectedMode);

		const participants = await ctx.ui.input(
			`Participants (${mindSlugs.join(", ")}) or all:`,
			"all",
		);
		if (!participants) return;

		await startRoom(ctx, mode, participants, {
			save: name.trim().length > 0,
			displayName: name.trim() || undefined,
		});
	}

	async function activateSavedRoom(
		ctx: RoomCommandContext,
		slug: string,
	): Promise<void> {
		let saved: SavedRoom;
		try {
			saved = readSavedRoom(ctx.cwd, slug);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		const candidate: RoomState = {
			active: true,
			mode: saved.mode,
			participants: saved.participants,
			slug: saved.slug,
			name: saved.name,
			activatedAt: new Date().toISOString(),
		};
		const validation = validateRoomState(ctx.cwd, candidate);
		if (!validation.ok || !validation.state) {
			notify(
				ctx,
				`Saved room "${saved.slug}" cannot be activated: ${validation.errors.join(" ")}`,
				"error",
			);
			return;
		}
		activeRoom = { ...validation.state, slug: saved.slug, name: saved.name };
		lastInactiveRoom = undefined;
		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		loadTranscriptForActive(ctx.cwd);
		resetObservatoryCounters();
		activeRoomStartedAt = activeRoom.activatedAt ?? new Date().toISOString();
		persistState(activeRoom);
		setRoomStatus(ctx, activeRoom);
		syncParticipantWidget(ctx);
		syncObservatoryLens(ctx.cwd);
		notify(
			ctx,
			`${describeActiveRoom(activeRoom, ctx.cwd)} Loaded ${activeDiskTranscript.length} prior turn${activeDiskTranscript.length === 1 ? "" : "s"}. Use /exit to stop routing.`,
			"info",
		);
	}

	async function runDeleteSavedRoom(
		ctx: RoomCommandContext,
		saved: SavedRoomSummary[],
	): Promise<void> {
		if (!ctx.hasUI || !ctx.ui.select) return;
		const choice = await ctx.ui.select(
			"Delete which saved room?",
			saved.map(formatSavedRoomOption),
		);
		if (!choice) return;
		const slug = parseSavedRoomChoice(choice, saved);
		if (!slug) return;
		try {
			deleteSavedRoom(ctx.cwd, slug);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		if (activeRoom?.slug === slug) {
			await deactivateRoom(ctx);
		}
		notify(ctx, `Deleted saved room "${slug}".`, "info");
	}

	async function activateRoom(
		ctx: RoomCommandContext,
		command: Extract<RoomCommand, { type: "on" }>,
	): Promise<void> {
		const mode = command.mode ?? DEFAULT_ROOM_MODE;
		let participants = command.participants;
		if (!participants) {
			if (ctx.hasUI && ctx.ui.input) {
				participants = await ctx.ui.input(
					"Genesis mind slugs for the room (all or comma-separated):",
					"all",
				);
				if (!participants) return;
			} else {
				notify(
					ctx,
					`${usageText(ctx.cwd)}${availableSuffix(ctx.cwd)}`,
					"error",
				);
				return;
			}
		}
		await startRoom(ctx, mode, participants);
	}

	async function startRoom(
		ctx: RoomCommandContext,
		mode: RoomMode,
		participantInput: string,
		options: { save?: boolean; displayName?: string } = {},
	): Promise<void> {
		let participants: string[];
		try {
			participants = resolveRoomParticipants(ctx.cwd, participantInput);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}

		let savedSlug: string | undefined;
		let savedName: string | undefined;
		if (options.save && options.displayName) {
			let slug: string;
			try {
				slug = normalizeRoomSlug(options.displayName);
			} catch (error) {
				notify(ctx, errorMessage(error), "error");
				return;
			}
			const now = new Date().toISOString();
			try {
				const written = writeSavedRoom(ctx.cwd, {
					slug,
					name: options.displayName,
					mode,
					participants,
					createdAt: now,
					updatedAt: now,
				});
				savedSlug = written.slug;
				savedName = written.name;
			} catch (error) {
				notify(ctx, `Could not save room: ${errorMessage(error)}`, "error");
				return;
			}
		}

		const candidate: RoomState = {
			active: true,
			mode,
			participants,
			...(savedSlug ? { slug: savedSlug } : {}),
			...(savedName ? { name: savedName } : {}),
			activatedAt: new Date().toISOString(),
		};
		const validation = validateRoomState(ctx.cwd, candidate);
		if (!validation.ok || !validation.state) {
			notify(ctx, validation.errors.join("\n"), "error");
			return;
		}

		const validated: RoomState = {
			...validation.state,
			...(savedSlug ? { slug: savedSlug } : {}),
			...(savedName ? { name: savedName } : {}),
		};
		const savedNote = savedSlug
			? ` Saved as "${savedSlug}".`
			: " Unsaved one-off room.";

		const returnSessionFile = ctx.sessionManager.getSessionFile?.();
		if (returnSessionFile && ctx.newSession && ctx.switchSession) {
			const stateForNewSession: RoomState = {
				...validated,
				returnSessionFile,
			};
			await ctx.waitForIdle?.();
			const result = await ctx.newSession({
				parentSession: returnSessionFile,
				setup: (sessionManager) => {
					sessionManager.appendCustomEntry?.(STATE_STREAM, stateForNewSession);
					const label = describeActiveRoom(stateForNewSession, ctx.cwd);
					sessionManager.appendSessionInfo?.(`Room: ${label}`);
				},
				withSession: (replacementCtx) => {
					notify(
						replacementCtx,
						`${describeActiveRoom(stateForNewSession, replacementCtx.cwd)}${savedNote} Dedicated room session. Use /exit to return to the previous session.`,
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(ctx, "Room activation cancelled.", "info");
			}
			return;
		}

		activeRoom = validated;
		lastInactiveRoom = undefined;
		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		loadTranscriptForActive(ctx.cwd);
		resetObservatoryCounters();
		activeRoomStartedAt = activeRoom.activatedAt ?? new Date().toISOString();
		persistState(activeRoom);
		setRoomStatus(ctx, activeRoom);
		syncParticipantWidget(ctx);
		syncObservatoryLens(ctx.cwd);
		notify(
			ctx,
			`${describeActiveRoom(activeRoom, ctx.cwd)}${savedNote} Use /exit to stop routing.`,
			"info",
		);
	}

	async function deactivateRoom(
		ctx: RoomCommandContext,
		reason?: string,
	): Promise<void> {
		if (activeAbort) {
			try {
				activeAbort.abort();
			} catch {
				/* ignore */
			}
			activeAbort = undefined;
		}
		stopStatusTicker();
		setWorkingIndicator(ctx, false);
		const previous =
			activeRoom ?? latestRoomState(ctx.sessionManager.getEntries());
		const returnSessionFile = previous?.returnSessionFile;
		const inactive: RoomState = previous
			? {
					...previous,
					active: false,
					deactivatedAt: new Date().toISOString(),
					...(reason ? { reason } : {}),
				}
			: {
					active: false,
					mode: DEFAULT_ROOM_MODE,
					participants: [],
					deactivatedAt: new Date().toISOString(),
					...(reason ? { reason } : {}),
				};
		activeRoom = undefined;
		participantTrackers = [];
		resetTranscriptState();
		resetObservatoryCounters();
		activeRoomStartedAt = undefined;
		pendingDirectorOverrides = {};
		lastInactiveRoom = inactive;
		// Drop cached MindSpecs so the next /room on freshly reads each
		// mind-config.json. Without this, edits to model/tools/fallbackModels
		// between rooms within a single Pi session would be ignored until restart.
		mindSpecCache.clear();
		persistState(inactive);
		setRoomStatus(ctx, undefined);
		syncParticipantWidget(ctx);
		try {
			clearChamberObservatoryLens(ctx.cwd);
		} catch {
			/* best-effort */
		}

		if (returnSessionFile && ctx.switchSession) {
			await ctx.waitForIdle?.();
			const result = await ctx.switchSession(returnSessionFile, {
				withSession: (replacementCtx) => {
					setRoomStatus(replacementCtx, undefined);
					syncParticipantWidget(replacementCtx);
					notify(
						replacementCtx,
						"Room off. Returned to the previous session.",
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(
					ctx,
					"Room off, but returning to the previous session was cancelled.",
					"warning",
				);
			}
			return;
		}

		notify(ctx, "Room off. Future prompts use the normal assistant.", "info");
	}

	function showRoomStatus(ctx: RoomCommandContext): void {
		notify(
			ctx,
			describeActiveRoom(activeRoom, ctx.cwd),
			activeRoom?.active ? "info" : "warning",
		);
	}

	function showRoomList(ctx: RoomCommandContext): void {
		const saved = listSavedRooms(ctx.cwd);
		const minds = safeListGenesisMinds(ctx.cwd);
		const sections: string[] = [];
		if (saved.length === 0) {
			sections.push("No saved rooms yet. Run /room to create one.");
		} else {
			sections.push(
				`Saved rooms (${saved.length}):\n${saved
					.map((s) => `- ${formatSavedRoomOption(s)}`)
					.join("\n")}`,
			);
		}
		if (minds.length > 0) {
			sections.push(`Available Genesis minds: ${minds.join(", ")}.`);
		}
		notify(ctx, sections.join("\n\n"), saved.length ? "info" : "warning");
	}

	function updateMode(ctx: RoomCommandContext, mode: RoomMode): void {
		if (!activeRoom?.active) {
			notify(ctx, "No active room. Use /room on first.", "error");
			return;
		}
		const candidate: RoomState = {
			...activeRoom,
			mode,
			updatedAt: new Date().toISOString(),
		};
		commitActiveUpdate(ctx, candidate, `Room mode set to ${mode}.`);
	}

	function updateParticipants(ctx: RoomCommandContext, input: string): void {
		if (!activeRoom?.active) {
			notify(ctx, "No active room. Use /room on first.", "error");
			return;
		}
		let participants: string[];
		try {
			participants = resolveRoomParticipants(ctx.cwd, input);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		const candidate: RoomState = {
			...activeRoom,
			participants,
			updatedAt: new Date().toISOString(),
		};
		commitActiveUpdate(ctx, candidate, "Room participants updated.");
	}

	function clearRoom(ctx: RoomCommandContext): void {
		if (!activeRoom?.active) {
			notify(
				ctx,
				"No active room to clear. This does not erase the main Pi transcript.",
				"warning",
			);
			return;
		}
		// clearedAt / clearCount are display metadata; the actual history-window
		// reset comes from the persistState side effect below. roomHistoryStartIndex
		// scans for any room-state entry and advances past it, so writing a new one
		// fences off prior in-session rounds without touching the JSONL transcript.
		activeRoom = {
			...activeRoom,
			clearedAt: new Date().toISOString(),
			clearCount: (activeRoom.clearCount ?? 0) + 1,
		};
		persistState(activeRoom);
		notify(
			ctx,
			"Room transient counters cleared. This does not erase the main Pi transcript.",
			"info",
		);
	}

	function commitActiveUpdate(
		ctx: RoomCommandContext,
		candidate: RoomState,
		message: string,
	): void {
		const validation = validateRoomState(ctx.cwd, candidate);
		if (!validation.ok || !validation.state) {
			notify(ctx, validation.errors.join("\n"), "error");
			return;
		}
		activeRoom = validation.state;
		lastInactiveRoom = undefined;
		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		persistState(activeRoom);
		setRoomStatus(ctx, activeRoom);
		syncParticipantWidget(ctx);
		syncObservatoryLens(ctx.cwd);
		notify(ctx, `${message} ${describeActiveRoom(activeRoom, ctx.cwd)}`, "info");
	}
}

function roomArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = [
		{
			value: "status",
			label: "status",
			description: "Show the active room state",
		},
		{
			value: "list",
			label: "list",
			description: "List saved rooms",
		},
		{
			value: "reset",
			label: "reset",
			description:
				"Drop per-mind session files (forkPerMind rooms only). Optional <slug>.",
		},
		{
			value: "help",
			label: "help",
			description: "Show /room usage",
		},
	];
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function formatSavedRoomOption(saved: SavedRoomSummary): string {
	const participants =
		saved.participants.length > 3
			? `${saved.participants.slice(0, 3).join(", ")} +${saved.participants.length - 3}`
			: saved.participants.join(", ");
	const problems = saved.problems.length ? ` · ⚠ ${saved.problems[0]}` : "";
	return `▸ ${saved.slug} · ${saved.mode} · ${participants}${problems}`;
}

function parseSavedRoomChoice(
	choice: string,
	saved: SavedRoomSummary[],
): string | undefined {
	const match = choice.match(/^▸\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\b/);
	if (match && saved.some((s) => s.slug === match[1])) return match[1];
	return undefined;
}

function safeListGenesisMinds(cwd: string): string[] {
	try {
		return listGenesisMinds(cwd);
	} catch {
		return [];
	}
}

function modeFromSelection(selection: string): RoomMode {
	const key = selection.split(/\s+/)[0] as RoomMode;
	return ROOM_MODES.includes(key) ? key : DEFAULT_ROOM_MODE;
}

function usageText(cwd: string): string {
	void cwd;
	return [
		"Usage:",
		"  /room              picker — pick a saved room or create a new one",
		"  /exit                 leave the active mind or room",
		"  /room status       show the active room",
		"  /room list         list saved rooms",
		"  /room reset [<slug>] drop per-mind sessions (forkPerMind rooms only)",
		"  /room help         show this usage",
		"Saved rooms live in .pi/rooms/<slug>/ and persist across sessions.",
		"Power-user direct subcommands (on/mode/minds/clear) still work.",
	].join("\n");
}

function availableSuffix(cwd: string): string {
	try {
		const slugs = listGenesisMinds(cwd);
		return slugs.length ? ` Available: ${slugs.join(", ")}.` : "";
	} catch {
		return "";
	}
}

function notify(
	ctx: Pick<RoomCommandContext, "hasUI" | "ui">,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") {
		console.error(message);
		throw new Error(message);
	}
	console.log(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
