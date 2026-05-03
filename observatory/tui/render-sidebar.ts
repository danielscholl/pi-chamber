import type { DiscoveryEntry } from "../core.ts";
import type { StatusTier } from "./render-status-board.ts";
import { tierColorKey } from "./widgets/status-pill.ts";
import { padToWidth, truncateToWidth } from "./widgets/text.ts";
import { type Colorize, type ThemeColorKey, noColorize } from "./widgets/types.ts";

// Sidebar items have stable kinds so navigation (selection skipping) and
// rendering can branch on `kind` alone. Group/separator/status rows are
// non-selectable; only dashboard + lens rows are selectable.
export type SelectableSidebarItem =
	| { kind: "dashboard"; id: "__dashboard__"; label: string; suffix: string }
	| { kind: "lens-ok"; id: string; label: string; suffix: string }
	| {
			kind: "lens-invalid";
			id: string;
			label: string;
			suffix: string;
			reason?: string;
		};

export type SidebarItem =
	| { kind: "group"; label: string }
	| { kind: "separator" }
	| SelectableSidebarItem
	| { kind: "mind-status"; label: string; status: string }
	| {
			kind: "room-status";
			label: string;
			status: string;
			tier: StatusTier;
		};

export interface RoomSidebarEntry {
	name: string;
	status: string;
	tier: StatusTier;
}

export function isSelectableItem(
	item: SidebarItem,
): item is SelectableSidebarItem {
	return (
		item.kind === "dashboard" ||
		item.kind === "lens-ok" ||
		item.kind === "lens-invalid"
	);
}

export function buildSidebarItems(
	entries: DiscoveryEntry[],
	minds: string[] = [],
	roomEntries: RoomSidebarEntry[] = [],
): SidebarItem[] {
	const items: SidebarItem[] = [];
	items.push({ kind: "group", label: "Lenses" });
	items.push({
		kind: "dashboard",
		id: "__dashboard__",
		label: "Dashboard",
		suffix: "home",
	});
	for (const entry of entries) {
		if (entry.status === "ok") {
			items.push({
				kind: "lens-ok",
				id: entry.id,
				label: entry.manifest.name,
				suffix: entry.manifest.kind,
			});
		} else {
			items.push({
				kind: "lens-invalid",
				id: entry.id,
				label: entry.id,
				suffix: "invalid",
				reason: entry.reason,
			});
		}
	}
	if (minds.length > 0) {
		items.push({ kind: "separator" });
		items.push({ kind: "group", label: "Minds" });
		for (const mind of minds) {
			items.push({ kind: "mind-status", label: mind, status: "ready" });
		}
	}
	items.push({ kind: "separator" });
	items.push({ kind: "group", label: "Room" });
	if (roomEntries.length === 0) {
		items.push({
			kind: "room-status",
			label: "(inactive)",
			status: "",
			tier: "idle",
		});
	} else {
		for (const e of roomEntries) {
			items.push({
				kind: "room-status",
				label: e.name,
				status: e.status,
				tier: e.tier,
			});
		}
	}
	return items;
}

// Walk to the nearest selectable item from `start`, preferring `direction`.
export function findSelectableIndex(
	items: SidebarItem[],
	start: number,
	direction: 1 | -1 = 1,
): number {
	if (items.length === 0) return -1;
	const startClamped = Math.max(0, Math.min(items.length - 1, start));
	if (isSelectableItem(items[startClamped])) return startClamped;
	for (let step = 1; step < items.length; step++) {
		const fwd = startClamped + direction * step;
		if (fwd >= 0 && fwd < items.length && isSelectableItem(items[fwd])) {
			return fwd;
		}
	}
	for (let step = 1; step < items.length; step++) {
		const back = startClamped - direction * step;
		if (back >= 0 && back < items.length && isSelectableItem(items[back])) {
			return back;
		}
	}
	return -1;
}

export function visibleSidebarHeight(
	height: number,
	itemCount: number,
): number {
	return Math.max(1, Math.min(height, itemCount));
}

export function clampSidebarScroll(
	selectedIndex: number,
	height: number,
	itemCount: number,
	currentScroll: number,
): number {
	if (itemCount <= height) return 0;
	let scroll = currentScroll;
	if (selectedIndex < scroll) scroll = selectedIndex;
	else if (selectedIndex >= scroll + height)
		scroll = selectedIndex - height + 1;
	if (scroll + height > itemCount) scroll = Math.max(0, itemCount - height);
	if (scroll < 0) scroll = 0;
	return scroll;
}

export function renderSidebar(
	items: SidebarItem[],
	selectedIndex: number,
	width: number,
	height: number,
	scrollOffset: number,
	colorize: Colorize = noColorize,
): string[] {
	const w = Math.max(8, width);
	const visible = items.slice(scrollOffset, scrollOffset + Math.max(1, height));
	const lines: string[] = [];
	for (let i = 0; i < visible.length; i++) {
		const idx = i + scrollOffset;
		const item = visible[i];
		const isSelected = idx === selectedIndex;
		lines.push(renderItem(item, w, isSelected, colorize));
	}
	while (lines.length < height) lines.push(padToWidth("", w));
	return lines;
}

function renderItem(
	item: SidebarItem,
	width: number,
	isSelected: boolean,
	colorize: Colorize,
): string {
	switch (item.kind) {
		case "separator":
			return padToWidth("", width);
		case "group": {
			const upper = truncateToWidth(item.label.toUpperCase(), width);
			return padToWidth(colorize("accent", upper), width);
		}
		case "dashboard":
		case "lens-ok":
		case "lens-invalid": {
			const cursor = isSelected ? "▶" : " ";
			const glyph =
				item.kind === "lens-invalid"
					? "⚠"
					: item.kind === "dashboard"
						? "·"
						: "✓";
			const label = `${cursor} ${glyph} ${item.label}`;
			const truncated = truncateToWidth(label, width);
			return isSelected
				? padToWidth(colorize("selectedBg", truncated), width)
				: padToWidth(truncated, width);
		}
		case "mind-status":
			return renderStatusRow(
				`  ${item.label}`,
				item.status,
				"muted",
				width,
				colorize,
			);
		case "room-status":
			return renderStatusRow(
				`  ${item.label}`,
				item.status,
				tierColorKey(item.tier),
				width,
				colorize,
			);
	}
}

function renderStatusRow(
	label: string,
	status: string,
	statusColorKey: ThemeColorKey,
	width: number,
	colorize: Colorize,
): string {
	if (status.length === 0) {
		const truncated = truncateToWidth(label, width);
		return padToWidth(colorize("dim", truncated), width);
	}
	const labelTarget = Math.max(0, width - status.length - 2);
	const labelTrunc = truncateToWidth(label, labelTarget);
	const labelPadded = padRight(labelTrunc, labelTarget);
	const labelDim = colorize("dim", labelPadded);
	const statusColored = colorize(statusColorKey, status);
	return padToWidth(`${labelDim}  ${statusColored}`, width);
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
}
