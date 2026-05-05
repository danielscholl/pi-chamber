// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, readFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import process from "node:process";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type DiscoveryEntry,
	type LensManifest,
	discoverLenses,
	lensesActivitySummary,
	readLensData,
} from "../core.ts";
import { listGenesisMinds } from "../../mind/core.ts";
import { handleObservatoryInput } from "./input.ts";
import {
	type RoomSidebarEntry,
	buildSidebarItems,
	clampSidebarScroll,
	renderSidebar,
} from "./render-sidebar.ts";
import { normalizeStatusBoard } from "./status.ts";
import {
	type DashboardActivity,
	renderDashboard,
} from "./render-dashboard.ts";
import { renderBriefing } from "./render-briefing.ts";
import { type ProcedureRunDetail, renderDagRun } from "./render-dag-run.ts";
import { renderStatusBoard } from "./render-status-board.ts";
import { renderHelp } from "./render-help.ts";
import {
	computeColumnLayout,
	renderObservatoryFrame,
} from "./render-layout.ts";
import {
	type ObservatoryNotification,
	type ObservatoryViewState,
	clearNotification,
	createObservatoryViewState,
	invalidateActivityCache,
	invalidateMindsCache,
	notificationIsExpired,
	readTtlCache,
	setBodyNav,
	setEntries,
	setLensData,
	setNotification,
	setSidebarItems,
	sidebarItemCount,
} from "./state.ts";
import { type LensWatcher, type WatcherChange, startLensWatcher } from "./watcher.ts";
import type { Colorize, ThemeColorKey } from "./widgets/types.ts";

const FOOTER_LIST = "j/k navigate · enter view · r refresh · ? help · q quit";
const FOOTER_DETAIL = "j/k scroll · gg/G top/bottom · e expand (flat) · esc back · q quit";
const FOOTER_HELP = "? close help · q quit";

const MIN_WIDTH = 50;
const MAX_WIDTH = 140;
const MIN_HEIGHT = 14;
const MAX_HEIGHT = 50;

const ACTIVITY_TTL_MS = 2_000;
const MINDS_TTL_MS = 5_000;

