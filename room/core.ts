// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import path from "node:path";
import { assertInsideProject, slugify } from "../genesis/core.ts";
import { listGenesisMinds, normalizeMindSlug } from "../mind/core.ts";

export const ROOM_MODES = [
	"concurrent",
	"sequential",
	"group-chat",
	"open-floor",
] as const;
export const DEFAULT_ROOM_MODE: RoomMode = "concurrent";
export const DEFAULT_GROUP_CHAT_MAX_TURNS = 4;
export const DEFAULT_GROUP_CHAT_MIN_ROUNDS = 1;
export const DEFAULT_GROUP_CHAT_REPEAT_CAP = 2;
export const DEFAULT_OPEN_FLOOR_MAX_TURNS = 6;
export const DEFAULT_OPEN_FLOOR_MIN_ROUNDS = 1;
export const DEFAULT_OPEN_FLOOR_REPEAT_CAP = 2;
/**
 * Fraction of speakers whose `{action:"end"}` votes the round must EXCEED
 * (after `minRounds` is met) before open-floor closes early. Strict-`>`
 * comparison: with the default 0.5, a tie (e.g. 1/2 or 2/4) does NOT close —
 * "simple majority" means more than half. Set higher to require near-consensus,
 * or lower (down to a value just under the smallest representable ratio) to
 * let any single end vote close the room.
 */
export const DEFAULT_OPEN_FLOOR_END_VOTE_THRESHOLD = 0.5;
export const ROOM_STATE_CUSTOM_TYPE = "room-state";
export const ROOMS_BASE_DIR = ".pi/rooms";
export const SAVED_ROOM_CONFIG_FILE = "room.json";
export const SAVED_ROOM_TRANSCRIPT_FILE = "transcript.jsonl";
export const ROOM_SESSIONS_DIR = "sessions";
export const ROOM_SESSION_FILE_SUFFIX = ".session.jsonl";
export const DEFAULT_TRANSCRIPT_REPLAY_TURNS = 50;
export const TRANSCRIPT_FORMAT_VERSION = 2;

export type RoomMode = (typeof ROOM_MODES)[number];

export type RoomState = {
	active: boolean;
	mode: RoomMode | string;
	participants: string[];
	slug?: string;
	name?: string;
	activatedAt?: string;
	updatedAt?: string;
	deactivatedAt?: string;
	clearedAt?: string;
	clearCount?: number;
	reason?: string;
	/**
	 * Entry id of the session leaf at the moment of room activation. Captured
	 * so /detach can fork the session back to that point, leaving the room
	 * round behind in the original session as an artifact.
	 */
	preRoomLeafId?: string;
};

export type GroupChatOverrides = {
	maxTurns?: number;
	minRounds?: number;
	maxSpeakerRepeats?: number;
};

export type OpenFloorOverrides = {
	maxTurns?: number;
	minRounds?: number;
	maxSpeakerRepeats?: number;
	/**
	 * Fraction (0..1] of speakers whose `end` votes the ratio must EXCEED
	 * (strict `>`) after `minRounds` is met before the room closes. Default
	 * `DEFAULT_OPEN_FLOOR_END_VOTE_THRESHOLD`. A tie does not close.
	 */
	endVoteThreshold?: number;
};

export type SavedRoom = {
	slug: string;
	name: string;
	mode: RoomMode;
	participants: string[];
	createdAt: string;
	updatedAt: string;
	groupChat?: GroupChatOverrides;
	synthesizer?: string;
	concurrentSynthesis?: boolean | "chairman" | string;
	forkPerMind?: boolean;
	/**
	 * Group-chat only. When true, speakers may append a JSON tail suggesting
	 * who should speak next; the moderator is biased toward honoring it. Off by
	 * default to preserve current behavior.
	 */
	speakerAddressing?: boolean;
	/** Open-floor mode tunables (see OpenFloorOverrides). */
	openFloor?: OpenFloorOverrides;
	/**
	 * Open-floor only. Optional opening voice that sets the topic before
	 * speakers route the floor among themselves. `"chairman"` uses the built-in
	 * neutral moderator; any other value must be a participant slug.
	 */
	opener?: "chairman" | string;
	/**
	 * Provenance marker. When set to `"assembly"`, this room was created by
	 * `/assembly` and is eligible for `/assembly adjourn` (full teardown
	 * including member minds). Hand-rolled `/room` rooms omit this field and
	 * must be removed via `/room delete` instead.
	 */
	assembledBy?: "assembly";
};

