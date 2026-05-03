// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import process from "node:process";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
	type DiscoveryEntry,
	type LensManifest,
	discoverLenses,
	readLensData,
} from "../core.ts";
import { listGenesisMinds } from "../../mind/core.ts";
import { handleObservatoryInput } from "./input.ts";
import {
	clampSidebarScroll,
	renderSidebar,
} from "./render-sidebar.ts";
import {
	type DashboardActivity,
	lensesActivitySummary,
	renderDashboard,
} from "./render-dashboard.ts";
import { renderBriefing } from "./render-briefing.ts";
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
	notificationIsExpired,
	setEntries,
	setLensData,
	setNotification,
	sidebarItemCount,
} from "./state.ts";
import { type LensWatcher, type WatcherChange, startLensWatcher } from "./watcher.ts";
import type { Colorize, ThemeColorKey } from "./widgets/types.ts";

const FOOTER_LIST = "j/k navigate · enter view · r refresh · ? help · q quit";
const FOOTER_DETAIL = "j/k scroll · gg/G top/bottom · e expand · esc back · q quit";
const FOOTER_HELP = "? close help · q quit";

const MIN_WIDTH = 50;
const MAX_WIDTH = 140;
const MIN_HEIGHT = 14;
const MAX_HEIGHT = 50;

export class ObservatoryOverlay implements Component, Focusable {
	focused = true;
	private viewState: ObservatoryViewState;
	private watcher: LensWatcher | null = null;
	private lastBodyLineCount = 0;
	private lastViewportHeight = MIN_HEIGHT;
	private cachedActivity: DashboardActivity | null = null;
	private cachedActivityAt = 0;
	private cachedMinds: string[] | null = null;
	private cachedMindsAt = 0;
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
		const sidebarItems = sidebarItemCount(this.viewState);
		const sidebarScroll = clampSidebarScroll(
			this.viewState.selectedSidebarIndex,
			layout.bodyHeight,
			sidebarItems,
			this.viewState.sidebarScrollOffset,
		);
		this.viewState.sidebarScrollOffset = sidebarScroll;

		const sidebarLines = renderSidebar(
			this.viewState.entries,
			this.viewState.selection,
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
			exit: () => this.done(),
			refresh: () => this.refresh(),
			bodyContentLines: () => this.lastBodyLineCount,
			viewportHeight: () => this.lastViewportHeight,
		});
	}

	invalidate(): void {
		this.cachedActivity = null;
		this.cachedActivityAt = 0;
		this.cachedMinds = null;
		this.cachedMindsAt = 0;
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
				),
				subtitle,
			};
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

	private collectDashboardData() {
		const now = Date.now();
		if (!this.cachedMinds || now - this.cachedMindsAt > 5_000) {
			this.cachedMinds = safeListMinds(this.cwd);
			this.cachedMindsAt = now;
		}
		if (!this.cachedActivity || now - this.cachedActivityAt > 2_000) {
			this.cachedActivity = lensesActivitySummary(this.lensesRoot);
			this.cachedActivityAt = now;
		}
		const roomEntry = this.viewState.entries.find(
			(e) => e.id === "room" && e.status === "ok",
		);
		let roomData: unknown = null;
		if (roomEntry && roomEntry.status === "ok") {
			const result = this.loadLensData(roomEntry.manifest);
			if (result.ok) roomData = result.data;
		}
		return {
			entries: this.viewState.entries,
			roomData,
			minds: this.cachedMinds ?? [],
			activity: this.cachedActivity,
			now,
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
			this.cachedActivity = null;
			this.cachedActivityAt = 0;
		} else if (kind === "data") {
			if (this.viewState.selection.kind === "lens") {
				this.viewState.lensDataCache.delete(this.viewState.selection.lensId);
			}
			this.cachedActivity = null;
			this.cachedActivityAt = 0;
		}
		this.tui.requestRender();
	}

	private refresh(): void {
		setEntries(this.viewState, this.safeDiscover());
		this.viewState.lensDataCache.clear();
		this.cachedActivity = null;
		this.cachedActivityAt = 0;
		this.cachedMinds = null;
		this.cachedMindsAt = 0;
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
