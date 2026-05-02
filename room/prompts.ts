/**
 * room-prompts — pure prompt builders for room speakers and moderator.
 *
 * Identity prefix and chatroom-history shape are adapted from the chamber project's
 * ChatroomService/buildPrompt; moderator prompts and JSON parser are adapted from
 * chamber's GroupChatStrategy.
 */

import { xmlEscape } from "./core.ts";

/**
 * Stable slug for the built-in chairman moderator. Group-chat rooms always
 * use this synthetic moderator so every Genesis mind in the room can speak.
 */
export const CHAIRMAN_SLUG = "chairman";

/**
 * Built-in chairman moderator persona. Neutral, procedural, no project memory.
 * The chairman never participates as a speaker — it only routes the floor and
 * synthesizes at close.
 */
export function buildChairmanPersona(): string {
	return `You are the Chairman, a neutral built-in moderator for a Pi room group-chat.

You have no personality, no project memory, and no opinions of your own. You are not a Genesis mind. You exist only to route the floor and synthesize at close.

Responsibilities:
- When asked to make a moderator decision, follow the JSON output format in the user prompt EXACTLY. No other text. No markdown. No explanation.
- When asked to synthesize, write a concise, even-handed recap of what the participants said. Note agreement, disagreement, and the final recommendation. Do not insert your own analysis or opinions.
- Never roleplay or speak as a participant. Never answer the user's question yourself.
`;
}

export const CONTROL_ACTIONS = new Set([
	"assign",
	"complete",
	"update-plan",
	"handoff",
	"done",
	"direct",
	"close",
]);

export type ChamberHistoryTurn = {
	speaker: string;
	content: string;
	turnNumber?: number;
	isModerator?: boolean;
};

export type BuildSpeakerPromptInput = {
	mindSlug: string;
	mode: string;
	participants: string[];
	userMessage: string;
	history: ChamberHistoryTurn[];
	moderatorDirection?: string;
};

export type ModeratorPhase = "open" | "moderate" | "may_close";

export type BuildModeratorPromptInput = {
	moderatorSlug: string;
	speakers: string[];
	userMessage: string;
	transcript: ChamberHistoryTurn[];
	phase: ModeratorPhase;
	spokenSlugs: Set<string>;
};

export type BuildSynthesisPromptInput = {
	moderatorSlug: string;
	participants: string[];
	userMessage: string;
	transcript: ChamberHistoryTurn[];
};

export type ModeratorDecision = {
	nextSpeaker: string;
	direction: string;
	action: "direct" | "close";
};

/** Build the per-mind speaker prompt for a single turn. */
export function buildSpeakerPrompt(input: BuildSpeakerPromptInput): string {
	const identity = `<identity>You are ${xmlEscape(input.mindSlug)}, a Genesis mind in this Pi room. Stay in character. Respond as this persona would — use the voice, perspective, and expertise from your identity files. Do not break character or sound like the other participants.</identity>`;

	const room = `<room mode="${xmlEscape(input.mode)}" participants="${xmlEscape(input.participants.join(", "))}" />`;

	const historyXml = renderChatroomHistory(input.history, input.participants);
	const directionXml = input.moderatorDirection
		? `<moderator-direction>${xmlEscape(input.moderatorDirection)}</moderator-direction>\nThe moderator has asked you to specifically address: ${xmlEscape(input.moderatorDirection)}\n`
		: "";

	const message = `<message sender="You">${xmlEscape(input.userMessage)}</message>`;

	const blocks = [identity, room, historyXml, directionXml, message].filter(
		(b) => b && b.trim().length > 0,
	);
	return blocks.join("\n\n");
}

function renderChatroomHistory(
	history: ChamberHistoryTurn[],
	participants: string[],
): string {
	if (history.length === 0) return "";
	let xml = `<chatroom-history participants="${xmlEscape(participants.join(", "))}">\n`;
	for (const turn of history) {
		const cleaned = stripControlJson(turn.content);
		xml += `  <message sender="${xmlEscape(turn.speaker)}"`;
		if (turn.turnNumber !== undefined)
			xml += ` turn="${turn.turnNumber}"`;
		if (turn.isModerator) xml += ' role="moderator"';
		xml += `>${xmlEscape(cleaned)}</message>\n`;
	}
	xml += `</chatroom-history>`;
	return xml;
}