export class ObservatoryOverlay implements Component, Focusable {
	focused = true;
	private viewState: ObservatoryViewState;
	private watcher: LensWatcher | null = null;
	private lastBodyLineCount = 0;
	private lastViewportHeight = MIN_HEIGHT;
	private notificationFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private widgetColorize: Colorize;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private cwd: string,
		private lensesRoot: string,
		private done: () => void,
	) {
		this.viewState = createObservatoryViewState(this.safeDiscover());
		this.widgetColorize = this.buildWidgetColorize();
		this.attachWatcher();
	}

	get width(): number {
		const cols = process.stdout.columns ?? 90;
		return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols));
	}

	render(width: number): string[] {
		this.expireNotificationIfNeeded();
		const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width || this.width));
		const h = this.computeHeight();
		this.lastViewportHeight = h;

		const layout = computeColumnLayout(w, h);
		this.refreshSidebarItems();
		const sidebarItems = sidebarItemCount(this.viewState);
		const sidebarScroll = clampSidebarScroll(
			this.viewState.selectedSidebarIndex,
			layout.bodyHeight,
			sidebarItems,
			this.viewState.sidebarScrollOffset,
		);
		this.viewState.sidebarScrollOffset = sidebarScroll;

		const sidebarLines = renderSidebar(
			this.viewState.sidebarItems,
			this.viewState.selectedSidebarIndex,
			layout.sidebarWidth,
			layout.bodyHeight,
			sidebarScroll,
			this.widgetColorize,
		);

		const { bodyLines, subtitle } = this.composeBody(layout.bodyWidth);
		this.lastBodyLineCount = bodyLines.length;
		const slicedBody = bodyLines.slice(
			this.viewState.bodyScrollOffset,
			this.viewState.bodyScrollOffset + layout.bodyHeight,
		);

		const footer = this.footerForMode();
		const notif = this.viewState.notification;

		const frame = renderObservatoryFrame({
			title: this.colorize("accent", "Observatory"),
			subtitle,
			sidebar: sidebarLines,
			body: slicedBody,
			footer,
			notification: notif
				? { message: notif.message, type: notif.type }
				: null,
			width: w,
			height: h,
		});

		return frame;
	}

	handleInput(data: string): void {
		handleObservatoryInput(this.viewState, data, {
			requestRender: () => this.tui.requestRender(),
			exit: () => {
				// pi-tui does not call dispose() on non-overlay custom components
				// when their done() resolver fires. Tear down the watcher and
				// pending notification timer ourselves before the runtime drops
				// our reference, otherwise every /observatory open/close cycle
				// leaks an fs.watch handle.
				this.dispose();
				this.done();
			},
			refresh: () => this.refresh(),
			bodyContentLines: () => this.lastBodyLineCount,
			viewportHeight: () => this.lastViewportHeight,
		});
	}

	invalidate(): void {
		invalidateActivityCache(this.viewState);
		invalidateMindsCache(this.viewState);
	}

	dispose(): void {
		this.watcher?.stop();
		this.watcher = null;
		if (this.notificationFlushTimer) {
			clearTimeout(this.notificationFlushTimer);
			this.notificationFlushTimer = null;
		}
	}

	private computeHeight(): number {
		const rows = process.stdout.rows ?? 24;
		return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, rows - 4));
	}

	private composeBody(width: number): { bodyLines: string[]; subtitle: string } {
		if (this.viewState.mode === "help") {
			return { bodyLines: renderHelp(width), subtitle: "Help" };
		}
		if (this.viewState.selection.kind === "dashboard") {
			return {
				bodyLines: renderDashboard(
					this.collectDashboardData(),
					width,
					this.widgetColorize,
				),
				subtitle: "Dashboard",
			};
		}
		const lensId = this.viewState.selection.lensId;
		const entry = this.viewState.entries.find((e) => e.id === lensId);
		if (!entry) {
			return {
				bodyLines: [
					`Lens "${lensId}" is no longer present.`,
					"",
					"Select another lens or press r to refresh.",
				],
				subtitle: lensId,
			};
		}
		if (entry.status === "invalid") {
			return {
				bodyLines: [
					`Lens "${entry.id}" is invalid.`,
					"",
					`Reason: ${entry.reason}`,
					"",
					"Fix lens.json and press r to refresh.",
				],
				subtitle: entry.id,
			};
		}
		const data = this.loadLensData(entry.manifest);
		const subtitle = `${entry.manifest.name} · ${entry.manifest.kind}`;
		if (!data.ok) {
			const reason = "reason" in data ? data.reason : "unknown";
			return {
				bodyLines: [
					`Could not read lens "${entry.id}":`,
					"",
					reason,
				],
				subtitle,
			};
		}
		if (entry.manifest.kind === "briefing") {
			return {
				bodyLines: renderBriefing(
					data.data,
					width,
					this.viewState.expandValues,
					this.widgetColorize,
					entry.manifest,
				),
				subtitle,
			};
		}
		if (entry.manifest.kind === "dag-run") {
			const drilledRunDetail = this.loadDrilledRunDetail();
			const result = renderDagRun({
				data: data.data,
				drilledRunDetail,
				drillStack: this.viewState.drillStack,
				bodySelectedIndex: this.viewState.bodySelectedIndex,
				width,
				colorize: this.widgetColorize,
			});
			setBodyNav(this.viewState, result.bodyNav);
			return { bodyLines: result.bodyLines, subtitle };
		}
		return {
			bodyLines: renderStatusBoard(data.data, width, this.widgetColorize),
			subtitle,
		};
	}

	private loadLensData(manifest: LensManifest) {
		const cached = this.viewState.lensDataCache.get(manifest.id);
		if (cached) return cached;
		const result = readLensData(this.lensesRoot, manifest.id, manifest);
		setLensData(this.viewState, manifest.id, result);
		return result;
	}

	/**
	 * Resolve the run detail for the current top-of-drill-stack frame on the
	 * dag-run lens. Returns null when:
	 *  - the drill stack is empty (rendering the history list)
	 *  - the drilled run IS the current run (renderer uses lens.data.current)
	 *  - no per-run snapshot exists on disk (older run, pre-lens)
	 *
	 * The procedures lens writes per-run snapshots under
	 * `<lensesRoot>/procedures/runs/<runId>.json` (see procedures/observatory.ts).
	 * We read them inline here rather than cross-importing from procedures/ —
	 * the JSON-on-disk shape is the contract.
	 */
	private loadDrilledRunDetail(): ProcedureRunDetail | null {
		const top = this.viewState.drillStack[0];
		if (!top || top.kind !== "run") return null;
		const filePath = path.join(this.lensesRoot, "procedures", "runs", `${top.id}.json`);
		if (!existsSync(filePath)) return null;
		try {
			const raw = readFileSync(filePath, "utf-8");
			return JSON.parse(raw) as ProcedureRunDetail;
		} catch {
			return null;
		}
	}

	private refreshSidebarItems(): void {
		const minds = this.readMinds();
		setSidebarItems(
			this.viewState,
			buildSidebarItems(
				this.viewState.entries,
				minds,
				this.collectRoomSidebarEntries(),
			),
		);
	}

	private readMinds(): string[] {
		const result = readTtlCache(
			this.viewState.mindsCache,
			MINDS_TTL_MS,
			Date.now(),
			() => safeListMinds(this.cwd),
		);
		this.viewState.mindsCache = result.cache;
		return result.value;
	}

	private readActivity(): DashboardActivity | null {
		const result = readTtlCache(
			this.viewState.activityCache,
			ACTIVITY_TTL_MS,
			Date.now(),
			() => lensesActivitySummary(this.lensesRoot),
		);
		this.viewState.activityCache = result.cache;
		return result.value;
	}

	private collectRoomSidebarEntries(): RoomSidebarEntry[] {
		const roomEntry = this.viewState.entries.find(
			(e) => e.id === "room" && e.status === "ok",
		);
		if (!roomEntry || roomEntry.status !== "ok") return [];
		const result = this.loadLensData(roomEntry.manifest);
		if (!result.ok) return [];
		return normalizeStatusBoard(result.data).map((e) => ({
			name: e.name,
			status: e.status,
			tier: e.tier,
		}));
	}

	private collectDashboardData() {
		const minds = this.readMinds();
		const activity = this.readActivity();
		const roomEntry = this.viewState.entries.find(
			(e) => e.id === "room" && e.status === "ok",
		);
		let roomData: unknown = null;
		if (roomEntry && roomEntry.status === "ok") {
			const result = this.loadLensData(roomEntry.manifest);
			if (result.ok) roomData = result.data;
		}
		const procEntry = this.viewState.entries.find(
			(e) => e.id === "procedures" && e.status === "ok",
		);
		let proceduresData: unknown = null;
		if (procEntry && procEntry.status === "ok") {
			const result = this.loadLensData(procEntry.manifest);
			if (result.ok) proceduresData = result.data;
		}
		return {
			entries: this.viewState.entries,
			roomData,
			proceduresData,
			minds,
			activity,
			now: Date.now(),
		};
	}

	private footerForMode(): string {
		if (this.viewState.mode === "help") return this.colorize("dim", FOOTER_HELP);
		if (this.viewState.mode === "detail") return this.colorize("dim", FOOTER_DETAIL);
		return this.colorize("dim", FOOTER_LIST);
	}

	private safeDiscover(): DiscoveryEntry[] {
		try {
			return discoverLenses(this.lensesRoot);
		} catch {
			return [];
		}
	}

	private attachWatcher(): void {
		this.watcher = startLensWatcher(this.lensesRoot, (kind) =>
			this.onWatcherChange(kind),
		);
	}

	private onWatcherChange(kind: WatcherChange): void {
		if (kind === "discover") {
			setEntries(this.viewState, this.safeDiscover());
			this.viewState.lensDataCache.clear();
			invalidateActivityCache(this.viewState);
			// New lens directories are typically created alongside new minds
			// (Genesis seeds both). Drop the mind cache so the sidebar reflects
			// the new mind on the next render rather than waiting out the TTL.
			invalidateMindsCache(this.viewState);
		} else if (kind === "data") {
			if (this.viewState.selection.kind === "lens") {
				this.viewState.lensDataCache.delete(this.viewState.selection.lensId);
			}
			invalidateActivityCache(this.viewState);
		}
		this.tui.requestRender();
	}

	private refresh(): void {
		setEntries(this.viewState, this.safeDiscover());
		this.viewState.lensDataCache.clear();
		invalidateActivityCache(this.viewState);
		invalidateMindsCache(this.viewState);
		this.notify("Refreshed.", "info");
		this.tui.requestRender();
	}

	private notify(
		message: string,
		type: ObservatoryNotification["type"] = "info",
	): void {
		setNotification(this.viewState, message, type, 3_000);
		if (this.notificationFlushTimer) clearTimeout(this.notificationFlushTimer);
		this.notificationFlushTimer = setTimeout(() => {
			this.notificationFlushTimer = null;
			clearNotification(this.viewState);
			this.tui.requestRender();
		}, 3_000);
	}

	private expireNotificationIfNeeded(): void {
		if (notificationIsExpired(this.viewState)) {
			clearNotification(this.viewState);
		}
	}

	private colorize(color: "accent" | "dim", text: string): string {
		try {
			return this.theme.fg(color, text);
		} catch {
			return text;
		}
	}

	private buildWidgetColorize(): Colorize {
		const themeFg = (key: string, text: string): string => {
			try {
				// biome-ignore lint/suspicious/noExplicitAny: pi-tui ThemeColor union is wider than our key set; narrowing is the adapter's job.
				return this.theme.fg(key as any, text);
			} catch {
				return text;
			}
		};
		const themeBg = (key: string, text: string): string => {
			try {
				// biome-ignore lint/suspicious/noExplicitAny: pi-tui ThemeBg union is internal; the adapter narrows to known keys.
				return this.theme.bg(key as any, text);
			} catch {
				return text;
			}
		};
		const themeBold = (text: string): string => {
			try {
				return this.theme.bold(text);
			} catch {
				return text;
			}
		};
		return (key: ThemeColorKey, text: string) => {
			switch (key) {
				case "border":
					return themeFg("border", text);
				case "borderAccent":
					return themeFg("borderAccent", text);
				case "borderMuted":
					return themeFg("borderMuted", text);
				case "accent":
					return themeFg("accent", text);
				case "muted":
					return themeFg("muted", text);
				case "dim":
					return themeFg("dim", text);
				case "success":
					return themeFg("success", text);
				case "warn":
					return themeFg("warning", text);
				case "error":
					return themeFg("error", text);
				case "selectedBg":
					return themeBg("selectedBg", text);
				case "bold":
					return themeBold(text);
				default:
					return text;
			}
		};
	}
}

function safeListMinds(cwd: string): string[] {
	try {
		return listGenesisMinds(cwd);
	} catch {
		return [];
	}
}
