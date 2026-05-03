import type {
	DashboardActivity,
	DiscoveryEntry,
	LensDataResult,
} from "../core.ts";
import {
	type SidebarItem,
	buildSidebarItems,
	findSelectableIndex,
	isSelectableItem,
} from "./render-sidebar.ts";

// Single-value TTL cache. Both the activity scan and the mind-list read
// share the same shape, so `readTtlCache` is the only fetch helper a
// caller needs. Caches live on viewState (not on the component) so
// invalidation has one home.
export interface TtlCache<T> {
	value: T;
	fetchedAt: number;
}

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
	// `e` toggle. Affects flat-briefing rendering only: when true, long
	// values wrap across lines via the details-body layout instead of being
	// truncated into single-line cards. Sectioned-briefing pages always
	// expand their details-body, so the toggle is a no-op there.
	expandValues: boolean;
	notification: ObservatoryNotification | null;
	pendingG: boolean;
	entries: DiscoveryEntry[];
	sidebarItems: SidebarItem[];
	lensDataCache: Map<string, LensDataResult>;
	activityCache: TtlCache<DashboardActivity | null> | null;
	mindsCache: TtlCache<string[]> | null;
	lastRefreshAt: number;
}

export function createObservatoryViewState(
	entries: DiscoveryEntry[] = [],
): ObservatoryViewState {
	const state: ObservatoryViewState = {
		selection: { kind: "dashboard" },
		selectedSidebarIndex: 0,
		mode: "list",
		bodyScrollOffset: 0,
		sidebarScrollOffset: 0,
		expandValues: false,
		notification: null,
		pendingG: false,
		entries,
		sidebarItems: [],
		lensDataCache: new Map(),
		activityCache: null,
		mindsCache: null,
		lastRefreshAt: Date.now(),
	};
	setSidebarItems(state, buildSidebarItems(entries, [], []));
	return state;
}

export function readTtlCache<T>(
	cache: TtlCache<T> | null,
	ttlMs: number,
	now: number,
	fetcher: () => T,
): { cache: TtlCache<T>; value: T } {
	if (cache && now - cache.fetchedAt < ttlMs) {
		return { cache, value: cache.value };
	}
	const value = fetcher();
	return { cache: { value, fetchedAt: now }, value };
}

export function invalidateActivityCache(state: ObservatoryViewState): void {
	state.activityCache = null;
}

export function invalidateMindsCache(state: ObservatoryViewState): void {
	state.mindsCache = null;
}

export function sidebarItemCount(state: ObservatoryViewState): number {
	return state.sidebarItems.length;
}

export function selectionForIndex(
	state: ObservatoryViewState,
	index: number,
): ObservatorySelection {
	const item = state.sidebarItems[index];
	if (!item || !isSelectableItem(item)) return { kind: "dashboard" };
	if (item.kind === "dashboard") return { kind: "dashboard" };
	return { kind: "lens", lensId: item.id };
}

export function setSelectedIndex(
	state: ObservatoryViewState,
	index: number,
): void {
	const items = state.sidebarItems;
	if (items.length === 0) return;
	const direction: 1 | -1 = index >= state.selectedSidebarIndex ? 1 : -1;
	const found = findSelectableIndex(items, index, direction);
	if (found < 0) return;
	state.selectedSidebarIndex = found;
	state.selection = selectionForIndex(state, found);
	state.bodyScrollOffset = 0;
}

// Replaces sidebarItems with `items` and re-resolves selection by id so
// the active lens stays selected across discovery refreshes.
export function setSidebarItems(
	state: ObservatoryViewState,
	items: SidebarItem[],
): void {
	state.sidebarItems = items;
	if (items.length === 0) {
		state.selectedSidebarIndex = 0;
		state.selection = { kind: "dashboard" };
		return;
	}
	const preferredId =
		state.selection.kind === "lens" ? state.selection.lensId : "__dashboard__";
	let foundIndex = -1;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		if (isSelectableItem(it) && it.id === preferredId) {
			foundIndex = i;
			break;
		}
	}
	if (foundIndex < 0) {
		foundIndex = items.findIndex(isSelectableItem);
	}
	if (foundIndex < 0) {
		state.selectedSidebarIndex = 0;
		state.selection = { kind: "dashboard" };
		return;
	}
	state.selectedSidebarIndex = foundIndex;
	state.selection = selectionForIndex(state, foundIndex);
}

export function setEntries(
	state: ObservatoryViewState,
	entries: DiscoveryEntry[],
): void {
	state.entries = entries;
	state.lastRefreshAt = Date.now();
	// Rebuild items with empty mind/room context. The component is expected
	// to follow up with setSidebarItems to inject live mind + room data.
	setSidebarItems(state, buildSidebarItems(entries, [], []));
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