export type SavedRoomSummary = {
	slug: string;
	name: string;
	mode: RoomMode;
	participants: string[];
	createdAt: string;
	updatedAt: string;
	problems: string[];
	/**
	 * Provenance marker mirrored from `SavedRoom.assembledBy` so callers can
	 * filter without re-reading each room.json.
	 */
	assembledBy?: "assembly";
};

export type RoomTranscriptTurn = {
	user: string;
	assistant: string;
	ts: string;
};

/**
 * Metadata header written as the first line of every transcript.jsonl created
 * after this version. Older transcripts have no header — readers must tolerate
 * both shapes. Use `readRoomTranscriptHeader` for explicit version detection.
 */
export type TranscriptHeader = {
	_meta: true;
	v: number;
	roomSlug: string;
	createdAt: string;
};

export type RoomTranscriptTurnV2 = {
	version: 2;
	user: string;
	turns: Array<{
		speaker: string;
		role: "speaker" | "synthesis";
		content: string;
		turnNumber?: number;
		paletteIndex?: number;
		aborted?: boolean;
	}>;
	mode: RoomMode | string;
	durationMs?: number;
	ts: string;
};

export type RoomCommand =
	| { type: "setupOrStatus" }
	| { type: "on"; mode?: RoomMode; participants?: string }
	| { type: "status" }
	| { type: "list" }
	| { type: "clear" }
	| { type: "mode"; mode: RoomMode }
	| { type: "minds"; participants: string }
	| { type: "reset"; slug?: string }
	| { type: "close"; slug?: string }
	| { type: "error"; message: string };

export type RoomValidationResult = {
	ok: boolean;
	errors: string[];
	state?: RoomState;
};

export type RoomHistoryRound = {
	user: string;
	assistant: string;
};

export type RoomSessionEntry = Record<string, unknown>;

const FUTURE_ROOM_MODES = new Set(["handoff", "magentic"]);
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function parseRoomArgs(args: string): RoomCommand {
	const trimmed = args.trim();
	if (!trimmed) return { type: "setupOrStatus" };

	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const command = tokens[0].toLowerCase();
	const rest = tokens.slice(1);

	switch (command) {
		case "on": {
			if (rest.length === 0) return { type: "on" };
			const first = rest[0].toLowerCase();
			if (isRoomMode(first)) {
				return {
					type: "on",
					mode: first,
					participants: rest.slice(1).join(" ") || undefined,
				};
			}
			if (FUTURE_ROOM_MODES.has(first)) {
				return unsupportedMode(first);
			}
			return { type: "on", participants: rest.join(" ") };
		}
		case "status":
			return rest.length ? tooManyArgs("status") : { type: "status" };
		case "list":
			return rest.length ? tooManyArgs("list") : { type: "list" };
		case "clear":
			return rest.length ? tooManyArgs("clear") : { type: "clear" };
		case "mode": {
			if (rest.length !== 1) {
				return {
					type: "error",
					message: "Usage: /room mode <concurrent|sequential|group-chat>",
				};
			}
			const mode = rest[0].toLowerCase();
			if (!isRoomMode(mode)) return unsupportedMode(mode);
			return { type: "mode", mode };
		}
		case "minds": {
			if (rest.length === 0) {
				return { type: "error", message: "Usage: /room minds <all|slug...>" };
			}
			return { type: "minds", participants: rest.join(" ") };
		}
		case "reset": {
			if (rest.length === 0) return { type: "reset" };
			if (rest.length > 1) return tooManyArgs("reset");
			const slug = rest[0];
			if (!SLUG_PATTERN.test(slug)) {
				return {
					type: "error",
					message: `Room slug must be canonical: got "${slug}".`,
				};
			}
			return { type: "reset", slug };
		}
		case "close": {
			if (rest.length === 0) return { type: "close" };
			if (rest.length > 1) return tooManyArgs("close");
			const slug = rest[0];
			if (!SLUG_PATTERN.test(slug)) {
				return {
					type: "error",
					message: `Room slug must be canonical: got "${slug}".`,
				};
			}
			return { type: "close", slug };
		}
		default:
			return {
				type: "error",
				message:
					"Usage: /room [on|status|list|mode|minds|reset|clear|close]. Use /leave to leave an active room, or /detach to rewind and preserve it as an artifact. Supported v1 modes: concurrent, sequential, group-chat.",
			};
	}
}

