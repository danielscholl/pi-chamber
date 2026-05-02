/**
 * room-ui — pure UI factories for room TUI auditorium.
 *
 * Per-mind palette is stable across runs: djb2(slug) % paletteSize.
 * Renderers consume CustomMessage<ChamberMessageDetails> built by the room
 * extension and return pi-tui Components.
 */

import {
	Box,
	Container,
	Markdown,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

const PRINTABLE_FALLBACK = "?";

const SIDEBAR_GLYPH = "▌"; // ▌ — left half block

/**
 * Synthwave-friendly true-color palette. Each mind gets a stable slot from this
 * list via djb2(slug) % palette.length. Picked to be readable on dark themes
 * and distinguishable from one another.
 */
export const MIND_PALETTE: ReadonlyArray<{ name: string; rgb: [number, number, number] }> = [
	{ name: "pink", rgb: [255, 126, 219] },
	{ name: "cyan", rgb: [54, 249, 246] },
	{ name: "green", rgb: [114, 241, 184] },
	{ name: "yellow", rgb: [254, 222, 93] },
	{ name: "violet", rgb: [184, 144, 255] },
	{ name: "orange", rgb: [255, 173, 117] },
	{ name: "lime", rgb: [196, 255, 102] },
	{ name: "rose", rgb: [255, 158, 168] },
] as const;

const MODERATOR_DECISION_RGB: [number, number, number] = [180, 160, 200];
const ROUND_METRICS_RGB: [number, number, number] = [120, 100, 140];

const USER_ROOM_MESSAGE_CUSTOM_TYPE = "room-user-message";
const MIND_SPEECH_CUSTOM_TYPE = "room-mind-speech";
const MODERATOR_DECISION_CUSTOM_TYPE = "room-moderator-decision";
const ROUND_METRICS_CUSTOM_TYPE = "room-round-metrics";

export const ROOM_CUSTOM_TYPES = {
	userMessage: USER_ROOM_MESSAGE_CUSTOM_TYPE,
	mindSpeech: MIND_SPEECH_CUSTOM_TYPE,
	moderatorDecision: MODERATOR_DECISION_CUSTOM_TYPE,
	roundMetrics: ROUND_METRICS_CUSTOM_TYPE,
} as const;

export type ParticipantStatus = "ready" | "thinking" | "speaking" | "done" | "aborted" | "error";

export type ParticipantStateView = {
	slug: string;
	role: "speaker" | "moderator";
	status: ParticipantStatus;
	paletteIndex: number;
};

export type RoomStateView = {
	active: boolean;
	mode: string;
	roomLabel?: string;
	participants: ParticipantStateView[];
};

export type MindSpeechDetails = {
	slug: string;
	mode: string;
	role: "speaker" | "moderator" | "synthesis";
	paletteIndex: number;
	turnNumber?: number;
	durationMs?: number;
	usage?: {
		input?: number;
		output?: number;
		cost?: number;
		turns?: number;
	};
	model?: string;
	aborted?: boolean;
	stopReason?: string;
};

export type ModeratorDecisionDetails = {
	moderatorSlug: string;
	moderatorPaletteIndex: number;
	nextSpeaker?: string;
	direction?: string;
	action: "open" | "direct" | "close";
	phase?: "open" | "moderate" | "may_close";
};

export type RoundMetricsDetails = {
	mode: string;
	turns: number;
	speakers: number;
	durationMs: number;
	usage?: {
		input?: number;
		output?: number;
		cost?: number;
	};
};

export function djb2(input: string): number {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
	}
	return hash;
}

export function paletteIndexForSlug(
	slug: string,
	paletteSize = MIND_PALETTE.length,
): number {
	if (paletteSize <= 0) return 0;
	return djb2(slug) % paletteSize;
}

