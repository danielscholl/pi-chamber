// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import type { DiscoveryEntry } from "../core.ts";
import { handleObservatoryInput, type ObservatoryInputContext } from "./input.ts";
import {
	createObservatoryViewState,
	setLensData,
	setMode,
	setSelectedIndex,
} from "./state.ts";

function manifestEntry(id: string): DiscoveryEntry {
	return {
		id,
		status: "ok",
		manifest: {
			id,
			name: id,
			kind: "briefing",
			source: "data.json",
		},
	};
}

interface StubCtx extends ObservatoryInputContext {
	renderCalls: number;
	exitCalls: number;
	refreshCalls: number;
}

function makeCtx(opts?: { contentLines?: number; viewport?: number }): StubCtx {
	const counts = { renderCalls: 0, exitCalls: 0, refreshCalls: 0 };
	const ctx: StubCtx = {
		...counts,
		requestRender() {
			ctx.renderCalls++;
		},
		exit() {
			ctx.exitCalls++;
		},
		refresh() {
			ctx.refreshCalls++;
		},
		bodyContentLines() {
			return opts?.contentLines ?? 100;
		},
		viewportHeight() {
			return opts?.viewport ?? 20;
		},
	};
	return ctx;
}

describe("navigation in list mode", () => {
	test("j/k moves the sidebar selection and clamps", () => {
		const state = createObservatoryViewState([
			manifestEntry("ops"),
			manifestEntry("room"),
		]);
		// Items: group(0), dashboard(1), ops(2), room(3), sep(4), group(5), rs(6).
		// Initial selection: dashboard at 1.
		const ctx = makeCtx();
		handleObservatoryInput(state, "j", ctx);
		expect(state.selectedSidebarIndex).toBe(2);
		expect(state.selection).toEqual({ kind: "lens", lensId: "ops" });
		handleObservatoryInput(state, "j", ctx);
		expect(state.selectedSidebarIndex).toBe(3);
		// Past the last selectable: stays at room (3) — separator/group/rs are skipped.
		handleObservatoryInput(state, "j", ctx);
		expect(state.selectedSidebarIndex).toBe(3);
		// k moves up
		handleObservatoryInput(state, "k", ctx);
		expect(state.selectedSidebarIndex).toBe(2);
		// Past the top: stays at dashboard (1) — group LENSES at 0 is skipped.
		handleObservatoryInput(state, "k", ctx);
		handleObservatoryInput(state, "k", ctx);
		expect(state.selectedSidebarIndex).toBe(1);
		expect(state.selection).toEqual({ kind: "dashboard" });
	});

	test("arrow keys mirror j/k", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		const ctx = makeCtx();
		// Initial: dashboard at 1.
		handleObservatoryInput(state, "\x1b[B", ctx);
		expect(state.selectedSidebarIndex).toBe(2);
		handleObservatoryInput(state, "\x1b[A", ctx);
		expect(state.selectedSidebarIndex).toBe(1);
	});

	test("enter/right enters detail mode", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		const ctx = makeCtx();
		handleObservatoryInput(state, "\r", ctx);
		expect(state.mode as string).toBe("detail");

		setMode(state, "list");
		handleObservatoryInput(state, "\x1b[C", ctx);
		expect(state.mode as string).toBe("detail");
	});
});

describe("exit semantics", () => {
	test("q always exits", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		const ctx = makeCtx();
		handleObservatoryInput(state, "q", ctx);
		expect(ctx.exitCalls).toBe(1);
	});

	test("escape exits from list mode but only steps back from detail", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		const ctx = makeCtx();
		setMode(state, "detail");
		handleObservatoryInput(state, "\x1b", ctx);
		expect(state.mode as string).toBe("list");
		expect(ctx.exitCalls).toBe(0);
		handleObservatoryInput(state, "\x1b", ctx);
		expect(ctx.exitCalls).toBe(1);
	});
});