export function normalizeParticipantInput(input: string): string[] | "all" {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Participant list cannot be empty.");
	if (trimmed.toLowerCase() === "all") return "all";

	const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
	if (tokens.length === 0) throw new Error("Participant list cannot be empty.");
	if (tokens.some((token) => token.toLowerCase() === "all")) {
		throw new Error('Use either "all" or explicit mind slugs, not both.');
	}

	const seen = new Set<string>();
	const slugs: string[] = [];
	for (const token of tokens) {
		const slug = requireCanonicalSlug(token);
		if (!seen.has(slug)) {
			seen.add(slug);
			slugs.push(slug);
		}
	}
	return slugs;
}

export function resolveRoomParticipants(
	cwd: string,
	input: string | string[] | "all",
): string[] {
	const available = listGenesisMinds(cwd);
	const requested = Array.isArray(input)
		? normalizeParticipantInput(input.join(" "))
		: input === "all"
			? "all"
			: normalizeParticipantInput(input);

	if (requested === "all") {
		if (available.length === 0) {
			throw new Error("No complete Genesis minds found for /room.");
		}
		return available;
	}

	const availableSet = new Set(available);
	const missing = requested.filter((slug) => !availableSet.has(slug));
	if (missing.length > 0) {
		throw new Error(
			`Unknown or incomplete Genesis mind(s): ${missing.join(", ")}. Available: ${available.length ? available.join(", ") : "none"}.`,
		);
	}
	return requested;
}

export function validateRoomState(
	cwd: string,
	state: RoomState,
): RoomValidationResult {
	const errors: string[] = [];
	const mode = state.mode;
	if (!isRoomMode(mode)) {
		errors.push(
			`Unsupported room mode "${String(mode)}". Supported v1 modes: ${ROOM_MODES.join(", ")}.`,
		);
	}

	if (!state.active) {
		return errors.length
			? { ok: false, errors }
			: { ok: true, errors: [], state };
	}

	let participants: string[] = [];
	try {
		participants = resolveRoomParticipants(cwd, state.participants);
	} catch (error) {
		errors.push(errorMessage(error));
	}
	if (participants.length === 0) {
		errors.push("Active rooms require at least one participant.");
	}

	if (errors.length > 0 || !isRoomMode(mode)) return { ok: false, errors };
	return {
		ok: true,
		errors: [],
		state: {
			...state,
			mode,
			participants,
		},
	};
}

export function latestRoomState(
	entries: Array<Record<string, unknown>>,
): RoomState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== ROOM_STATE_CUSTOM_TYPE
		) {
			continue;
		}
		const data = entry.data;
		if (isRoomStateLike(data)) return data as RoomState;
	}
	return undefined;
}

export type RoomDescriptionOverrides = {
	synthesizer?: string;
	groupChat?: GroupChatOverrides;
	speakerAddressing?: boolean;
	openFloor?: OpenFloorOverrides;
	opener?: string;
};

export function describeRoomState(
	state: RoomState | undefined,
	overrides?: RoomDescriptionOverrides,
): string {
	if (!state?.active) return "Room off.";
	const participants = state.participants.join(", ");
	const base = `Room active: ${state.mode} with ${state.participants.length} mind${state.participants.length === 1 ? "" : "s"} (${participants}).`;
	if (state.mode === "group-chat") {
		const moderator = overrides?.synthesizer ?? "chairman (built-in)";
		const minRounds =
			overrides?.groupChat?.minRounds ?? DEFAULT_GROUP_CHAT_MIN_ROUNDS;
		const maxTurns =
			overrides?.groupChat?.maxTurns ?? DEFAULT_GROUP_CHAT_MAX_TURNS;
		const repeatCap =
			overrides?.groupChat?.maxSpeakerRepeats ?? DEFAULT_GROUP_CHAT_REPEAT_CAP;
		const addressing = overrides?.speakerAddressing
			? " Speaker addressing: on."
			: "";
		return `${base} Moderator: ${moderator}. Limits: ${minRounds} min round, ${maxTurns} max turns, ${repeatCap} repeat cap.${addressing}`;
	}
	if (state.mode === "open-floor") {
		const minRounds =
			overrides?.openFloor?.minRounds ?? DEFAULT_OPEN_FLOOR_MIN_ROUNDS;
		const maxTurns =
			overrides?.openFloor?.maxTurns ?? DEFAULT_OPEN_FLOOR_MAX_TURNS;
		const repeatCap =
			overrides?.openFloor?.maxSpeakerRepeats ?? DEFAULT_OPEN_FLOOR_REPEAT_CAP;
		const endThreshold =
			overrides?.openFloor?.endVoteThreshold ?? DEFAULT_OPEN_FLOOR_END_VOTE_THRESHOLD;
		const opener = overrides?.opener
			? overrides.opener === "chairman"
				? "chairman (built-in)"
				: overrides.opener
			: "first participant";
		const synthesizerNote = overrides?.synthesizer
			? ` Synthesizer: ${overrides.synthesizer}.`
			: "";
		return `${base} Opener: ${opener}.${synthesizerNote} Limits: ${minRounds} min round, ${maxTurns} max turns, ${repeatCap} repeat cap, ${Math.round(endThreshold * 100)}% end-vote.`;
	}
	return base;
}

