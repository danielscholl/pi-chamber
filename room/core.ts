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

export const ROOM_MODES = ["concurrent", "sequential", "group-chat"] as const;
export const DEFAULT_ROOM_MODE: RoomMode = "concurrent";
export const DEFAULT_GROUP_CHAT_MAX_TURNS = 4;
export const DEFAULT_GROUP_CHAT_MIN_ROUNDS = 1;
export const DEFAULT_GROUP_CHAT_REPEAT_CAP = 2;
export const ROOM_STATE_CUSTOM_TYPE = "room-state";
export const ROOMS_BASE_DIR = ".pi/rooms";
export const SAVED_ROOM_CONFIG_FILE = "room.json";
export const SAVED_ROOM_TRANSCRIPT_FILE = "transcript.jsonl";
export const DEFAULT_TRANSCRIPT_REPLAY_TURNS = 50;
export const TRANSCRIPT_FORMAT_VERSION = 1;

export type RoomMode = (typeof ROOM_MODES)[number];

export type RoomState = {
	active: boolean;
	mode: RoomMode | string;
	participants: string[];
	moderator?: string;
	slug?: string;
	name?: string;
	activatedAt?: string;
	updatedAt?: string;
	deactivatedAt?: string;
	clearedAt?: string;
	clearCount?: number;
	reason?: string;
	returnSessionFile?: string;
};

export type SavedRoom = {
	slug: string;
	name: string;
	mode: RoomMode;
	participants: string[];
	moderator?: string;
	createdAt: string;
	updatedAt: string;
};

export type SavedRoomSummary = {
	slug: string;
	name: string;
	mode: RoomMode;
	participants: string[];
	moderator?: string;
	createdAt: string;
	updatedAt: string;
	problems: string[];
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

export type RoomStateEntry = RoomState;

export type RoomTranscriptTurnV2 = {
	version: 2;
	user: string;
	turns: Array<{
		speaker: string;
		role: "speaker" | "moderator" | "synthesis";
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

export type BuildRoomPromptInput = {
	state: RoomState;
	history?: RoomHistoryRound[];
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
		default:
			return {
				type: "error",
				message:
					"Usage: /room [on|status|list|mode|minds|clear]. Use /exit to leave an active room. Supported v1 modes: concurrent, sequential, group-chat.",
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
			moderator: undefined,
		},
	};
}

export function latestRoomState(
	entries: Array<Record<string, unknown>>,
): RoomStateEntry | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry?.type !== "custom" ||
			entry.customType !== ROOM_STATE_CUSTOM_TYPE
		) {
			continue;
		}
		const data = entry.data;
		if (isRoomStateLike(data)) return data as RoomStateEntry;
	}
	return undefined;
}

