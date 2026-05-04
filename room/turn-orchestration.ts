import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	appendRoomTranscriptTurn,
	buildRoomHistoryFromEntries,
	DEFAULT_GROUP_CHAT_MAX_TURNS,
	DEFAULT_GROUP_CHAT_MIN_ROUNDS,
	DEFAULT_GROUP_CHAT_REPEAT_CAP,
	DEFAULT_OPEN_FLOOR_END_VOTE_THRESHOLD,
	DEFAULT_OPEN_FLOOR_MAX_TURNS,
	DEFAULT_OPEN_FLOOR_MIN_ROUNDS,
	DEFAULT_OPEN_FLOOR_REPEAT_CAP,
	readRoomTranscript,
	resolveRoomSessionPath,
	type RoomMode,
	type RoomState,
	type RoomTranscriptTurnV2,
	safeReadSavedRoom,
} from "./core.ts";
import {
	buildMindModeSystemPrompt,
	loadMindConfig,
	loadMindContext,
} from "../mind/core.ts";
import {
	buildChairmanPersona,
	CHAIRMAN_SLUG,
	type ChamberHistoryTurn,
	stripControlJson,
} from "./prompts.ts";
import {
	type DirectorOverrides,
	executeStrategy,
	type GroupChatConfig,
	type MindSpec,
	type OpenFloorConfig,
	type OrchestrationContext,
	type SpawnFn,
} from "./strategies/index.ts";
import { spawnMind, type SpawnMindResult } from "./spawn.ts";
import {
	ROOM_CUSTOM_TYPES,
	formatDurationMs,
	type MindSpeechDetails,
	type ModeratorDecisionDetails,
	type ParticipantStatus,
	paletteIndexForSlug,
	type RoundMetricsDetails,
} from "./ui.ts";
import type { ParticipantTracker, RoomCommandContext } from "./types.ts";

export type TurnRuntimeStats = {
	lastReplyBySlug: Map<string, string>;
	turnCountBySlug: Map<string, number>;
	lastRoomMetrics:
		| { mode: string; turns: number; durationMs: number }
		| undefined;
};

export type TurnOrchestratorDeps = {
	pi: ExtensionAPI;
	getActiveRoom: () => RoomState | undefined;
	getParticipantTrackers: () => ParticipantTracker[];
	setParticipantTrackers: (trackers: ParticipantTracker[]) => void;
	buildParticipantTrackers: (cwd: string, state: RoomState) => ParticipantTracker[];
	notify: (
		ctx: RoomCommandContext,
		message: string,
		level?: "info" | "warning" | "error",
	) => void;
	syncParticipantWidget: (ctx: RoomCommandContext) => void;
	setRoomStatus: (
		ctx: RoomCommandContext,
		state?: RoomState,
		extra?: string,
	) => void;
	setWorkingIndicator: (ctx: RoomCommandContext, on: boolean) => void;
	startStatusTicker: (
		ctx: RoomCommandContext,
		getRoundStartedAt: () => number,
	) => void;
	stopStatusTicker: () => void;
	syncObservatoryLens: (cwd: string) => void;
	errorMessage: (err: unknown) => string;
};

export type TurnOrchestrator = {
	handleRoomTurn: (
		ctx: RoomCommandContext,
		userMessage: string,
		options?: { directAddress?: string },
	) => Promise<void>;
	haltActive: () => boolean;
	isActive: () => boolean;
	setNextSpeaker: (slug: string) => void;
	setDirectionInjection: (text: string) => void;
	clearDirectorOverrides: () => void;
	resetTranscriptState: () => void;
	loadTranscriptForActive: (cwd: string) => void;
	resetRuntimeCounters: () => void;
	invalidateMindCache: () => void;
	getDiskTranscript: () => readonly RoomTranscriptTurnV2[];
	getDiskTranscriptCount: () => number;
	getPersistedRoundCount: () => number;
	getRuntimeStats: () => TurnRuntimeStats;
};