/** Wrap text with a 24-bit ANSI foreground color. */
export function ansiFg(rgb: [number, number, number], text: string): string {
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function ansiBold(text: string): string {
	return `\x1b[1m${text}\x1b[22m`;
}

export function ansiDim(text: string): string {
	return `\x1b[2m${text}\x1b[22m`;
}

export function ansiItalic(text: string): string {
	return `\x1b[3m${text}\x1b[23m`;
}

export function colorForMind(
	slug: string,
	palette = MIND_PALETTE,
): { name: string; rgb: [number, number, number] } {
	const index = paletteIndexForSlug(slug, palette.length);
	return palette[index] ?? palette[0] ?? { name: "default", rgb: [200, 200, 200] };
}

const STATUS_GLYPH: Record<ParticipantStatus, string> = {
	ready: "○", // ○
	thinking: "◐", // ◐
	speaking: "●", // ●
	done: "✔", // ✔
	aborted: "·", // ·
	error: "×", // ×
};

/**
 * Build the participant bar for the editor widget.
 * The factory returns a fresh component each render via setWidget(...) calls.
 */
export function renderParticipantBarLines(state: RoomStateView): string[] {
	if (!state.active || state.participants.length === 0) return [];
	const palette = MIND_PALETTE;
	const segments: string[] = [];

	const labelParts: string[] = [];
	const modeText = ansiDim(`room · ${state.mode || "off"}`);
	labelParts.push(modeText);
	if (state.roomLabel) labelParts.push(ansiDim(`· ${state.roomLabel}`));
	segments.push(labelParts.join(" "));

	for (const p of state.participants) {
		const color = palette[p.paletteIndex] ?? palette[0];
		const glyph = STATUS_GLYPH[p.status] ?? STATUS_GLYPH.ready;
		const colored = color ? ansiFg(color.rgb, glyph) : glyph;
		const name =
			p.role === "moderator"
				? `${p.slug}${ansiDim(" (mod)")}`
				: p.slug;
		segments.push(`${colored} ${name}`);
	}

	return [segments.join("  ")];
}

export function userRoomMessageRenderer(
	message: { content: unknown },
	_options: { expanded: boolean },
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	},
) {
	const text = typeof message.content === "string" ? message.content : "";
	const box = new Box(1, 0, (t) => theme.bg("userMessageBg", t));
	box.addChild(
		new Text(
			theme.fg("muted", "you ") +
				theme.fg("userMessageText", text || PRINTABLE_FALLBACK),
			0,
			0,
		),
	);
	return box;
}

export function mindSpeechRenderer(
	message: { content: unknown; details?: unknown },
	options: { expanded: boolean },
	theme: {
		fg(color: string, text: string): string;
		bg(color: string, text: string): string;
		bold(text: string): string;
	},
) {
	const detailsRaw = (message.details ?? {}) as Partial<MindSpeechDetails>;
	const slug = detailsRaw.slug ?? "mind";
	const palette = MIND_PALETTE;
	const paletteIndex =
		typeof detailsRaw.paletteIndex === "number"
			? Math.max(0, Math.min(palette.length - 1, detailsRaw.paletteIndex))
			: paletteIndexForSlug(slug, palette.length);
	const color = palette[paletteIndex] ?? palette[0];
	const text = typeof message.content === "string" ? message.content : "";
	const isModerator = detailsRaw.role === "moderator";
	const isSynthesis = detailsRaw.role === "synthesis";
	const aborted = Boolean(detailsRaw.aborted);

	const sidebar = color ? ansiFg(color.rgb, SIDEBAR_GLYPH) : SIDEBAR_GLYPH;
	const slugColored = color ? ansiFg(color.rgb, ansiBold(slug)) : ansiBold(slug);
	const roleHint = isSynthesis
		? ansiDim(" (synthesis)")
		: isModerator
			? ansiDim(" (mod)")
			: "";
	const turnHint =
		typeof detailsRaw.turnNumber === "number"
			? ansiDim(` · turn ${detailsRaw.turnNumber}`)
			: "";
	const abortedHint = aborted ? ansiDim(" (aborted)") : "";

	const header = `${sidebar} ${slugColored}${roleHint}${turnHint}${abortedHint}`;

	const container = new Container();
	container.addChild(new Text(header, 0, 0));

	const body = (text ?? "").trim();
	const showFullBody = options.expanded || isSynthesis || body.length <= 280;
	if (isSynthesis && body.length > 0) {
		const rule = "─".repeat(24);
		const ruled = color ? ansiFg(color.rgb, rule) : rule;
		container.addChild(new Text(ruled, 0, 0));
	}
	if (body.length === 0) {
		container.addChild(
			new Text(theme.fg("muted", "(no output yet)"), 0, 0),
		);
	} else if (showFullBody) {
		const mdTheme = safeGetMarkdownTheme();
		if (mdTheme) {
			container.addChild(new Markdown(body, 0, 0, mdTheme));
		} else {
			container.addChild(new Text(body, 0, 0));
		}
	} else {
		const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? body;
		const preview = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
		container.addChild(new Text(preview, 0, 0));
		container.addChild(
			new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0),
		);
	}

	if (options.expanded && detailsRaw.usage) {
		const usageStr = formatUsageStats(detailsRaw.usage, detailsRaw);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
	}

	return container;
}

