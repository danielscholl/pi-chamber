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
	"address",
	"pass",
	"end",
]);

/**
 * Speaker-driven routing actions used by group-chat (when speaker addressing is
 * on) and open-floor mode. Speakers append a JSON tail with one of these
 * actions to influence who speaks next; absent or malformed JSON is treated as
 * "no opinion" and the strategy falls back to its default rotation.
 */
export const SPEAKER_ADDRESS_ACTIONS = ["address", "pass", "end"] as const;
export type SpeakerAddressAction = (typeof SPEAKER_ADDRESS_ACTIONS)[number];

export type SpeakerAddress = {
	action: SpeakerAddressAction;
	slug?: string;
	reason?: string;
};

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
	/**
	 * When true, append a trailer instructing the speaker that they MAY suggest
	 * the next speaker (or call for the discussion to end) by emitting a JSON
	 * tail. Used by group-chat with `speakerAddressing` and by open-floor.
	 */
	addressingEnabled?: boolean;
	/**
	 * When `addressingEnabled` is on, the explicit list of slugs the speaker
	 * may address. Defaults to `participants` minus self. Group-chat passes a
	 * speakers-only list (excluding any participant-slug moderator) so the
	 * trailer never advertises a moderator the routing layer would discard.
	 */
	addressablePeers?: string[];
	/**
	 * When set, the speaker is being directly addressed by another mind. The
	 * resulting prompt lifts this out of `<chatroom-history>` into a prominent
	 * `<addressed-to-you>` block so the speaker engages with the addressee
	 * first. Used by open-floor mode.
	 */
	addressedFrom?: { slug: string; reason?: string };
};

export type ModeratorPhase = "open" | "moderate" | "may_close";

export type BuildModeratorPromptInput = {
	moderatorSlug: string;
	speakers: string[];
	userMessage: string;
	transcript: ChamberHistoryTurn[];
	phase: ModeratorPhase;
	spokenSlugs: Set<string>;
	/**
	 * When the prior speaker emitted an `address` suggestion, surface it to the
	 * moderator so it can honor the speaker-driven nudge unless the suggested
	 * speaker has hit the repeat cap. Only set in addressing-enabled rooms.
	 */
	speakerSuggestion?: { slug: string; reason?: string };
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

	const addressedXml = input.addressedFrom
		? renderAddressedToYou(input.addressedFrom)
		: "";

	const message = `<message sender="You">${xmlEscape(input.userMessage)}</message>`;

	const addressingTrailer = input.addressingEnabled
		? renderAddressingTrailer(
				input.addressablePeers ?? input.participants,
				input.mindSlug,
			)
		: "";

	const blocks = [
		identity,
		room,
		historyXml,
		directionXml,
		addressedXml,
		message,
		addressingTrailer,
	].filter((b) => b && b.trim().length > 0);
	return blocks.join("\n\n");
}

function renderAddressedToYou(addressedFrom: {
	slug: string;
	reason?: string;
}): string {
	const reason = addressedFrom.reason
		? ` reason="${xmlEscape(addressedFrom.reason)}"`
		: "";
	const reasonLine = addressedFrom.reason
		? ` They asked you to specifically address: ${xmlEscape(addressedFrom.reason)}.`
		: "";
	return `<addressed-to-you sender="${xmlEscape(addressedFrom.slug)}"${reason}/>\nYou are being directly addressed by ${xmlEscape(addressedFrom.slug)}. Engage with their point first; the rest of the room will hear your reply.${reasonLine}`;
}