export function createTurnOrchestrator(
	deps: TurnOrchestratorDeps,
): TurnOrchestrator {
	const { pi } = deps;

	let activeDiskTranscript: RoomTranscriptTurnV2[] = [];
	let persistedRoundCount = 0;
	let mindSpecCache = new Map<string, MindSpec>();
	let cachedMindCwd: string | undefined;
	let activeAbort: AbortController | undefined;
	let roundStartedAt = 0;
	let speechBuffers = new Map<string, { slug: string; text: string }>();
	let messageCounter = 0;
	let pendingDirectorOverrides: DirectorOverrides = {};
	let lastReplyBySlug = new Map<string, string>();
	let turnCountBySlug = new Map<string, number>();
	let lastRoomMetrics:
		| { mode: string; turns: number; durationMs: number }
		| undefined;

	function nextMessageId(): string {
		messageCounter += 1;
		return `room-msg-${messageCounter}-${Date.now()}`;
	}

	function emitMindSpeechMessage(
		details: MindSpeechDetails,
		text: string,
		messageId: string,
	): void {
		try {
			// Strip the optional `{action:"address"|"pass"|"end"}` control tail
			// from the user-visible body. The tail is still parsed for routing
			// and rendered by the moderator-decision line below the turn, so
			// showing the raw JSON in the chat is duplicate noise. Persisted
			// transcript and details keep the raw text for replay/re-parse.
			pi.sendMessage<MindSpeechDetails>({
				customType: ROOM_CUSTOM_TYPES.mindSpeech,
				content: stripControlJson(text),
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
		ctx: RoomCommandContext,
	): void {
		const trackers = deps.getParticipantTrackers();
		const tracker = trackers.find((p) => p.slug === slug);
		if (tracker) {
			const wasActive =
				tracker.status === "thinking" || tracker.status === "speaking";
			const willBeActive = status === "thinking" || status === "speaking";
			if (willBeActive && !wasActive) {
				tracker.startedAt = Date.now();
			} else if (!willBeActive) {
				tracker.startedAt = undefined;
				// Tool activity is stamped while the child Pi is producing the
				// turn. Clearing on leave keeps the bar from displaying a
				// stale "running bash" hint after the mind is already done.
				tracker.currentActivity = undefined;
			}
			tracker.status = status;
		}
		deps.syncParticipantWidget(ctx);
	}

	/**
	 * Surface the child Pi's tool activity in the participant bar. The child
	 * runs as a print-mode JSON Pi and emits NDJSON events on stdout; we
	 * subscribe via the `onEvent` escape hatch in spawnMind and mirror the
	 * latest tool name (plus a meaningful arg snippet) onto the speaker's
	 * tracker.
	 *
	 * We do NOT clear on `tool_execution_end` — keeping the last tool visible
	 * until the next one starts (or the speaker finishes) gives the operator
	 * a stable readout of "what jarvis is doing right now" instead of a
	 * flash of empty between rapid tool calls.
	 */
	function onChildEvent(
		slug: string,
		event: { type: string; toolName?: unknown; args?: unknown },
		ctx: RoomCommandContext,
	): void {
		if (event.type !== "tool_execution_start") return;
		const tool =
			typeof event.toolName === "string" && event.toolName.length > 0
				? event.toolName
				: undefined;
		if (!tool) return;
		const trackers = deps.getParticipantTrackers();
		const tracker = trackers.find((p) => p.slug === slug);
		if (!tracker) return;
		tracker.currentActivity = {
			tool,
			label: formatToolActivityLabel(tool, event.args),
			startedAt: Date.now(),
		};
		deps.syncParticipantWidget(ctx);
	}

	function ensureMindSpec(cwd: string, slug: string): MindSpec {
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
		// Prefer disk-sourced rounds: saved rooms persist each completed round
		// to .pi/rooms/<slug>/transcript.jsonl with full per-speaker fidelity.
		// Disk wins when available because it preserves per-mind attribution;
		// session entries collapse the room's responses into a single flat
		// "room" blob.
		const diskRounds = activeDiskTranscript.slice(-maxRounds);
		const turns: ChamberHistoryTurn[] = [];
		for (const dt of diskRounds) {
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
		// Fall back to session entries only for the rounds disk doesn't cover
		// (e.g., unsaved one-off rooms have no disk transcript). Without this
		// guard, saved-room rounds present in BOTH session entries and disk
		// would be inserted twice in different formats.
		const need = Math.max(0, maxRounds - diskRounds.length);
		if (need > 0) {
			const sessionRounds = buildRoomHistoryFromEntries(
				ctx.sessionManager.getEntries(),
				need,
			);
			for (const sr of sessionRounds) {
				turns.push({ speaker: "user", content: sr.user });
				turns.push({ speaker: "room", content: sr.assistant });
			}
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
		const activeRoom = deps.getActiveRoom();
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
				onEvent: (event) => onChildEvent(req.slug, event, ctx),
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
				deps.syncObservatoryLens(ctx.cwd);
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
				deps.syncObservatoryLens(ctx.cwd);
			},
			emitModeratorDecision: (moderatorSlug, decision) => {
				emitModeratorDecisionMessage(
					{
						moderatorSlug,
						moderatorPaletteIndex: paletteIndexForSlug(moderatorSlug),
						action: decision.action,
						phase: decision.phase,
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
				deps.syncObservatoryLens(ctx.cwd);
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
				deps.notify(ctx, message, "warning");
			},
		};
	}

	async function handleRoomTurn(
		ctx: RoomCommandContext,
		userMessage: string,
		options: { directAddress?: string } = {},
	): Promise<void> {
		const activeRoom = deps.getActiveRoom();
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

		const trackers = deps.buildParticipantTrackers(ctx.cwd, activeRoom);
		for (const t of trackers) {
			t.status = effectiveParticipants.includes(t.slug) ? "thinking" : "ready";
		}
		deps.setParticipantTrackers(trackers);
		deps.syncParticipantWidget(ctx);

		emitUserRoomMessage(userMessage);

		deps.setWorkingIndicator(ctx, true);
		deps.startStatusTicker(ctx, () => roundStartedAt);

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

			// Resolve open-floor opener and synthesizer. Open-floor uses the
			// chairman (or a participant slug) as opener; the synthesizer reuses
			// the saved-room `synthesizer` field. Direct-address turns force
			// concurrent mode so opener resolution is skipped there.
			let openFloorOpenerSlug: string | undefined =
				!options.directAddress && effectiveMode === "open-floor"
					? savedRoomCfg?.opener
					: undefined;
			let openFloorSynthesizerSlug: string | undefined =
				!options.directAddress &&
				effectiveMode === "open-floor" &&
				savedRoomCfg?.synthesizer
					? savedRoomCfg.synthesizer
					: undefined;

			const includeChairman =
				(effectiveMode === "group-chat" &&
					effectiveModerator === CHAIRMAN_SLUG) ||
				concurrentSynthSlug === CHAIRMAN_SLUG ||
				openFloorOpenerSlug === CHAIRMAN_SLUG ||
				openFloorSynthesizerSlug === CHAIRMAN_SLUG;
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
					deps.notify(
						ctx,
						`Saved-room synthesizer "${effectiveModerator}" is not loadable (${deps.errorMessage(err)}). Falling back to chairman.`,
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
					deps.notify(
						ctx,
						`Saved-room concurrentSynthesis mind "${concurrentSynthSlug}" is not loadable (${deps.errorMessage(err)}). Skipping synthesis for this round.`,
						"warning",
					);
					concurrentSynthSlug = undefined;
				}
			}
			if (
				openFloorOpenerSlug &&
				openFloorOpenerSlug !== CHAIRMAN_SLUG &&
				!minds.has(openFloorOpenerSlug)
			) {
				try {
					minds.set(
						openFloorOpenerSlug,
						ensureMindSpec(ctx.cwd, openFloorOpenerSlug),
					);
				} catch (err) {
					deps.notify(
						ctx,
						`Saved-room opener "${openFloorOpenerSlug}" is not loadable (${deps.errorMessage(err)}). Defaulting to first participant.`,
						"warning",
					);
					openFloorOpenerSlug = undefined;
				}
			}
			if (
				openFloorSynthesizerSlug &&
				openFloorSynthesizerSlug !== CHAIRMAN_SLUG &&
				!minds.has(openFloorSynthesizerSlug)
			) {
				try {
					minds.set(
						openFloorSynthesizerSlug,
						ensureMindSpec(ctx.cwd, openFloorSynthesizerSlug),
					);
				} catch (err) {
					deps.notify(
						ctx,
						`Saved-room synthesizer "${openFloorSynthesizerSlug}" is not loadable (${deps.errorMessage(err)}). Skipping synthesis for this round.`,
						"warning",
					);
					openFloorSynthesizerSlug = undefined;
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
			const openFloorConfig: OpenFloorConfig | undefined =
				effectiveMode === "open-floor"
					? {
							maxTurns:
								savedRoomCfg?.openFloor?.maxTurns ??
								DEFAULT_OPEN_FLOOR_MAX_TURNS,
							minRounds:
								savedRoomCfg?.openFloor?.minRounds ??
								DEFAULT_OPEN_FLOOR_MIN_ROUNDS,
							maxSpeakerRepeats:
								savedRoomCfg?.openFloor?.maxSpeakerRepeats ??
								DEFAULT_OPEN_FLOOR_REPEAT_CAP,
							endVoteThreshold:
								savedRoomCfg?.openFloor?.endVoteThreshold ??
								DEFAULT_OPEN_FLOOR_END_VOTE_THRESHOLD,
						}
					: undefined;
			// `synthesisConfig` is shared between concurrent (post-parallel
			// summary) and open-floor (closing voice). Concurrent mode reads
			// `concurrentSynthesis`; open-floor reads `synthesizer`.
			const synthesisConfig =
				effectiveMode === "open-floor"
					? openFloorSynthesizerSlug
						? { mode: openFloorSynthesizerSlug }
						: undefined
					: concurrentSynthSlug
						? { mode: concurrentSynthSlug }
						: undefined;
			const speakerAddressing =
				effectiveMode === "group-chat" && Boolean(savedRoomCfg?.speakerAddressing);
			const result = await executeStrategy({
				mode: effectiveMode,
				userMessage,
				mindsBySlug: minds,
				participantOrder: effectiveParticipants,
				moderatorSlug: effectiveModerator,
				roundHistory: buildPriorRoundsHistory(ctx),
				context: orchestration,
				groupChatConfig,
				openFloorConfig,
				synthesisConfig,
				...(speakerAddressing ? { speakerAddressing: true } : {}),
				...(openFloorOpenerSlug ? { openerSlug: openFloorOpenerSlug } : {}),
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
				`Chamber round failed: ${deps.errorMessage(error)}`,
				"error",
			);
		} finally {
			deps.stopStatusTicker();
			deps.setWorkingIndicator(ctx, false);
			const finalTrackers = deps.getParticipantTrackers();
			for (const tracker of finalTrackers) {
				if (tracker.status === "thinking" || tracker.status === "speaking") {
					tracker.status = "done";
				}
			}
			deps.syncParticipantWidget(ctx);
			deps.setRoomStatus(ctx, deps.getActiveRoom());
			activeAbort = undefined;
		}
	}

	function resetTranscriptState(): void {
		activeDiskTranscript = [];
		persistedRoundCount = 0;
	}

	function loadTranscriptForActive(cwd: string): void {
		const activeRoom = deps.getActiveRoom();
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

	return {
		handleRoomTurn,
		haltActive: () => {
			if (!activeAbort) return false;
			try {
				activeAbort.abort();
			} catch {
				/* ignore */
			}
			activeAbort = undefined;
			return true;
		},
		isActive: () => activeAbort !== undefined,
		setNextSpeaker: (slug: string) => {
			pendingDirectorOverrides = {
				...pendingDirectorOverrides,
				nextSpeaker: slug,
			};
		},
		setDirectionInjection: (text: string) => {
			pendingDirectorOverrides = {
				...pendingDirectorOverrides,
				directionInjection: text,
			};
		},
		clearDirectorOverrides: () => {
			pendingDirectorOverrides = {};
		},
		resetTranscriptState,
		loadTranscriptForActive,
		resetRuntimeCounters: () => {
			lastReplyBySlug = new Map();
			turnCountBySlug = new Map();
			lastRoomMetrics = undefined;
		},
		invalidateMindCache: () => {
			mindSpecCache.clear();
		},
		getDiskTranscript: () => activeDiskTranscript,
		getDiskTranscriptCount: () => activeDiskTranscript.length,
		getPersistedRoundCount: () => persistedRoundCount,
		getRuntimeStats: () => ({
			lastReplyBySlug,
			turnCountBySlug,
			lastRoomMetrics,
		}),
	};
}

const ACTIVITY_LABEL_MAX = 40;

/**
 * Format a one-line activity hint for the participant bar from the child
 * Pi's `tool_execution_start` args. Shows the most operator-relevant field
 * per built-in tool (path / command / pattern); falls back to the tool name
 * alone when args are missing or unrecognized.
 *
 * Truncation strategy:
 * - Paths tail-truncate (preserve filename).
 * - Commands and patterns head-truncate (preserve the start of intent).
 *
 * Exported for unit tests; not used outside this module.
 */
export function formatToolActivityLabel(
	toolName: string,
	args: unknown,
): string {
	if (!args || typeof args !== "object") return toolName;
	const a = args as Record<string, unknown>;
	let detail: string | undefined;
	let isPath = false;
	if (typeof a.path === "string" && a.path.length > 0) {
		detail = a.path;
		isPath = true;
	} else if (typeof a.command === "string" && a.command.length > 0) {
		detail = a.command.split("\n")[0]?.trim() ?? a.command;
	} else if (typeof a.pattern === "string" && a.pattern.length > 0) {
		detail = a.pattern;
	}
	if (!detail) return toolName;
	if (detail.length > ACTIVITY_LABEL_MAX) {
		if (isPath) {
			detail = `…${detail.slice(detail.length - (ACTIVITY_LABEL_MAX - 1))}`;
		} else {
			detail = `${detail.slice(0, ACTIVITY_LABEL_MAX - 1)}…`;
		}
	}
	return `${toolName} ${detail}`;
}
