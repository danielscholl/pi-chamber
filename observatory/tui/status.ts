// Status-board domain helpers. Pure: tier classification, glyph mapping,
// and entry normalization. The renderer (render-status-board.ts) is now
// only responsible for laying out the panel grid; everything that decides
// which tier a string belongs to or how to flatten an authored entry into
// a uniform shape lives here.

// Status keyword arrays. Mind-authored statuses use generic health verbs
// (ok / warn / error / pending / etc); room participant statuses use the
// orchestration verbs emitted by room/observatory.ts (ready / thinking /
// speaking / done / aborted / error). Both vocabularies must classify
// correctly so the sidebar Room block and the Dashboard Room panel reflect
// live participant tier.
const STATUS_OK = [
	"ok",
	"running",
	"active",
	"success",
	"healthy",
	"online",
	"passing",
	"ready",
	"speaking",
	"done",
];
const STATUS_WARN = [
	"warn",
	"warning",
	"pending",
	"degraded",
	"stale",
	"thinking",
	"aborted",
];
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

// Word-boundary prefix match. We want `warn` to catch `warning`/`warns`
// (prefix at a word boundary), but not match `forewarning` mid-word, and
// `ready` to catch `ready`/`readying` but not `already`. Using `\b<word>`
// gives us "starts at a word boundary, matches as a prefix" semantics —
// which is what the original substring check approximated for the longer
// classic keywords but broke for the short room verbs.
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTierRegex(words: readonly string[]): RegExp {
	return new RegExp(`\\b(?:${words.map(escapeRegex).join("|")})`, "i");
}

const STATUS_OK_RE = buildTierRegex(STATUS_OK);
const STATUS_WARN_RE = buildTierRegex(STATUS_WARN);
const STATUS_ERR_RE = buildTierRegex(STATUS_ERR);

export function statusTier(text: unknown): StatusTier {
	const value = String(text ?? "");
	if (STATUS_ERR_RE.test(value)) return "err";
	if (STATUS_WARN_RE.test(value)) return "warn";
	if (STATUS_OK_RE.test(value)) return "ok";
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
