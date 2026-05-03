// Sectioned briefing data shape.
//
// A briefing data file may either be a flat object (legacy: each top-level
// key/value renders as a card) or a sectioned page. This module is the
// single source of truth for that distinction and for normalizing loose
// authored input into a typed BriefingPage that the page renderer can
// consume without re-validating.
//
// Detection rule: any non-array object containing at least one of the
// reserved top-level keys (RESERVED_KEYS) is treated as sectioned.
//
// Parsing is permissive: bad fields produce warnings and are dropped;
// good fields next to bad ones still render. Hard rejection is reserved
// for shape mismatches (e.g. metrics is not an array) where keeping the
// field would force the renderer to invent semantics.

const RESERVED_KEYS = [
	"summary",
	"status",
	"priority",
	"metrics",
	"activity",
	"lists",
	"narrative",
	"details",
] as const;

export const SEVERITIES = ["info", "ok", "warn", "err"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LIST_STYLES = ["inline", "bullet"] as const;
export type ListStyle = (typeof LIST_STYLES)[number];

export interface Priority {
	title: string;
	body: string;
	severity?: Severity;
}

export interface Metric {
	label: string;
	value: string;
}

export interface ListSection {
	title: string;
	items: string[];
	style: ListStyle;
}

export interface NarrativeItem {
	heading: string;
	body: string;
}

export interface DetailRow {
	label: string;
	value: string;
}

export interface BriefingPage {
	summary?: string;
	status?: string;
	priority?: Priority;
	metrics?: Metric[];
	activity?: string[];
	lists?: ListSection[];
	narrative?: NarrativeItem[];
	details?: DetailRow[];
}

export interface ParsedPage {
	page: BriefingPage;
	warnings: string[];
}

export function isSectionedShape(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) return false;
	const obj = data as Record<string, unknown>;
	for (const key of RESERVED_KEYS) {
		if (key in obj) return true;
	}
	return false;
}

export function parseBriefingPage(data: unknown): ParsedPage {
	const warnings: string[] = [];
	const page: BriefingPage = {};
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		warnings.push("data is not a JSON object");
		return { page, warnings };
	}
	const obj = data as Record<string, unknown>;

	if ("summary" in obj) {
		const s = parseNonEmptyString(obj.summary, "summary", warnings);
		if (s !== null) page.summary = s;
	}
	if ("status" in obj) {
		const s = parseNonEmptyString(obj.status, "status", warnings);
		if (s !== null) page.status = s;
	}
	if ("priority" in obj) {
		const p = parsePriority(obj.priority, warnings);
		if (p) page.priority = p;
	}
	if ("metrics" in obj) {
		const m = parseMetrics(obj.metrics, warnings);
		if (m) page.metrics = m;
	}
	if ("activity" in obj) {
		const a = parseStringArray(obj.activity, "activity", warnings);
		if (a) page.activity = a;
	}
	if ("lists" in obj) {
		const ls = parseLists(obj.lists, warnings);
		if (ls) page.lists = ls;
	}
	if ("narrative" in obj) {
		const n = parseNarrative(obj.narrative, warnings);
		if (n) page.narrative = n;
	}
	if ("details" in obj) {
		const d = parseDetails(obj.details, warnings);
		if (d) page.details = d;
	}
	return { page, warnings };
}

export function parsePriority(
	value: unknown,
	warnings: string[],
): Priority | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push("priority is not an object; ignored");
		return null;
	}
	const obj = value as Record<string, unknown>;
	const title = obj.title;
	const body = obj.body;
	if (typeof title !== "string" || title.trim().length === 0) {
		warnings.push("priority.title is missing or empty; priority ignored");
		return null;
	}
	if (typeof body !== "string" || body.length === 0) {
		warnings.push("priority.body is missing or empty; priority ignored");
		return null;
	}
	const result: Priority = { title: title.trim(), body };
	if ("severity" in obj) {
		const sev = obj.severity;
		if (
			typeof sev === "string" &&
			(SEVERITIES as readonly string[]).includes(sev)
		) {
			result.severity = sev as Severity;
		} else {
			warnings.push(
				`priority.severity must be one of ${SEVERITIES.join(" | ")}; severity dropped`,
			);
		}
	}
	return result;
}

