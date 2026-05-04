import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_ROOM_MODE,
	deleteSavedRoom,
	describeRoomState,
	dropRoomSessions,
	latestRoomState,
	listSavedRooms,
	normalizeRoomSlug,
	parseRoomArgs,
	ROOM_MODES,
	ROOM_STATE_CUSTOM_TYPE,
	type RoomCommand,
	type RoomMode,
	type RoomState,
	readSavedRoom,
	resolveRoomParticipants,
	safeReadSavedRoom,
	type SavedRoom,
	type SavedRoomSummary,
	validateRoomState,
	writeSavedRoom,
} from "./core.ts";
import { listGenesisMinds } from "../mind/core.ts";
import {
	registerSessionCommands,
	registerSessionTarget,
} from "../shared/session-exit.ts";
import { CHAIRMAN_SLUG } from "./prompts.ts";
import {
	ROOM_CUSTOM_TYPES,
	type RoomStateView,
	formatDurationMs,
	mindSpeechRenderer,
	moderatorDecisionRenderer,
	type ParticipantStateView,
	type ParticipantStatus,
	paletteIndexForSlug,
	renderParticipantBarLines,
	roundMetricsRenderer,
	userRoomMessageRenderer,
} from "./ui.ts";
import {
	type ObservatoryParticipant,
	type ObservatoryRoomSnapshot,
	clearChamberObservatoryLens,
	paletteNameForIndex,
	writeChamberObservatoryLens,
} from "./observatory.ts";
import type {
	ParticipantTracker,
	RoomCommandContext,
	RoomSessionManager,
} from "./types.ts";
import {
	createTurnOrchestrator,
	type TurnOrchestrator,
} from "./turn-orchestration.ts";

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

const STATE_STREAM = ROOM_STATE_CUSTOM_TYPE;
const STATUS_KEY = "room";
const ROOM_STATUS_ICON = "\u{F0C0}"; // nf-fa-users
const PARTICIPANT_WIDGET_KEY = "room-stage";
const SPINNER_FRAMES = ["·", "•", "●", "•"];