export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&apos;")
		.replace(/"/g, "&quot;");
}

export function buildRoomHistoryFromEntries(
	entries: RoomSessionEntry[],
	maxRounds = 2,
): RoomHistoryRound[] {
	const scopedEntries = entries.slice(roomHistoryStartIndex(entries));
	const rounds: RoomHistoryRound[] = [];
	let pendingUser: string | undefined;

	for (const entry of scopedEntries) {
		if (entry?.type !== "message") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		const text = extractTextContent((message as { content?: unknown }).content);
		if (!text.trim()) continue;

		if (role === "user") {
			pendingUser = text.trim();
			continue;
		}

		if (role === "assistant" && pendingUser) {
			rounds.push({ user: pendingUser, assistant: text.trim() });
			pendingUser = undefined;
		}
	}

	return rounds.slice(-Math.max(0, maxRounds));
}

function isRoomMode(value: string): value is RoomMode {
	return (ROOM_MODES as readonly string[]).includes(value);
}

function roomHistoryStartIndex(entries: RoomSessionEntry[]): number {
	let start = 0;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== ROOM_STATE_CUSTOM_TYPE
		) {
			continue;
		}
		const data = entry.data;
		if (isRoomStateLike(data)) start = i + 1;
	}
	return start;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}
	return textParts.join("\n");
}

function requireCanonicalSlug(input: string): string {
	const slug = normalizeMindSlug(input);
	if (slug !== input || !SLUG_PATTERN.test(input)) {
		throw new Error(
			`Room participants must be Genesis mind slugs, not display names: ${input}`,
		);
	}
	return slug;
}

function unsupportedMode(mode: string): RoomCommand {
	return {
		type: "error",
		message: `Unsupported room mode "${mode}". Supported v1 modes: ${ROOM_MODES.join(", ")}. Handoff and magentic are future modes only.`,
	};
}

function tooManyArgs(command: string): RoomCommand {
	return { type: "error", message: `Usage: /room ${command}` };
}

