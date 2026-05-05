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

/**
 * One frame in the body-local drill stack used by the dag-run lens to model
 * history → run → node navigation. Empty stack = lens root view; a single
 * frame = run-detail; two frames = node-detail. Other lenses ignore this.
 */
export interface BodyDrillFrame {
	kind: "run" | "node";
	id: string;
}

/**
 * Body-local navigation contract the input handler uses to drive j/k + Enter.
 * The component sets this based on what's currently rendered in the body.
 *
 *   { kind: "none" }   — body has no per-row selection (briefing, status-board,
 *                        node-detail leaf). j/k falls through to scroll.
 *   { kind: "list", ids, pushKind }
 *                      — body has a selectable list (dag-run history rows or
 *                        run-detail node rows). j/k cycles bodySelectedIndex
 *                        in [0, ids.length); Enter pushes a drill frame
 *                        `{ kind: pushKind, id: ids[bodySelectedIndex] }`.
 */
export type BodyNavState =
	| { kind: "none" }
	| { kind: "list"; ids: string[]; pushKind: BodyDrillFrame["kind"] };

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
	/**
	 * Body-local drill stack. Empty for non-drillable lenses. Owned by the
	 * lens body; list/detail/help modes are unchanged. See BodyDrillFrame.
	 */
	drillStack: BodyDrillFrame[];
	/** Index into bodyNav.ids when bodyNav.kind === "list". */
	bodySelectedIndex: number;
	/** Set by the renderer to advertise body-local selection semantics. */
	bodyNav: BodyNavState;
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
		drillStack: [],
		bodySelectedIndex: 0,
		bodyNav: { kind: "none" },
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
	resetBodyDrill(state);
}

// Replaces sidebarItems with `items` and re-resolves selection by id so
// the active lens stays selected across discovery refreshes.
export function setSidebarItems(
	state: ObservatoryViewState,
	items: SidebarItem[],
): void {
	const previousLensId =
		state.selection.kind === "lens" ? state.selection.lensId : null;
	state.sidebarItems = items;
	if (items.length === 0) {
		state.selectedSidebarIndex = 0;
		state.selection = { kind: "dashboard" };
		resetBodyDrill(state);
		return;
	}
	const preferredId = previousLensId ?? "__dashboard__";
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
		resetBodyDrill(state);
		return;
	}
	state.selectedSidebarIndex = foundIndex;
	const newSelection = selectionForIndex(state, foundIndex);
	state.selection = newSelection;
	// Only reset drill state if the selection actually changed lens — a no-op
	// rebuild (discovery refresh) keeps the operator's drill context.
	const newLensId = newSelection.kind === "lens" ? newSelection.lensId : null;
	if (newLensId !== previousLensId) {
		resetBodyDrill(state);
	}
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

// ---------------------------------------------------------------------------
// Body drill helpers (used by dag-run lens; ignored by other lenses)
// ---------------------------------------------------------------------------

/** Push a frame onto the drill stack and reset the per-page selection. */
export function pushDrill(state: ObservatoryViewState, frame: BodyDrillFrame): void {
	state.drillStack.push(frame);
	state.bodySelectedIndex = 0;
	state.bodyScrollOffset = 0;
	state.bodyNav = { kind: "none" };
}

/** Pop the top frame; returns true when something was popped. */
export function popDrill(state: ObservatoryViewState): boolean {
	if (state.drillStack.length === 0) return false;
	state.drillStack.pop();
	state.bodySelectedIndex = 0;
	state.bodyScrollOffset = 0;
	state.bodyNav = { kind: "none" };
	return true;
}

/** Return the top drill frame, or null when at the lens root. */
export function currentDrill(state: ObservatoryViewState): BodyDrillFrame | null {
	const top = state.drillStack[state.drillStack.length - 1];
	return top ?? null;
}

/** Reset all body-local navigation state. Called on lens-change. */
function resetBodyDrill(state: ObservatoryViewState): void {
	state.drillStack = [];
	state.bodySelectedIndex = 0;
	state.bodyNav = { kind: "none" };
}

/**
 * Set the body's selection contract (called by the renderer each frame so
 * the input handler knows whether j/k cycles items or scrolls). When called
 * with a `list` of N items, clamps `bodySelectedIndex` to [0, N).
 */
export function setBodyNav(state: ObservatoryViewState, nav: BodyNavState): void {
	state.bodyNav = nav;
	if (nav.kind === "list") {
		if (nav.ids.length === 0) {
			state.bodySelectedIndex = 0;
		} else if (state.bodySelectedIndex >= nav.ids.length) {
			state.bodySelectedIndex = nav.ids.length - 1;
		}
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