export default function (pi: ExtensionAPI) {
	let activeRoom: RoomState | undefined;
	let lastInactiveRoom: RoomState | undefined;
	let participantTrackers: ParticipantTracker[] = [];
	let statusInterval: ReturnType<typeof setInterval> | undefined;
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
		// Open-floor: the opener (when set) and the synthesizer (when set)
		// both take the moderator role in the participant bar. The opener is
		// optional and the synthesizer is independent — surface whichever
		// applies so the user sees who the auxiliary voices are.
		const openFloorOpener =
			state.mode === "open-floor" ? saved?.opener : undefined;
		const openFloorSynthesizer =
			state.mode === "open-floor" ? synthesizer : undefined;

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
		if (openFloorOpener) {
			moderatorSlugs.add(openFloorOpener);
			if (!slugs.includes(openFloorOpener)) slugs.push(openFloorOpener);
		}
		if (openFloorSynthesizer) {
			moderatorSlugs.add(openFloorSynthesizer);
			if (!slugs.includes(openFloorSynthesizer))
				slugs.push(openFloorSynthesizer);
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
						speakerAddressing: saved.speakerAddressing,
						openFloor: saved.openFloor,
						opener: saved.opener,
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
		const stats = orchestrator.getRuntimeStats();
		const participants: ObservatoryParticipant[] = participantTrackers.map((p) => ({
			name: p.slug,
			status: p.status,
			role: p.role,
			color: paletteNameForIndex(p.paletteIndex),
			turns: stats.turnCountBySlug.get(p.slug) ?? 0,
			lastReply: stats.lastReplyBySlug.get(p.slug),
		}));
		return {
			active: true,
			mode: activeRoom.mode,
			roomLabel: activeRoom.name ?? activeRoom.slug,
			startedAt: activeRoomStartedAt,
			updatedAt,
			participants,
			lastMetrics: stats.lastRoomMetrics,
		};
	}

	function syncObservatoryLens(cwd: string): void {
		try {
			writeChamberObservatoryLens(cwd, buildObservatorySnapshot());
		} catch {
			// Observatory lens is best-effort. Failures must not block the room turn.
		}
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
		getRoundStartedAt: () => number,
	): void {
		stopStatusTicker();
		if (!ctx.hasUI) return;
		const tick = () => {
			if (!activeRoom?.active) return;
			const speakers = participantTrackers.filter(
				(p) => p.status === "speaking" || p.status === "thinking",
			);
			const elapsed = formatDurationMs(Date.now() - getRoundStartedAt());
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

	const orchestrator: TurnOrchestrator = createTurnOrchestrator({
		pi,
		getActiveRoom: () => activeRoom,
		getParticipantTrackers: () => participantTrackers,
		setParticipantTrackers: (trackers) => {
			participantTrackers = trackers;
		},
		buildParticipantTrackers,
		notify,
		syncParticipantWidget,
		setRoomStatus,
		setWorkingIndicator,
		startStatusTicker,
		stopStatusTicker,
		syncObservatoryLens,
		errorMessage,
	});

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
			case "close":
				await runCloseSavedRoom(ctx, { slug: command.slug });
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

	registerSessionTarget(pi, {
		id: "room",
		label: "room",
		priority: 10,
		isActive: (ctx) => {
			const state = latestRoomState(ctx.sessionManager.getEntries());
			return Boolean(activeRoom?.active || state?.active);
		},
		leave: async (ctx) => {
			await leaveRoom(
				ctx as unknown as RoomCommandContext,
				"leave command",
			);
		},
		detach: async (ctx) => {
			await detachRoom(ctx as unknown as RoomCommandContext);
		},
	});
	registerSessionCommands(pi);

	pi.registerCommand("room", roomCommand);

	pi.registerCommand("halt", {
		description:
			"Abort the active room round. Partial replies are kept and marked aborted.",
		handler: async (_args, ctxRaw) => {
			const ctx = ctxRaw as unknown as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room round to halt.", "warning");
				return;
			}
			if (!orchestrator.haltActive()) {
				notify(ctx, "No in-flight round to halt.", "warning");
				return;
			}
			notify(ctx, "Halt sent. In-flight minds are wrapping up.", "info");
		},
	});

	pi.registerCommand("next", {
		description:
			"Override the next-speaker pick (group-chat or open-floor). Usage: /next <slug>",
		handler: async (args, ctxRaw) => {
			const ctx = ctxRaw as unknown as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room. Use /room first.", "error");
				return;
			}
			if (
				activeRoom.mode !== "group-chat" &&
				activeRoom.mode !== "open-floor"
			) {
				notify(
					ctx,
					"/next applies to group-chat and open-floor rooms only.",
					"error",
				);
				return;
			}
			// Speakable set excludes the moderator/opener slot: those minds are
			// not in `speakers` for routing purposes, so a /next override on
			// them would silently no-op. Reject it up front.
			const savedRoomCfg = activeRoom.slug
				? safeReadSavedRoom(ctx.cwd, activeRoom.slug)
				: undefined;
			const moderatorSlug =
				activeRoom.mode === "group-chat"
					? savedRoomCfg?.synthesizer ?? CHAIRMAN_SLUG
					: undefined;
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
			orchestrator.setNextSpeaker(slug);
			notify(ctx, `Director override: next speaker = ${slug}.`, "info");
		},
	});

	pi.registerCommand("inject", {
		description:
			"Prepend a director note to the next speaker's prompt (group-chat or open-floor). Usage: /inject <text>",
		handler: async (args, ctxRaw) => {
			const ctx = ctxRaw as unknown as RoomCommandContext;
			if (!activeRoom?.active) {
				notify(ctx, "No active room. Use /room first.", "error");
				return;
			}
			if (
				activeRoom.mode !== "group-chat" &&
				activeRoom.mode !== "open-floor"
			) {
				notify(
					ctx,
					"/inject applies to group-chat and open-floor rooms only.",
					"error",
				);
				return;
			}
			const text = (args || "").trim();
			if (!text) {
				notify(ctx, "Usage: /inject <text>", "error");
				return;
			}
			orchestrator.setDirectionInjection(text);
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
			orchestrator.resetRuntimeCounters();
			activeRoomStartedAt = undefined;
			setRoomStatus(eventCtx, undefined);
			syncParticipantWidget(eventCtx);
			return;
		}

		const validation = validateRoomState(eventCtx.cwd, state);
		if (validation.ok && validation.state) {
			activeRoom = validation.state;
			lastInactiveRoom = undefined;
			orchestrator.loadTranscriptForActive(eventCtx.cwd);
			participantTrackers = buildParticipantTrackers(eventCtx.cwd, activeRoom);
			orchestrator.resetRuntimeCounters();
			activeRoomStartedAt =
				activeRoom.activatedAt ?? new Date().toISOString();
			setRoomStatus(eventCtx, activeRoom);
			syncParticipantWidget(eventCtx);
			syncObservatoryLens(eventCtx.cwd);
			return;
		}

		activeRoom = undefined;
		participantTrackers = [];
		orchestrator.resetTranscriptState();
		orchestrator.resetRuntimeCounters();
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
			orchestrator.resetRuntimeCounters();
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
			void orchestrator.handleRoomTurn(eventCtx, directAddress.message, {
				directAddress: directAddress.slug,
			});
			return { action: "handled" } as const;
		}

		void orchestrator.handleRoomTurn(eventCtx, text);
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
		const CLOSE_ENTRY = "✕ Close a saved room…";
		const options = [
			NEW_ROOM,
			...saved.map(formatSavedRoomOption),
			CLOSE_ENTRY,
		];
		const choice = await ctx.ui.select("Chamber rooms:", options);
		if (!choice) return;

		if (choice === NEW_ROOM) {
			await runCreateRoomWizard(ctx, mindSlugs);
			return;
		}
		if (choice === CLOSE_ENTRY) {
			await runCloseSavedRoom(ctx, { saved });
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
			"open-floor — minds route the floor themselves",
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
		// Capture the session leaf id BEFORE persisting the activation marker
		// so /detach has a fork anchor. Without this, the picker-driven
		// activation path silently degrades /detach to /leave.
		const preRoomLeafId = safeGetLeafId(ctx);
		activeRoom = {
			...validation.state,
			slug: saved.slug,
			name: saved.name,
			...(preRoomLeafId ? { preRoomLeafId } : {}),
		};
		lastInactiveRoom = undefined;
		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		orchestrator.loadTranscriptForActive(ctx.cwd);
		orchestrator.resetRuntimeCounters();
		activeRoomStartedAt = activeRoom.activatedAt ?? new Date().toISOString();
		persistState(activeRoom);
		setRoomStatus(ctx, activeRoom);
		syncParticipantWidget(ctx);
		syncObservatoryLens(ctx.cwd);
		notify(
			ctx,
			`${describeActiveRoom(activeRoom, ctx.cwd)} Loaded ${orchestrator.getDiskTranscriptCount()} prior turn${orchestrator.getDiskTranscriptCount() === 1 ? "" : "s"}. Use /leave to stop routing, or /detach to rewind and preserve this room as an artifact.`,
			"info",
		);
	}

	// Shared by /room close <slug> AND the picker's "Close a saved room…"
	// entry. Refuses on assembly-provenance rooms (those belong to /assembly
	// adjourn). If the target is the currently-active room, leaves it first
	// so we don't tear out the floor under live state.
	async function runCloseSavedRoom(
		ctx: RoomCommandContext,
		options: { slug?: string; saved?: SavedRoomSummary[] } = {},
	): Promise<void> {
		const saved = options.saved ?? listSavedRooms(ctx.cwd);
		if (saved.length === 0) {
			notify(ctx, "No saved rooms to close.", "warning");
			return;
		}

		let targetSlug = options.slug;
		if (!targetSlug) {
			if (!ctx.hasUI || !ctx.ui.select) {
				notify(
					ctx,
					"UI does not support select; pass a slug: /room close <slug>",
					"error",
				);
				return;
			}
			const choice = await ctx.ui.select(
				"Close which saved room?",
				saved.map(formatSavedRoomOption),
			);
			if (!choice) return;
			const picked = parseSavedRoomChoice(choice, saved);
			if (!picked) {
				notify(ctx, "Could not resolve the selected room.", "warning");
				return;
			}
			targetSlug = picked;
		}

		const summary = saved.find((r) => r.slug === targetSlug);
		if (!summary) {
			notify(
				ctx,
				`No saved room found for slug "${targetSlug}".`,
				"error",
			);
			return;
		}
		if (summary.assembledBy === "assembly") {
			notify(
				ctx,
				`Room "${targetSlug}" was created by /assembly. Use /assembly adjourn ${targetSlug} to remove it (and its member minds).`,
				"error",
			);
			return;
		}

		try {
			deleteSavedRoom(ctx.cwd, targetSlug);
		} catch (error) {
			notify(ctx, errorMessage(error), "error");
			return;
		}
		if (activeRoom?.slug === targetSlug) {
			await leaveRoom(ctx, "saved room closed");
		}
		notify(ctx, `Closed saved room "${targetSlug}".`, "info");
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

		// Capture the session leaf id BEFORE persisting the activation marker.
		// /detach uses this id to fork the session back to its pre-room state.
		const preRoomLeafId = safeGetLeafId(ctx);
		const stateWithLeaf: RoomState = preRoomLeafId
			? { ...validated, preRoomLeafId }
			: validated;

		activeRoom = stateWithLeaf;
		lastInactiveRoom = undefined;
		participantTrackers = buildParticipantTrackers(ctx.cwd, activeRoom);
		orchestrator.loadTranscriptForActive(ctx.cwd);
		orchestrator.resetRuntimeCounters();
		activeRoomStartedAt = activeRoom.activatedAt ?? new Date().toISOString();
		persistState(activeRoom);
		setRoomStatus(ctx, activeRoom);
		syncParticipantWidget(ctx);
		syncObservatoryLens(ctx.cwd);
		notify(
			ctx,
			`${describeActiveRoom(activeRoom, ctx.cwd)}${savedNote} Use /leave to stop routing, or /detach to rewind and preserve this room as an artifact.`,
			"info",
		);
	}

	function buildInactiveRoomState(
		previous: RoomState | undefined,
		reason: string | undefined,
	): RoomState {
		return previous
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
	}

	function tearDownActiveRoom(
		ctx: RoomCommandContext,
		inactive: RoomState,
	): void {
		orchestrator.haltActive();
		stopStatusTicker();
		setWorkingIndicator(ctx, false);
		activeRoom = undefined;
		participantTrackers = [];
		orchestrator.resetTranscriptState();
		orchestrator.resetRuntimeCounters();
		activeRoomStartedAt = undefined;
		orchestrator.clearDirectorOverrides();
		lastInactiveRoom = inactive;
		// Drop cached MindSpecs so the next /room on freshly reads each
		// mind-config.json. Without this, edits to model/tools/fallbackModels
		// between rooms within a single Pi session would be ignored until restart.
		orchestrator.invalidateMindCache();
		persistState(inactive);
		setRoomStatus(ctx, undefined);
		syncParticipantWidget(ctx);
		try {
			clearChamberObservatoryLens(ctx.cwd);
		} catch {
			/* best-effort */
		}
	}

	async function leaveRoom(
		ctx: RoomCommandContext,
		reason?: string,
	): Promise<void> {
		const previous =
			activeRoom ?? latestRoomState(ctx.sessionManager.getEntries());
		const inactive = buildInactiveRoomState(previous, reason);
		tearDownActiveRoom(ctx, inactive);
		notify(
			ctx,
			"Room off. Conversation continues in this session.",
			"info",
		);
	}

	async function detachRoom(ctx: RoomCommandContext): Promise<void> {
		const previous =
			activeRoom ?? latestRoomState(ctx.sessionManager.getEntries());
		const preRoomLeafId = previous?.preRoomLeafId;

		if (!preRoomLeafId || !ctx.fork) {
			const label = previous?.slug ?? previous?.name ?? "the active room";
			notify(
				ctx,
				`Cannot detach ${label}: no pre-room fork point captured for this activation. Falling back to /leave; this round stays in the current session.`,
				"warning",
			);
			await leaveRoom(ctx, "detach fallback");
			return;
		}

		// Tear down room state in the current (artifact) session and persist a
		// "detach" deactivation entry so the artifact is internally consistent.
		const inactive = buildInactiveRoomState(previous, "detach");
		tearDownActiveRoom(ctx, inactive);

		await ctx.waitForIdle?.();

		try {
			const result = await ctx.fork(preRoomLeafId, {
				position: "at",
				withSession: (replacementCtx) => {
					setRoomStatus(replacementCtx, undefined);
					syncParticipantWidget(replacementCtx);
					notify(
						replacementCtx,
						`Detached from room. Session rewound to before activation; the room round is preserved as an artifact.`,
						"info",
					);
				},
			});
			if (result.cancelled) {
				notify(ctx, "Detach cancelled.", "info");
			}
		} catch (error) {
			notify(
				ctx,
				`Detach failed: ${errorMessage(error)}. Room round remains in this session.`,
				"warning",
			);
		}
	}

	function safeGetLeafId(ctx: RoomCommandContext): string | undefined {
		try {
			const id = ctx.sessionManager.getLeafId?.();
			return id ?? undefined;
		} catch {
			return undefined;
		}
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
			value: "close",
			label: "close",
			description:
				"Close (delete) a saved room. Optional <slug>; refuses /assembly rooms.",
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
		"  /leave             leave the active mind or room (conversation stays in this session)",
		"  /detach            detach the active mind or room (rewind to before activation; round preserved as an artifact)",
		"  /room status       show the active room",
		"  /room list         list saved rooms",
		"  /room reset [<slug>] drop per-mind sessions (forkPerMind rooms only)",
		"  /room close [<slug>] close (delete) a saved room (use /assembly adjourn for assembly rooms)",
		"  /room help         show this usage",
		"  /halt              abort the in-flight round (any mode)",
		"  /next <slug>       override the next-speaker pick (group-chat or open-floor)",
		"  /inject <text>     prepend a director note to the next speaker (group-chat or open-floor)",
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