/** Build the moderator decision prompt for one of the three phases. */
export function buildModeratorPrompt(input: BuildModeratorPromptInput): string {
	const participantNames = input.speakers.join(", ");
	const spokenNames = input.speakers
		.filter((s) => input.spokenSlugs.has(s))
		.join(", ");
	const remainingNames = input.speakers
		.filter((s) => !input.spokenSlugs.has(s))
		.join(", ");

	let xml = `<group-chat-moderation participants="${xmlEscape(participantNames)}" phase="${input.phase}">\n`;
	xml += `  <user-question>${xmlEscape(input.userMessage)}</user-question>\n`;

	if (input.transcript.length > 0) {
		xml += `  <transcript>\n`;
		for (const turn of input.transcript) {
			xml += `    <turn speaker="${xmlEscape(turn.speaker)}" turn="${turn.turnNumber ?? 0}">${xmlEscape(stripControlJson(turn.content))}</turn>\n`;
		}
		xml += `  </transcript>\n`;
	}

	xml += `  <roles-spoken>${xmlEscape(spokenNames || "none")}</roles-spoken>\n`;
	xml += `  <roles-remaining>${xmlEscape(remainingNames || `all: ${participantNames}`)}</roles-remaining>\n`;

	xml += `  <instruction>\n`;
	xml += `    YOU ARE THE MODERATOR. Your ONLY job right now is to decide who speaks next.\n`;
	xml += `    DO NOT answer the user's question yourself. DO NOT provide analysis.\n`;
	xml += `    You MUST respond with ONLY a JSON object — no other text, no markdown, no explanation.\n\n`;

	if (input.phase === "open") {
		xml += `    This is the OPENING of the discussion. Pick who should speak FIRST and what angle they should address.\n`;
		xml += `    Choose the participant whose expertise is most relevant to the question.\n`;
	} else if (input.phase === "may_close") {
		xml += `    All participants have spoken at least the minimum number of rounds.\n`;
		xml += `    If the key issues are sufficiently debated, set action to "close".\n`;
		xml += `    Otherwise, direct a specific follow-up to a participant who should elaborate.\n`;
	} else {
		if (remainingNames) {
			xml += `    Participants not yet heard: ${xmlEscape(remainingNames)}. Prioritize them.\n`;
		}
		xml += `    Based on the transcript, identify the most important gap or unresolved tension.\n`;
		xml += `    Direct the next speaker to address something SPECIFIC — not a generic "share your thoughts".\n`;
	}

	xml += `\n    RESPOND WITH EXACTLY THIS JSON FORMAT AND NOTHING ELSE:\n`;
	xml += `    {"next_speaker": "exact participant slug", "direction": "specific topic or question for them", "action": "direct"}\n`;
	xml += `    Or to end: {"next_speaker": "", "direction": "summary of why closing", "action": "close"}\n`;
	xml += `  </instruction>\n`;
	xml += `</group-chat-moderation>`;
	return xml;
}

/** Build the moderator synthesis prompt at the end of a group-chat round. */
export function buildSynthesisPrompt(
	input: BuildSynthesisPromptInput,
): string {
	const participantNames = input.participants.join(", ");
	let xml = `<group-chat-synthesis participants="${xmlEscape(participantNames)}">\n`;
	xml += `  <user-question>${xmlEscape(input.userMessage)}</user-question>\n`;
	xml += `  <transcript>\n`;
	for (const turn of input.transcript) {
		xml += `    <turn speaker="${xmlEscape(turn.speaker)}" turn="${turn.turnNumber ?? 0}">${xmlEscape(stripControlJson(turn.content))}</turn>\n`;
	}
	xml += `  </transcript>\n`;
	xml += `  <instruction>You are ${xmlEscape(input.moderatorSlug)} acting as the moderator. Synthesize the deliberation above into a concise summary. Highlight areas of agreement, disagreement, and the final recommendation. Speak in your own voice.</instruction>\n`;
	xml += `</group-chat-synthesis>`;
	return xml;
}

/** Extract the outermost JSON object from text using bracket counting. */
export function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return text.substring(start, i + 1);
		}
	}
	return null;
}

/** Parse a moderator decision response. Returns null on malformed input. */
export function parseModeratorDecision(
	text: string,
): ModeratorDecision | null {
	const json = extractJsonObject(text);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const nextSpeaker =
			typeof parsed.next_speaker === "string" ? parsed.next_speaker : "";
		const direction =
			typeof parsed.direction === "string" ? parsed.direction : "";
		const action: ModeratorDecision["action"] =
			parsed.action === "close" ? "close" : "direct";
		return { nextSpeaker, direction, action };
	} catch {
		return null;
	}
}

/**
 * Strip orchestration control JSON from a message body when re-feeding it to
 * other minds. Prevents moderator routing decisions from leaking into the
 * speakers' history context.
 */
export function stripControlJson(
	text: string,
	actions: Set<string> = CONTROL_ACTIONS,
): string {
	const json = extractJsonObject(text);
	if (!json) return text;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		if (typeof parsed.action === "string" && actions.has(parsed.action)) {
			return text.replace(json, "").trim();
		}
	} catch {
		// not JSON — leave as-is
	}
	return text;
}