export function describeRoomState(state: RoomState | undefined): string {
	if (!state?.active) return "Room off.";
	const participants = state.participants.join(", ");
	const base = `Room active: ${state.mode} with ${state.participants.length} mind${state.participants.length === 1 ? "" : "s"} (${participants}).`;
	if (state.mode !== "group-chat") return base;
	return `${base} Moderator: chairman (built-in). Limits: ${DEFAULT_GROUP_CHAT_MIN_ROUNDS} min round, ${DEFAULT_GROUP_CHAT_MAX_TURNS} max turns, ${DEFAULT_GROUP_CHAT_REPEAT_CAP} repeat cap.`;
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

/**
 * @deprecated Legacy system-prompt builder for the prompt-injection era. The
 * extension now owns each room turn directly via `on("input")` and spawns
 * child pi processes per mind, so the parent assistant never receives this
 * prompt. Kept exported for backward compatibility with external callers.
 */
export function buildRoomSystemPrompt(input: BuildRoomPromptInput): string {
	const state = input.state;
	const participants = state.participants;
	const participantList = participants.map((slug) => `- ${slug}`).join("\n");
	const participantXml = participants
		.map((slug) => `  <mind slug="${xmlEscape(slug)}" />`)
		.join("\n");
	const history = renderHistory(input.history ?? []);
	const groupChatModerator = "chairman";

	return `# Chamber-style Multi-mind Room Active

Normal user prompts are chatroom messages for the active room. Slash commands still behave normally and must not be routed as room messages.

You are the parent orchestration assistant. Do not answer as a participant, do not roleplay the Genesis minds, and do not fabricate participant responses. Route room messages to selected project Genesis minds with the existing \`subagent\` tool using \`context: "fresh"\` and \`agentScope: "project"\`.

## Active room

- Mode: ${state.mode}
- Participants (${participants.length}):
${participantList || "- none"}${state.mode === "group-chat" ? `\n- Moderator: ${groupChatModerator}` : ""}

<room_participants>
${participantXml}
</room_participants>

## Delegated task prompt contract

Every task prompt sent to a mind must include:

1. An identity prefix such as \`You are participating as <slug>, a Genesis mind in this Pi room.\`
2. The current room mode: \`${state.mode}\`.
3. The active participant slug list: ${participants.join(", ") || "none"}.
4. The user's current room message.
5. At most the last two visible room rounds in XML-escaped \`<chatroom_history>\`.

Do not include hidden moderator control JSON in visible answers or future room history. Strip control JSON from the visible transcript/history.

<chatroom_history>
${history}
</chatroom_history>

## V1 routing rules

### concurrent

For concurrent mode, call all selected minds in parallel and then synthesize:

\`subagent({ tasks: [{ agent, task }, ...], context: "fresh", agentScope: "project", concurrency: ${participants.length} })\`

Use one task per participant. Present visible output as per-mind sections plus a concise synthesis.

### sequential

For sequential mode, call minds in participant order. Each later mind must see prior responses from the same round in its task prompt:

\`subagent({ chain: [{ agent, task }, ...], context: "fresh", agentScope: "project", clarify: false })\`

If finer control is needed, use explicit one-at-a-time \`subagent\` calls with \`context: "fresh"\` and \`agentScope: "project"\`. Present visible output as per-mind sections plus a concise synthesis.

### group-chat

For group-chat mode, ask the moderator mind (${groupChatModerator}) for strict JSON speaker selection, hide that JSON, call only the selected speaker mind, and repeat within these caps: minimum rounds ${DEFAULT_GROUP_CHAT_MIN_ROUNDS}, maximum turns ${DEFAULT_GROUP_CHAT_MAX_TURNS}, repeat cap ${DEFAULT_GROUP_CHAT_REPEAT_CAP}. Then ask the moderator for a synthesis. Moderator control prompts and responses are routing metadata, not visible transcript content.

Required moderator control shape:

\`subagent({ tasks: [{ agent: "${groupChatModerator}", task: "Active participant slugs: ${participants.join(", ")}. Return strict JSON choosing next_speaker as exactly one of those slugs and a brief reason." }], context: "fresh", agentScope: "project", concurrency: 1 })\`

After selecting a speaker, call that speaker with \`context: "fresh"\` and \`agentScope: "project"\`, including the room message and visible history. Present visible output as per-mind sections plus a concise synthesis.

## Future modes

Handoff and magentic are future modes only. They are not accepted v1 room modes and must not be simulated unless a later extension explicitly enables them.`;
}

function renderHistory(history: RoomHistoryRound[]): string {
	const recent = history.slice(-2);
	if (recent.length === 0)
		return "  <!-- no visible prior room rounds provided -->";
	return recent
		.map(
			(round, index) =>
				`  <round index="${index + 1}">\n    <user>${xmlEscape(round.user)}</user>\n    <assistant>${xmlEscape(round.assistant)}</assistant>\n  </round>`,
		)
		.join("\n");
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
	return parsed;
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
		summaries.push({
			slug: candidate.slug,
			name: candidate.name,
			mode: isRoomMode(candidate.mode) ? candidate.mode : DEFAULT_ROOM_MODE,
			participants: candidate.participants,
			createdAt: candidate.createdAt,
			updatedAt: candidate.updatedAt,
			problems,
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

export function appendRoomTranscriptTurn(
	cwd: string,
	slug: string,
	turn: RoomTranscriptTurn,
): void {
	const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, slug);
	mkdirSync(roomDir, { recursive: true });
	let payload = "";
	if (!existsSync(transcriptPath)) {
		payload += `${JSON.stringify(buildTranscriptHeader(slug))}\n`;
	}
	payload += `${JSON.stringify({
		user: turn.user,
		assistant: turn.assistant,
		ts: turn.ts || new Date().toISOString(),
	})}\n`;
	appendFileSync(transcriptPath, payload, "utf-8");
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

export function readRoomTranscript(
	cwd: string,
	slug: string,
	maxTurns = DEFAULT_TRANSCRIPT_REPLAY_TURNS,
): RoomTranscriptTurn[] {
	const { transcriptPath } = resolveSavedRoomPaths(cwd, slug);
	if (!existsSync(transcriptPath)) return [];
	const raw = readFileSync(transcriptPath, "utf-8");
	const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const turns: RoomTranscriptTurn[] = [];
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (isTranscriptHeaderLike(parsed)) continue;
			const turn = parsed as Partial<RoomTranscriptTurn>;
			if (
				typeof turn?.user === "string" &&
				typeof turn?.assistant === "string"
			) {
				turns.push({
					user: turn.user,
					assistant: turn.assistant,
					ts: typeof turn.ts === "string" ? turn.ts : "",
				});
			}
		} catch {
			// Skip malformed lines instead of failing the whole replay.
		}
	}
	return turns.slice(-Math.max(0, maxTurns));
}

export function mergeRoomHistory(
	sessionRounds: RoomHistoryRound[],
	transcriptTurns: RoomTranscriptTurn[],
	targetCount: number,
): RoomHistoryRound[] {
	if (sessionRounds.length >= targetCount)
		return sessionRounds.slice(-targetCount);
	const need = targetCount - sessionRounds.length;
	const padded: RoomHistoryRound[] = transcriptTurns
		.slice(-need)
		.map((turn) => ({ user: turn.user, assistant: turn.assistant }));
	return [...padded, ...sessionRounds];
}