export function moderatorDecisionRenderer(
	message: { content: unknown; details?: unknown },
	_options: { expanded: boolean },
	theme: {
		fg(color: string, text: string): string;
	},
) {
	const detailsRaw = (message.details ?? {}) as Partial<ModeratorDecisionDetails>;
	const moderatorSlug = detailsRaw.moderatorSlug ?? "moderator";
	const action: ModeratorDecisionDetails["action"] = detailsRaw.action ?? "direct";
	const palette = MIND_PALETTE;
	const paletteIndex =
		typeof detailsRaw.moderatorPaletteIndex === "number"
			? Math.max(0, Math.min(palette.length - 1, detailsRaw.moderatorPaletteIndex))
			: paletteIndexForSlug(moderatorSlug, palette.length);
	const color = palette[paletteIndex] ?? palette[0];

	const slugColored = color ? ansiFg(color.rgb, moderatorSlug) : moderatorSlug;
	const arrow = ansiFg(MODERATOR_DECISION_RGB, "→"); // →
	const dot = ansiFg(MODERATOR_DECISION_RGB, "·"); // ·
	const directionText = (detailsRaw.direction ?? "").trim();
	const direction = directionText
		? ` ${dot} ${ansiItalic(ansiFg(MODERATOR_DECISION_RGB, directionText))}`
		: "";

	let line = "";
	if (action === "close") {
		line = `${dot} ${slugColored} ${ansiFg(MODERATOR_DECISION_RGB, "closed the discussion")}${direction}`;
	} else if (action === "open") {
		const next = detailsRaw.nextSpeaker
			? ` ${arrow} ${color ? ansiFg(color.rgb, detailsRaw.nextSpeaker) : detailsRaw.nextSpeaker}`
			: "";
		line = `${dot} ${slugColored} ${ansiFg(MODERATOR_DECISION_RGB, "opens the discussion")}${next}${direction}`;
	} else {
		const next = detailsRaw.nextSpeaker
			? ` ${arrow} ${color ? ansiFg(color.rgb, detailsRaw.nextSpeaker) : detailsRaw.nextSpeaker}`
			: "";
		line = `${dot} ${slugColored}${next}${direction}`;
	}
	void theme;
	return new Text(line, 0, 0);
}

export function roundMetricsRenderer(
	message: { details?: unknown },
	_options: { expanded: boolean },
	theme: {
		fg(color: string, text: string): string;
	},
) {
	const detailsRaw = (message.details ?? {}) as Partial<RoundMetricsDetails>;
	const turns = detailsRaw.turns ?? 0;
	const speakers = detailsRaw.speakers ?? 0;
	const durationMs = detailsRaw.durationMs ?? 0;
	const mode = detailsRaw.mode ?? "concurrent";
	const usage = detailsRaw.usage;

	const dur = formatDurationMs(durationMs);
	const parts: string[] = [
		`${turns} turn${turns === 1 ? "" : "s"}`,
		dur,
		`${speakers} mind${speakers === 1 ? "" : "s"}`,
		mode,
	];
	if (usage) {
		const usageBits: string[] = [];
		if (usage.input) usageBits.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) usageBits.push(`↓${formatTokens(usage.output)}`);
		if (usage.cost) usageBits.push(`$${usage.cost.toFixed(4)}`);
		if (usageBits.length) parts.push(usageBits.join(" "));
	}

	const dim = ansiFg(ROUND_METRICS_RGB, "─"); // ─
	const text = `${dim} ${ansiFg(ROUND_METRICS_RGB, parts.join(" · "))} ${dim}`;
	void theme;
	return new Text(text, 0, 0);
}

export function formatDurationMs(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input?: number;
		output?: number;
		cost?: number;
		turns?: number;
	},
	details: Partial<MindSpeechDetails>,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (typeof details.durationMs === "number" && details.durationMs > 0) {
		parts.push(formatDurationMs(details.durationMs));
	}
	if (details.model) parts.push(details.model);
	return parts.join(" ");
}

function safeGetMarkdownTheme() {
	try {
		return getMarkdownTheme();
	} catch {
		return undefined;
	}
}