describe("refresh and toggles", () => {
	test("r drops the selected lens from the cache and calls refresh", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2);
		setLensData(state, "ops", { ok: true, data: { x: 1 } });
		const ctx = makeCtx();
		handleObservatoryInput(state, "r", ctx);
		expect(state.lensDataCache.has("ops")).toBe(false);
		expect(ctx.refreshCalls).toBe(1);
	});

	test("r on dashboard clears the whole cache", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setLensData(state, "ops", { ok: true, data: { x: 1 } });
		const ctx = makeCtx();
		handleObservatoryInput(state, "r", ctx);
		expect(state.lensDataCache.size).toBe(0);
	});

	test("e toggles expandValues", () => {
		const state = createObservatoryViewState();
		const ctx = makeCtx();
		expect(state.expandValues).toBe(false);
		handleObservatoryInput(state, "e", ctx);
		expect(state.expandValues).toBe(true);
		handleObservatoryInput(state, "e", ctx);
		expect(state.expandValues).toBe(false);
	});
});

describe("help mode", () => {
	test("? opens help, ? again or q closes it", () => {
		const state = createObservatoryViewState();
		const ctx = makeCtx();
		handleObservatoryInput(state, "?", ctx);
		expect(state.mode).toBe("help");
		handleObservatoryInput(state, "?", ctx);
		expect(state.mode).toBe("list");
		handleObservatoryInput(state, "?", ctx);
		handleObservatoryInput(state, "q", ctx);
		expect(state.mode).toBe("list");
	});
});

describe("scroll in detail mode", () => {
	test("j/k scrolls and clamps to viewport", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2);
		state.mode = "detail";
		const ctx = makeCtx({ contentLines: 10, viewport: 5 });
		// Max scroll = 10 - 5 = 5
		for (let i = 0; i < 10; i++) {
			handleObservatoryInput(state, "j", ctx);
		}
		expect(state.bodyScrollOffset).toBe(5);
		for (let i = 0; i < 10; i++) {
			handleObservatoryInput(state, "k", ctx);
		}
		expect(state.bodyScrollOffset).toBe(0);
	});

	test("ctrl-d / ctrl-u half-page scroll", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2);
		state.mode = "detail";
		const ctx = makeCtx({ contentLines: 100, viewport: 20 });
		handleObservatoryInput(state, "\x04", ctx);
		expect(state.bodyScrollOffset).toBe(10);
		handleObservatoryInput(state, "\x15", ctx);
		expect(state.bodyScrollOffset).toBe(0);
	});

	test("gg jumps to top, G jumps to bottom", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2);
		state.mode = "detail";
		const ctx = makeCtx({ contentLines: 50, viewport: 10 });
		handleObservatoryInput(state, "G", ctx);
		expect(state.bodyScrollOffset).toBe(40);
		handleObservatoryInput(state, "g", ctx);
		expect(state.pendingG).toBe(true);
		handleObservatoryInput(state, "g", ctx);
		expect(state.pendingG).toBe(false);
		expect(state.bodyScrollOffset).toBe(0);
	});

	test("any other key resets the gg chord", () => {
		const state = createObservatoryViewState([manifestEntry("ops")]);
		setSelectedIndex(state, 2);
		state.mode = "detail";
		const ctx = makeCtx({ contentLines: 50, viewport: 10 });
		handleObservatoryInput(state, "g", ctx);
		expect(state.pendingG).toBe(true);
		handleObservatoryInput(state, "j", ctx);
		expect(state.pendingG).toBe(false);
	});
});

describe("notification dismissal", () => {
	test("any key clears an active notification", () => {
		const state = createObservatoryViewState();
		state.notification = {
			message: "Hi",
			type: "info",
			expiresAt: Date.now() + 5000,
		};
		const ctx = makeCtx();
		handleObservatoryInput(state, "j", ctx);
		expect(state.notification).toBeNull();
	});
});
