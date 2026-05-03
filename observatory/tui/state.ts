import type { DiscoveryEntry, LensDataResult } from "../core.ts";

export type ObservatorySelection =
	| { kind: "dashboard" }
	| { kind: "lens"; lensId: string };

export type ObservatoryMode = "list" | "detail" | "help";

export interface ObservatoryNotification {
	message: string;
	type: "info" | "warning" | "error";
	expiresAt: number;
}

export interface ObservatoryViewState {
	selection: ObservatorySelection;
	selectedSidebarIndex: number;
	mode: ObservatoryMode;
	bodyScrollOffset: number;
	sidebarScrollOffset: number;
	expandValues: boolean;
	notification: ObservatoryNotification | null;
	pendingG: boolean;
	entries: DiscoveryEntry[];
	lensDataCache: Map<string, LensDataResult>;
	lastRefreshAt: number;
}

export function createObservatoryViewState(
	entries: DiscoveryEntry[] = [],
): ObservatoryViewState {
	return {
		selection: { kind: "dashboard" },
		selectedSidebarIndex: 0,
		mode: "list",
		bodyScrollOffset: 0,
		sidebarScrollOffset: 0,
		expandValues: false,
		notification: null,
		pendingG: false,
		entries,
		lensDataCache: new Map(),
		lastRefreshAt: Date.now(),
	};
}

export function sidebarItemCount(state: ObservatoryViewState): number {
	return 1 + state.entries.length;
}

export function selectionForIndex(
	state: ObservatoryViewState,
	index: number,
): ObservatorySelection {
	if (index <= 0) return { kind: "dashboard" };
	const entry = state.entries[index - 1];
	if (!entry) return { kind: "dashboard" };
	return { kind: "lens", lensId: entry.id };
}

export function setSelectedIndex(
	state: ObservatoryViewState,
	index: number,
): void {
	const total = sidebarItemCount(state);
	const clamped = Math.max(0, Math.min(total - 1, index));
	state.selectedSidebarIndex = clamped;
	state.selection = selectionForIndex(state, clamped);
	state.bodyScrollOffset = 0;
}

export function setEntries(
	state: ObservatoryViewState,
	entries: DiscoveryEntry[],
): void {
	state.entries = entries;
	state.lastRefreshAt = Date.now();
	if (state.selection.kind === "lens") {
		const targetId = state.selection.lensId;
		const newIndex = entries.findIndex((e) => e.id === targetId);
		if (newIndex < 0) {
			state.selection = { kind: "dashboard" };
			state.selectedSidebarIndex = 0;
			state.bodyScrollOffset = 0;
		} else {
			state.selectedSidebarIndex = newIndex + 1;
		}
	}
	const total = sidebarItemCount(state);
	if (state.selectedSidebarIndex >= total) {
		state.selectedSidebarIndex = Math.max(0, total - 1);
		state.selection = selectionForIndex(state, state.selectedSidebarIndex);
	}
}

export function setLensData(
	state: ObservatoryViewState,
	lensId: string,
	data: LensDataResult,
): void {
	state.lensDataCache.set(lensId, data);
}

export function invalidateLensData(
	state: ObservatoryViewState,
	lensId: string,
): void {
	state.lensDataCache.delete(lensId);
}

export function clearAllLensData(state: ObservatoryViewState): void {
	state.lensDataCache.clear();
}

export function setMode(
	state: ObservatoryViewState,
	mode: ObservatoryMode,
): void {
	state.mode = mode;
	if (mode !== "detail") {
		state.bodyScrollOffset = 0;
	}
}

export function setNotification(
	state: ObservatoryViewState,
	message: string,
	type: ObservatoryNotification["type"] = "info",
	durationMs = 3000,
): void {
	state.notification = {
		message,
		type,
		expiresAt: Date.now() + durationMs,
	};
}

export function clearNotification(state: ObservatoryViewState): void {
	state.notification = null;
}

export function notificationIsExpired(
	state: ObservatoryViewState,
	now: number = Date.now(),
): boolean {
	return state.notification !== null && state.notification.expiresAt <= now;
}
