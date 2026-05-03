// Status keyword arrays kept verbatim from the prior HTML renderer so the
// classification of mind-authored status strings stays consistent.
const STATUS_OK = [
	"ok",
	"running",
	"active",
	"success",
	"healthy",
	"online",
	"passing",
];
const STATUS_WARN = ["warn", "warning", "pending", "degraded", "stale"];
const STATUS_ERR = [
	"error",
	"fail",
	"failed",
	"down",
	"critical",
	"broken",
];

export type StatusTier = "ok" | "warn" | "err" | "idle";

const TIER_GLYPH: Record<StatusTier, string> = {
	ok: "●",
	warn: "◐",
	err: "✗",
	idle: "○",
};

export function statusTier(text: unknown): StatusTier {
	const lower = String(text ?? "").toLowerCase();
	if (STATUS_ERR.some((s) => lower.includes(s))) return "err";
	if (STATUS_WARN.some((s) => lower.includes(s))) return "warn";
	if (STATUS_OK.some((s) => lower.includes(s))) return "ok";
	return "idle";
}

export function tierGlyph(tier: StatusTier): string {
	return TIER_GLYPH[tier];
}

export interface StatusBoardEntry {
	name: string;
	tier: StatusTier;
	status: string;
	extras: Array<{ key: string; value: string }>;
}

const SKIP_KEYS = new Set(["name", "title", "id", "status"]);

export function normalizeStatusBoard(data: unknown): StatusBoardEntry[] {
	const items = Array.isArray(data)
		? data
		: data && typeof data === "object"
			? [data]
			: [];
	const out: StatusBoardEntry[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		const status = typeof obj.status === "string" ? obj.status : "";
		const name =
			(typeof obj.name === "string" && obj.name) ||
			(typeof obj.title === "string" && obj.title) ||
			(typeof obj.id === "string" && obj.id) ||
			"(unnamed)";
		const extras: Array<{ key: string; value: string }> = [];
		for (const key of Object.keys(obj)) {
			if (SKIP_KEYS.has(key)) continue;
			if (extras.length >= 4) break;
			const v = obj[key];
			let value: string;
			if (v === null || v === undefined) value = "—";
			else if (typeof v === "object") value = JSON.stringify(v);
			else value = String(v);
			extras.push({ key: key.replace(/_/g, " "), value });
		}
		out.push({
			name,
			tier: statusTier(status),
			status,
			extras,
		});
	}
	return out;
}

export function renderStatusBoard(data: unknown, width: number): string[] {
	const w = Math.max(20, width);
	const entries = normalizeStatusBoard(data);
	if (!entries.length) {
		return [truncate("(status-board has no entries yet)", w)];
	}
	const lines: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (i > 0) lines.push("");
		const e = entries[i];
		const head = `${tierGlyph(e.tier)} ${e.name}${
			e.status ? `  [${e.status}]` : ""
		}`;
		lines.push(truncate(head, w));
		for (const extra of e.extras) {
			lines.push(truncate(`    ${extra.key}: ${extra.value}`, w));
		}
	}
	return lines;
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}
