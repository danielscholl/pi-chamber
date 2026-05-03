import type { DiscoveryEntry } from "../core.ts";
import type { ObservatorySelection } from "./state.ts";

export interface SidebarItem {
	kind: "dashboard" | "lens-ok" | "lens-invalid";
	id: string;
	label: string;
	suffix: string;
	reason?: string;
}

export function buildSidebarItems(entries: DiscoveryEntry[]): SidebarItem[] {
	const items: SidebarItem[] = [
		{
			kind: "dashboard",
			id: "__dashboard__",
			label: "Dashboard",
			suffix: "home",
		},
	];
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
	return items;
}

export function renderSidebar(
	entries: DiscoveryEntry[],
	selection: ObservatorySelection,
	width: number,
	height: number,
	scrollOffset: number,
): string[] {
	const w = Math.max(8, width);
	const items = buildSidebarItems(entries);
	const selectedIndex = indexOfSelection(items, selection);
	const visible = items.slice(scrollOffset, scrollOffset + Math.max(1, height));
	const lines: string[] = [];
	for (let i = 0; i < visible.length; i++) {
		const idx = i + scrollOffset;
		const item = visible[i];
		const cursor = idx === selectedIndex ? "▶" : " ";
		const glyph = item.kind === "lens-invalid" ? "⚠" : item.kind === "dashboard" ? "·" : "✓";
		const label = `${cursor} ${glyph} ${item.label}`;
		lines.push(truncate(label, w));
	}
	while (lines.length < height) lines.push("".padEnd(w));
	return lines;
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
	else if (selectedIndex >= scroll + height) scroll = selectedIndex - height + 1;
	if (scroll + height > itemCount) scroll = Math.max(0, itemCount - height);
	if (scroll < 0) scroll = 0;
	return scroll;
}

function indexOfSelection(
	items: SidebarItem[],
	selection: ObservatorySelection,
): number {
	if (selection.kind === "dashboard") return 0;
	const idx = items.findIndex(
		(i) => i.kind !== "dashboard" && i.id === selection.lensId,
	);
	return idx >= 0 ? idx : 0;
}

function truncate(text: string, width: number): string {
	if (text.length <= width) return text;
	if (width <= 1) return text.slice(0, width);
	return `${text.slice(0, width - 1)}…`;
}
