import {
	type ObservatoryViewState,
	clearAllLensData,
	clearNotification,
	invalidateLensData,
	popDrill,
	pushDrill,
	setMode,
	setSelectedIndex,
} from "./state.ts";

export interface ObservatoryInputContext {
	requestRender: () => void;
	exit: () => void;
	refresh: () => void;
	bodyContentLines: () => number;
	viewportHeight: () => number;
}

export interface ObservatoryInputResult {
	consumed: boolean;
}

const ESC = "\x1b";
const CTRL_D = "\x04";
const CTRL_U = "\x15";
const ENTER_VARIANTS = new Set(["\r", "\n", "\r\n"]);

export function handleObservatoryInput(
	state: ObservatoryViewState,
	data: string,
	ctx: ObservatoryInputContext,
): ObservatoryInputResult {
	if (state.notification) {
		clearNotification(state);
	}

	if (state.mode === "help") {
		if (data === "?" || data === "q" || data === ESC) {
			setMode(state, "list");
			ctx.requestRender();
			return { consumed: true };
		}
		return { consumed: true };
	}

	const isList = state.mode === "list";
	const isDetail = state.mode === "detail";

	if (data === "?") {
		setMode(state, "help");
		ctx.requestRender();
		return { consumed: true };
	}

	if (data === "q") {
		ctx.exit();
		return { consumed: true };
	}

	if (data === ESC || data === "h" || data === "\x1b[D") {
		if (isDetail) {
			// Pop body-local drill first (dag-run lens). Only fall back to
			// list mode once the stack is empty.
			if (popDrill(state)) {
				ctx.requestRender();
				return { consumed: true };
			}
			setMode(state, "list");
			ctx.requestRender();
			return { consumed: true };
		}
		if (isList) {
			ctx.exit();
			return { consumed: true };
		}
	}

	if (data === "r") {
		// Refresh: drop selected lens cache and trigger a re-discover.
		if (state.selection.kind === "lens") {
			invalidateLensData(state, state.selection.lensId);
		} else {
			clearAllLensData(state);
		}
		ctx.refresh();
		return { consumed: true };
	}

	if (data === "e") {
		// Flat-briefing only: switch between truncated cards (default) and
		// wrapped key/value layout that lets the operator read full values.
		state.expandValues = !state.expandValues;
		ctx.requestRender();
		return { consumed: true };
	}

	if (isList) {
		if (data === "j" || data === "\x1b[B") {
			setSelectedIndex(state, state.selectedSidebarIndex + 1);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "k" || data === "\x1b[A") {
			setSelectedIndex(state, state.selectedSidebarIndex - 1);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (ENTER_VARIANTS.has(data) || data === "l" || data === "\x1b[C") {
			// Only enter detail if there's a body to focus (always true: dashboard or lens).
			setMode(state, "detail");
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "g") {
			if (state.pendingG) {
				state.bodyScrollOffset = 0;
				state.pendingG = false;
			} else {
				state.pendingG = true;
			}
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "G") {
			state.bodyScrollOffset = bottomScrollOffset(ctx);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
	}

	if (isDetail) {
		const half = Math.max(1, Math.floor(ctx.viewportHeight() / 2));
		// Body-local row navigation overrides scroll-by-line when the renderer
		// has advertised a list (dag-run lens history + run-detail pages).
		if (state.bodyNav.kind === "list" && state.bodyNav.ids.length > 0) {
			const ids = state.bodyNav.ids;
			if (data === "j" || data === "\x1b[B") {
				state.bodySelectedIndex = Math.min(
					ids.length - 1,
					state.bodySelectedIndex + 1,
				);
				state.pendingG = false;
				ctx.requestRender();
				return { consumed: true };
			}
			if (data === "k" || data === "\x1b[A") {
				state.bodySelectedIndex = Math.max(0, state.bodySelectedIndex - 1);
				state.pendingG = false;
				ctx.requestRender();
				return { consumed: true };
			}
			if (ENTER_VARIANTS.has(data) || data === "l" || data === "\x1b[C") {
				const id = ids[state.bodySelectedIndex];
				if (id !== undefined) {
					pushDrill(state, { kind: state.bodyNav.pushKind, id });
					ctx.requestRender();
				}
				return { consumed: true };
			}
		}
		if (data === "j" || data === "\x1b[B") {
			state.bodyScrollOffset = clampScroll(
				state.bodyScrollOffset + 1,
				ctx,
			);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "k" || data === "\x1b[A") {
			state.bodyScrollOffset = Math.max(0, state.bodyScrollOffset - 1);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === CTRL_D) {
			state.bodyScrollOffset = clampScroll(
				state.bodyScrollOffset + half,
				ctx,
			);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === CTRL_U) {
			state.bodyScrollOffset = Math.max(0, state.bodyScrollOffset - half);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "g") {
			if (state.pendingG) {
				state.bodyScrollOffset = 0;
				state.pendingG = false;
			} else {
				state.pendingG = true;
			}
			ctx.requestRender();
			return { consumed: true };
		}
		if (data === "G") {
			state.bodyScrollOffset = bottomScrollOffset(ctx);
			state.pendingG = false;
			ctx.requestRender();
			return { consumed: true };
		}
	}

	state.pendingG = false;
	return { consumed: false };
}

function bottomScrollOffset(ctx: ObservatoryInputContext): number {
	const total = ctx.bodyContentLines();
	const viewport = ctx.viewportHeight();
	return Math.max(0, total - viewport);
}

function clampScroll(value: number, ctx: ObservatoryInputContext): number {
	const max = bottomScrollOffset(ctx);
	if (value < 0) return 0;
	if (value > max) return max;
	return value;
}