function renderAddressingTrailer(
	participants: string[],
	selfSlug: string,
): string {
	const others = participants.filter((p) => p !== selfSlug);
	const peers = others.length > 0 ? others.join(", ") : "(no peers)";
	return [
		`<addressing-options>`,
		`After your reply, you MAY end your message with EXACTLY ONE JSON object on its own line to influence what happens next. If you have no preference, omit it.`,
		``,
		`To suggest who speaks next:`,
		`{ "action": "address", "slug": "<one of: ${peers}>", "reason": "<one short sentence>" }`,
		``,
		`To pass the floor without preference:`,
		`{ "action": "pass", "reason": "<why>" }`,
		``,
		`To vote that the discussion should end:`,
		`{ "action": "end", "reason": "<why>" }`,
		``,
		`Rules: only valid peer slugs are allowed; do not address yourself; do not include any prose after the JSON object.`,
		`</addressing-options>`,
	].join("\n");
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

	if (input.speakerSuggestion) {
		const reasonAttr = input.speakerSuggestion.reason
			? ` reason="${xmlEscape(input.speakerSuggestion.reason)}"`
			: "";
		xml += `  <speaker-suggestion slug="${xmlEscape(input.speakerSuggestion.slug)}"${reasonAttr}/>\n`;
		xml += `  <speaker-suggestion-note>The previous speaker suggested addressing ${xmlEscape(input.speakerSuggestion.slug)}. Honor this unless that speaker has already hit the repeat cap, in which case pick the least-spoken participant. Direction should reflect the suggested reason when sensible.</speaker-suggestion-note>\n`;
	}

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

export type BuildOpenFloorOpenerPromptInput = {
	openerSlug: string;
	participants: string[];
	userMessage: string;
	history: ChamberHistoryTurn[];
};

/**
 * Build the open-floor opener prompt. The opener picks who speaks first and
 * sets a one-sentence direction; it does NOT respond to the user. It uses the
 * same JSON shape as `parseModeratorDecision` so the strategy can reuse the
 * existing parser.
 */
export function buildOpenFloorOpenerPrompt(
	input: BuildOpenFloorOpenerPromptInput,
): string {
	const participantNames = input.participants.join(", ");
	let xml = `<open-floor-open participants="${xmlEscape(participantNames)}">\n`;
	xml += `  <user-question>${xmlEscape(input.userMessage)}</user-question>\n`;
	if (input.history.length > 0) {
		xml += `  <prior-rounds>\n`;
		for (const turn of input.history) {
			xml += `    <turn speaker="${xmlEscape(turn.speaker)}">${xmlEscape(stripControlJson(turn.content))}</turn>\n`;
		}
		xml += `  </prior-rounds>\n`;
	}
	xml += `  <instruction>\n`;
	xml += `    YOU ARE THE OPENER. Your ONLY job is to pick who speaks first and set a one-sentence direction.\n`;
	xml += `    DO NOT answer the user's question yourself. DO NOT provide analysis. The participants will discuss freely after this.\n`;
	xml += `    RESPOND WITH EXACTLY THIS JSON FORMAT AND NOTHING ELSE:\n`;
	xml += `    {"next_speaker": "<exact participant slug>", "direction": "<one short sentence>", "action": "direct"}\n`;
	xml += `  </instruction>\n`;
	xml += `</open-floor-open>`;
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

/** Build a synthesis prompt for concurrent mode where each participant
 * answered the same question in parallel. The wrapper differs from group-chat
 * synthesis so the synthesizer knows there was no back-and-forth: every
 * participant spoke once and independently. */
export function buildConcurrentSynthesisPrompt(
	input: BuildSynthesisPromptInput,
): string {
	const participantNames = input.participants.join(", ");
	let xml = `<concurrent-synthesis participants="${xmlEscape(participantNames)}">\n`;
	xml += `  <user-question>${xmlEscape(input.userMessage)}</user-question>\n`;
	xml += `  <takes>\n`;
	for (const turn of input.transcript) {
		xml += `    <take speaker="${xmlEscape(turn.speaker)}">${xmlEscape(stripControlJson(turn.content))}</take>\n`;
	}
	xml += `  </takes>\n`;
	xml += `  <instruction>You are ${xmlEscape(input.moderatorSlug)} acting as the synthesizer. Each participant answered the same question independently — there was no back-and-forth. Identify points of convergence, where they meaningfully diverge, and recommend a path forward. Be concise. Speak in your own voice.</instruction>\n`;
	xml += `</concurrent-synthesis>`;
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

/**
 * Extract the LAST balanced top-level JSON object from text.
 *
 * Speaker-side control JSON is appended to free-form prose (sometimes after
 * a JSON code example earlier in the reply). Using the first-extraction
 * helper for that path silently misses the real tail when a code example
 * appears upstream. This helper walks the string left-to-right collecting
 * every balanced top-level `{...}` span and returns the last one.
 */
export function extractTrailingJsonObject(text: string): string | null {
	let last: string | null = null;
	let i = 0;
	while (i < text.length) {
		const start = text.indexOf("{", i);
		if (start === -1) break;
		let depth = 0;
		let inString = false;
		let escape = false;
		let end = -1;
		for (let j = start; j < text.length; j++) {
			const ch = text[j];
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
				if (depth === 0) {
					end = j;
					break;
				}
			}
		}
		// Bail on unbalanced input rather than infinite-looping.
		if (end === -1) break;
		last = text.substring(start, end + 1);
		i = end + 1;
	}
	return last;
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
 * Parse a speaker-emitted routing tail. Speakers in addressing-enabled rooms
 * may end their message with a JSON object: `{"action": "address" | "pass" |
 * "end", "slug"?: "...", "reason"?: "..."}`. Anything else returns null and
 * the caller's strategy falls back to round-robin.
 *
 * Mirrors `parseModeratorDecision` deliberately so the parsing surface is
 * uniform across speaker-side and moderator-side control JSON.
 */
export function parseSpeakerAddress(text: string): SpeakerAddress | null {
	// Speaker control objects are appended to the end of free-form prose; the
	// reply may also contain JSON code examples upstream. Always parse the
	// trailing object so the real control JSON wins.
	const json = extractTrailingJsonObject(text);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		const rawAction = typeof parsed.action === "string" ? parsed.action : "";
		if (!isSpeakerAddressAction(rawAction)) return null;
		const slug =
			typeof parsed.slug === "string" && parsed.slug.trim().length > 0
				? parsed.slug.trim()
				: undefined;
		const reason =
			typeof parsed.reason === "string" && parsed.reason.trim().length > 0
				? parsed.reason.trim()
				: undefined;
		// "address" without a slug is meaningless; collapse to no-opinion so the
		// strategy's fallback path runs instead of trying to address an empty
		// string.
		if (rawAction === "address" && !slug) return null;
		return { action: rawAction, slug, reason };
	} catch {
		return null;
	}
}

function isSpeakerAddressAction(value: string): value is SpeakerAddressAction {
	return (SPEAKER_ADDRESS_ACTIONS as readonly string[]).includes(value);
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
	// Look at the trailing object so a JSON code example earlier in a
	// speaker's prose does not get stripped while leaving the real control
	// tail in place.
	const json = extractTrailingJsonObject(text);
	if (!json) return text;
	try {
		const parsed = JSON.parse(json) as Record<string, unknown>;
		if (typeof parsed.action === "string" && actions.has(parsed.action)) {
			// `lastIndexOf` ensures we strip the trailing occurrence even if
			// the same JSON literal appears earlier in the prose.
			const idx = text.lastIndexOf(json);
			return (text.slice(0, idx) + text.slice(idx + json.length)).trim();
		}
	} catch {
		// not JSON — leave as-is
	}
	return text;
}