function isRoomStateLike(value: unknown): value is RoomState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RoomState>;
	return (
		typeof candidate.active === "boolean" &&
		typeof candidate.mode === "string" &&
		Array.isArray(candidate.participants)
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function resolveRoomsBasePath(cwd: string): string {
	const root = path.resolve(cwd);
	const base = path.join(root, ROOMS_BASE_DIR);
	assertInsideProject(root, base, "roomsBasePath");
	return base;
}

export function resolveSavedRoomPaths(
	cwd: string,
	slug: string,
): { roomDir: string; configPath: string; transcriptPath: string } {
	const root = path.resolve(cwd);
	if (!SLUG_PATTERN.test(slug)) {
		throw new Error(`Invalid room slug: ${slug}`);
	}
	const base = resolveRoomsBasePath(root);
	const roomDir = path.join(base, slug);
	assertInsideProject(root, roomDir, "savedRoomDir");
	return {
		roomDir,
		configPath: path.join(roomDir, SAVED_ROOM_CONFIG_FILE),
		transcriptPath: path.join(roomDir, SAVED_ROOM_TRANSCRIPT_FILE),
	};
}

/**
 * Resolve the directory under which per-mind session files live for a saved
 * room: `.pi/rooms/<roomSlug>/sessions/`. Used by item-5 forked-per-mind mode.
 */
export function resolveRoomSessionsDir(cwd: string, roomSlug: string): string {
	const { roomDir } = resolveSavedRoomPaths(cwd, roomSlug);
	const sessionsDir = path.join(roomDir, ROOM_SESSIONS_DIR);
	assertInsideProject(path.resolve(cwd), sessionsDir, "roomSessionsDir");
	return sessionsDir;
}

/**
 * Resolve the per-mind session file path inside a saved room:
 * `.pi/rooms/<roomSlug>/sessions/<mindSlug>.session.jsonl`.
 */
export function resolveRoomSessionPath(
	cwd: string,
	roomSlug: string,
	mindSlug: string,
): string {
	if (!SLUG_PATTERN.test(mindSlug)) {
		throw new Error(`Invalid mind slug for room session: ${mindSlug}`);
	}
	const sessionsDir = resolveRoomSessionsDir(cwd, roomSlug);
	const file = path.join(sessionsDir, `${mindSlug}${ROOM_SESSION_FILE_SUFFIX}`);
	assertInsideProject(path.resolve(cwd), file, "roomSessionFile");
	return file;
}

/** List mind slugs that currently have a session file in this saved room. */
export function listRoomSessions(cwd: string, roomSlug: string): string[] {
	let sessionsDir: string;
	try {
		sessionsDir = resolveRoomSessionsDir(cwd, roomSlug);
	} catch {
		return [];
	}
	if (!existsSync(sessionsDir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(sessionsDir)) {
		if (!entry.endsWith(ROOM_SESSION_FILE_SUFFIX)) continue;
		const slug = entry.slice(0, -ROOM_SESSION_FILE_SUFFIX.length);
		if (SLUG_PATTERN.test(slug)) out.push(slug);
	}
	return out.sort();
}

/** Remove the per-mind session directory for this saved room. Returns the
 * count of session files dropped (0 if the directory did not exist). */
export function dropRoomSessions(cwd: string, roomSlug: string): number {
	const before = listRoomSessions(cwd, roomSlug);
	let sessionsDir: string;
	try {
		sessionsDir = resolveRoomSessionsDir(cwd, roomSlug);
	} catch {
		return 0;
	}
	if (existsSync(sessionsDir)) {
		rmSync(sessionsDir, { recursive: true, force: true });
	}
	return before.length;
}

export function normalizeRoomSlug(input: string): string {
	const trimmed = (input ?? "").trim();
	if (!trimmed) {
		throw new Error(
			"Room name must contain at least one alphanumeric character.",
		);
	}
	const slug = slugify(trimmed).replace(/-+/g, "-").replace(/^-|-$/g, "");
	if (!slug || !SLUG_PATTERN.test(slug)) {
		throw new Error(
			`Could not derive a valid room slug from "${input}". Use letters, numbers, or hyphens.`,
		);
	}
	return slug;
}

export function isSavedRoomLike(value: unknown): value is SavedRoom {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SavedRoom>;
	return (
		typeof candidate.slug === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.mode === "string" &&
		Array.isArray(candidate.participants) &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string"
	);
}

function coerceGroupChatOverrides(value: unknown): GroupChatOverrides | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const out: GroupChatOverrides = {};
	if (typeof raw.maxTurns === "number" && Number.isFinite(raw.maxTurns) && raw.maxTurns > 0) {
		out.maxTurns = Math.floor(raw.maxTurns);
	}
	if (typeof raw.minRounds === "number" && Number.isFinite(raw.minRounds) && raw.minRounds > 0) {
		out.minRounds = Math.floor(raw.minRounds);
	}
	if (
		typeof raw.maxSpeakerRepeats === "number" &&
		Number.isFinite(raw.maxSpeakerRepeats) &&
		raw.maxSpeakerRepeats > 0
	) {
		out.maxSpeakerRepeats = Math.floor(raw.maxSpeakerRepeats);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function coerceSynthesizer(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}

function coerceConcurrentSynthesis(
	value: unknown,
): boolean | "chairman" | string | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed === "chairman") return "chairman";
	return SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}

function coerceForkPerMind(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function coerceSpeakerAddressing(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function coerceOpenFloorOverrides(value: unknown): OpenFloorOverrides | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const out: OpenFloorOverrides = {};
	if (
		typeof raw.maxTurns === "number" &&
		Number.isFinite(raw.maxTurns) &&
		raw.maxTurns > 0
	) {
		out.maxTurns = Math.floor(raw.maxTurns);
	}
	if (
		typeof raw.minRounds === "number" &&
		Number.isFinite(raw.minRounds) &&
		raw.minRounds > 0
	) {
		out.minRounds = Math.floor(raw.minRounds);
	}
	if (
		typeof raw.maxSpeakerRepeats === "number" &&
		Number.isFinite(raw.maxSpeakerRepeats) &&
		raw.maxSpeakerRepeats > 0
	) {
		out.maxSpeakerRepeats = Math.floor(raw.maxSpeakerRepeats);
	}
	if (
		typeof raw.endVoteThreshold === "number" &&
		Number.isFinite(raw.endVoteThreshold) &&
		raw.endVoteThreshold > 0 &&
		raw.endVoteThreshold <= 1
	) {
		out.endVoteThreshold = raw.endVoteThreshold;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function coerceOpener(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed === "chairman") return "chairman";
	return SLUG_PATTERN.test(trimmed) ? trimmed : undefined;
}

function coerceAssembledBy(value: unknown): "assembly" | undefined {
	return value === "assembly" ? "assembly" : undefined;
}

function applySavedRoomOptionals(
	target: SavedRoom,
	source: Partial<SavedRoom> | Record<string, unknown>,
): SavedRoom {
	const groupChat = coerceGroupChatOverrides((source as Record<string, unknown>).groupChat);
	if (groupChat) target.groupChat = groupChat;
	const synthesizer = coerceSynthesizer((source as Record<string, unknown>).synthesizer);
	if (synthesizer) target.synthesizer = synthesizer;
	const concurrentSynthesis = coerceConcurrentSynthesis(
		(source as Record<string, unknown>).concurrentSynthesis,
	);
	if (concurrentSynthesis !== undefined) target.concurrentSynthesis = concurrentSynthesis;
	const forkPerMind = coerceForkPerMind((source as Record<string, unknown>).forkPerMind);
	if (forkPerMind !== undefined) target.forkPerMind = forkPerMind;
	const speakerAddressing = coerceSpeakerAddressing(
		(source as Record<string, unknown>).speakerAddressing,
	);
	if (speakerAddressing !== undefined) target.speakerAddressing = speakerAddressing;
	const openFloor = coerceOpenFloorOverrides(
		(source as Record<string, unknown>).openFloor,
	);
	if (openFloor) target.openFloor = openFloor;
	const opener = coerceOpener((source as Record<string, unknown>).opener);
	if (opener) target.opener = opener;
	const assembledBy = coerceAssembledBy(
		(source as Record<string, unknown>).assembledBy,
	);
	if (assembledBy) target.assembledBy = assembledBy;
	return target;
}

export function readSavedRoom(cwd: string, slug: string): SavedRoom {
	const { configPath } = resolveSavedRoomPaths(cwd, slug);
	if (!existsSync(configPath)) {
		throw new Error(`No saved room found at ${configPath}.`);
	}
	const raw = readFileSync(configPath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Saved room at ${configPath} is not valid JSON: ${errorMessage(error)}`,
		);
	}
	if (!isSavedRoomLike(parsed)) {
		throw new Error(`Saved room at ${configPath} is missing required fields.`);
	}
	if (parsed.slug !== slug) {
		throw new Error(
			`Saved room slug mismatch: file ${slug} contains slug "${parsed.slug}".`,
		);
	}
	const base: SavedRoom = {
		slug: parsed.slug,
		name: parsed.name,
		mode: parsed.mode,
		participants: parsed.participants,
		createdAt: parsed.createdAt,
		updatedAt: parsed.updatedAt,
	};
	return applySavedRoomOptionals(base, parsed as Record<string, unknown>);
}

/**
 * Read a saved room without throwing — returns undefined on any error.
 * Useful in hot paths (per-turn config lookup) where missing or malformed
 * config should fall back to defaults rather than abort the round.
 */
export function safeReadSavedRoom(cwd: string, slug: string): SavedRoom | undefined {
	try {
		return readSavedRoom(cwd, slug);
	} catch {
		return undefined;
	}
}

export function writeSavedRoom(cwd: string, room: SavedRoom): SavedRoom {
	if (!isRoomMode(room.mode)) {
		throw new Error(
			`Saved rooms only accept v1 modes (${ROOM_MODES.join(", ")}). Got "${room.mode}".`,
		);
	}
	const slug = normalizeRoomSlug(room.slug);
	if (slug !== room.slug) {
		throw new Error(`Saved room slug must be canonical: got "${room.slug}".`);
	}
	const { roomDir, configPath } = resolveSavedRoomPaths(cwd, slug);
	mkdirSync(roomDir, { recursive: true });
	const normalized: SavedRoom = {
		slug,
		name: room.name?.trim() || slug,
		mode: room.mode,
		participants: [...room.participants],
		createdAt: room.createdAt || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	applySavedRoomOptionals(normalized, room);
	writeFileSync(
		configPath,
		`${JSON.stringify(normalized, null, 2)}\n`,
		"utf-8",
	);
	return normalized;
}

export function deleteSavedRoom(cwd: string, slug: string): void {
	const { roomDir } = resolveSavedRoomPaths(cwd, slug);
	if (!existsSync(roomDir)) return;
	rmSync(roomDir, { recursive: true, force: true });
}

export function listSavedRooms(cwd: string): SavedRoomSummary[] {
	const base = resolveRoomsBasePath(cwd);
	if (!existsSync(base)) return [];
	let entries: string[];
	try {
		entries = readdirSync(base);
	} catch {
		return [];
	}
	const summaries: SavedRoomSummary[] = [];
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (!SLUG_PATTERN.test(entry)) continue;
		const { configPath } = resolveSavedRoomPaths(cwd, entry);
		if (!existsSync(configPath)) continue;
		const problems: string[] = [];
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			problems.push(`config not valid JSON: ${errorMessage(error)}`);
			continue;
		}
		if (!isSavedRoomLike(parsed)) {
			problems.push("config is missing required fields");
			continue;
		}
		const candidate = parsed;
		if (!isRoomMode(candidate.mode)) {
			problems.push(`unsupported mode "${candidate.mode}"`);
		}
		const validation = validateRoomState(cwd, {
			active: true,
			mode: candidate.mode,
			participants: candidate.participants,
		});
		if (!validation.ok) {
			problems.push(...validation.errors);
		}
		const assembledBy = coerceAssembledBy(
			(candidate as Record<string, unknown>).assembledBy,
		);
		summaries.push({
			slug: candidate.slug,
			name: candidate.name,
			mode: isRoomMode(candidate.mode) ? candidate.mode : DEFAULT_ROOM_MODE,
			participants: candidate.participants,
			createdAt: candidate.createdAt,
			updatedAt: candidate.updatedAt,
			problems,
			...(assembledBy ? { assembledBy } : {}),
		});
	}
	summaries.sort((a, b) => a.slug.localeCompare(b.slug));
	return summaries;
}

function buildTranscriptHeader(
	slug: string,
	createdAt: string = new Date().toISOString(),
): TranscriptHeader {
	return {
		_meta: true,
		v: TRANSCRIPT_FORMAT_VERSION,
		roomSlug: slug,
		createdAt,
	};
}

function isTranscriptHeaderLike(value: unknown): value is TranscriptHeader {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<TranscriptHeader>;
	return (
		candidate._meta === true &&
		typeof candidate.v === "number" &&
		typeof candidate.roomSlug === "string"
	);
}

/**
 * Append a V2 turn to the transcript. The V2 shape preserves per-speaker
 * attribution which the prompt builder uses to render `<chatroom-history>`
 * with real speaker slugs instead of a flat blob.
 *
 * On first append the file gets a single header line declaring the format
 * version. Existing V1-shaped files are left untouched (no migration); the
 * reader handles mixed shapes.
 */
export function appendRoomTranscriptTurn(
	cwd: string,
	slug: string,
	turn: RoomTranscriptTurnV2,
): void {
	const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, slug);
	mkdirSync(roomDir, { recursive: true });
	let payload = "";
	if (!existsSync(transcriptPath)) {
		payload += `${JSON.stringify(buildTranscriptHeader(slug))}\n`;
	}
	payload += `${JSON.stringify({
		version: 2,
		user: turn.user,
		turns: turn.turns,
		mode: turn.mode,
		...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
		ts: turn.ts || new Date().toISOString(),
	})}\n`;
	appendFileSync(transcriptPath, payload, "utf-8");
}

/**
 * Lift a V1 transcript line into V2 shape. V1 had a single flattened
 * `assistant` text per round; we represent it as a single inner turn whose
 * speaker is the synthetic slug `"room"` so that downstream consumers can
 * uniformly walk V2 structure even for pre-upgrade transcripts.
 */
function liftV1TurnToV2(turn: RoomTranscriptTurn): RoomTranscriptTurnV2 {
	return {
		version: 2,
		user: turn.user,
		mode: "concurrent",
		ts: turn.ts || "",
		turns: [
			{
				speaker: "room",
				role: "speaker",
				content: turn.assistant,
			},
		],
	};
}

function isV2InnerTurnLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const t = value as Record<string, unknown>;
	if (typeof t.speaker !== "string" || !t.speaker) return false;
	if (typeof t.content !== "string") return false;
	if (t.role !== "speaker" && t.role !== "synthesis") return false;
	if (
		t.turnNumber !== undefined &&
		(typeof t.turnNumber !== "number" || !Number.isFinite(t.turnNumber))
	)
		return false;
	if (
		t.paletteIndex !== undefined &&
		(typeof t.paletteIndex !== "number" || !Number.isFinite(t.paletteIndex))
	)
		return false;
	if (t.aborted !== undefined && typeof t.aborted !== "boolean") return false;
	return true;
}

function isV2TurnLike(value: unknown): value is RoomTranscriptTurnV2 {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RoomTranscriptTurnV2>;
	if (
		candidate.version !== 2 ||
		typeof candidate.user !== "string" ||
		typeof candidate.mode !== "string" ||
		!Array.isArray(candidate.turns)
	)
		return false;
	// Reject the whole line if any inner turn is malformed. The reader's
	// contract is that bad lines are skipped silently rather than feeding
	// undefined speaker/content into prompt rendering downstream.
	return candidate.turns.every(isV2InnerTurnLike);
}

function isV1TurnLike(value: unknown): value is RoomTranscriptTurn {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<RoomTranscriptTurn>;
	return (
		typeof candidate.user === "string" &&
		typeof candidate.assistant === "string"
	);
}

export function readRoomTranscriptHeader(
	cwd: string,
	slug: string,
): TranscriptHeader | undefined {
	const { transcriptPath } = resolveSavedRoomPaths(cwd, slug);
	if (!existsSync(transcriptPath)) return undefined;
	const raw = readFileSync(transcriptPath, "utf-8");
	const firstLine = raw.split(/\r?\n/, 1)[0];
	if (!firstLine || !firstLine.trim()) return undefined;
	try {
		const parsed = JSON.parse(firstLine);
		return isTranscriptHeaderLike(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read a transcript and return turns in the V2 shape.
 *
 * Mixed-shape files are tolerated: V1 lines are lifted to V2 on the fly via
 * `liftV1TurnToV2` so callers always see uniform structure. The header line
 * (if present) is skipped. Malformed lines are dropped silently.
 */
export function readRoomTranscript(
	cwd: string,
	slug: string,
	maxTurns = DEFAULT_TRANSCRIPT_REPLAY_TURNS,
): RoomTranscriptTurnV2[] {
	const { transcriptPath } = resolveSavedRoomPaths(cwd, slug);
	if (!existsSync(transcriptPath)) return [];
	const raw = readFileSync(transcriptPath, "utf-8");
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const turns: RoomTranscriptTurnV2[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (isTranscriptHeaderLike(parsed)) continue;
			if (isV2TurnLike(parsed)) {
				turns.push({
					version: 2,
					user: parsed.user,
					turns: parsed.turns,
					mode: parsed.mode,
					...(typeof parsed.durationMs === "number"
						? { durationMs: parsed.durationMs }
						: {}),
					ts: typeof parsed.ts === "string" ? parsed.ts : "",
				});
				continue;
			}
			if (isV1TurnLike(parsed)) {
				turns.push(
					liftV1TurnToV2({
						user: parsed.user,
						assistant: parsed.assistant,
						ts: typeof parsed.ts === "string" ? parsed.ts : "",
					}),
				);
			}
		} catch {
			// Skip malformed lines instead of failing the whole replay.
		}
	}
	return turns.slice(-Math.max(0, maxTurns));
}