export function parseMetrics(
	value: unknown,
	warnings: string[],
): Metric[] | null {
	if (!Array.isArray(value)) {
		warnings.push("metrics is not an array; ignored");
		return null;
	}
	const out: Metric[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			warnings.push(`metrics[${i}] is not an object; skipped`);
			continue;
		}
		const m = item as Record<string, unknown>;
		const label = m.label;
		if (typeof label !== "string" || label.trim().length === 0) {
			warnings.push(`metrics[${i}].label is missing or empty; skipped`);
			continue;
		}
		const valueText = stringifyMetricValue(m.value);
		if (valueText === null) {
			warnings.push(`metrics[${i}].value type unsupported; skipped`);
			continue;
		}
		out.push({ label: label.trim(), value: valueText });
	}
	return out;
}

export function parseStringArray(
	value: unknown,
	field: string,
	warnings: string[],
): string[] | null {
	if (!Array.isArray(value)) {
		warnings.push(`${field} is not an array; ignored`);
		return null;
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (typeof item === "string" && item.length > 0) {
			out.push(item);
		} else {
			warnings.push(`${field}[${i}] is not a non-empty string; skipped`);
		}
	}
	return out;
}

export function parseLists(
	value: unknown,
	warnings: string[],
): ListSection[] | null {
	if (!Array.isArray(value)) {
		warnings.push("lists is not an array; ignored");
		return null;
	}
	const out: ListSection[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			warnings.push(`lists[${i}] is not an object; skipped`);
			continue;
		}
		const obj = item as Record<string, unknown>;
		const title = obj.title;
		const items = obj.items;
		if (typeof title !== "string" || title.trim().length === 0) {
			warnings.push(`lists[${i}].title is missing or empty; skipped`);
			continue;
		}
		if (!Array.isArray(items)) {
			warnings.push(`lists[${i}].items is not an array; skipped`);
			continue;
		}
		const stringItems: string[] = [];
		for (let j = 0; j < items.length; j++) {
			const v = items[j];
			if (typeof v === "string" && v.length > 0) stringItems.push(v);
			else
				warnings.push(
					`lists[${i}].items[${j}] is not a non-empty string; skipped`,
				);
		}
		let style: ListStyle = "bullet";
		if ("style" in obj) {
			const s = obj.style;
			if (
				typeof s === "string" &&
				(LIST_STYLES as readonly string[]).includes(s)
			) {
				style = s as ListStyle;
			} else {
				warnings.push(
					`lists[${i}].style must be ${LIST_STYLES.join(" | ")}; defaulted to bullet`,
				);
			}
		}
		out.push({ title: title.trim(), items: stringItems, style });
	}
	return out;
}

export function parseNarrative(
	value: unknown,
	warnings: string[],
): NarrativeItem[] | null {
	if (!Array.isArray(value)) {
		warnings.push("narrative is not an array; ignored");
		return null;
	}
	const out: NarrativeItem[] = [];
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			warnings.push(`narrative[${i}] is not an object; skipped`);
			continue;
		}
		const obj = item as Record<string, unknown>;
		const heading = obj.heading;
		const body = obj.body;
		if (typeof heading !== "string" || heading.trim().length === 0) {
			warnings.push(`narrative[${i}].heading is missing or empty; skipped`);
			continue;
		}
		if (typeof body !== "string" || body.length === 0) {
			warnings.push(`narrative[${i}].body is missing or empty; skipped`);
			continue;
		}
		out.push({ heading: heading.trim(), body });
	}
	return out;
}

export function parseDetails(
	value: unknown,
	warnings: string[],
): DetailRow[] | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push("details is not an object; ignored");
		return null;
	}
	const out: DetailRow[] = [];
	for (const key of Object.keys(value as Record<string, unknown>)) {
		const raw = (value as Record<string, unknown>)[key];
		out.push({
			label: key.replace(/_/g, " "),
			value: stringifyDetailValue(raw),
		});
	}
	return out;
}

function parseNonEmptyString(
	value: unknown,
	field: string,
	warnings: string[],
): string | null {
	if (typeof value === "string" && value.trim().length > 0) return value;
	warnings.push(`${field} is not a non-empty string; ignored`);
	return null;
}

function stringifyMetricValue(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "—";
	return null;
}

function stringifyDetailValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
