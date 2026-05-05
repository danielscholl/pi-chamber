// shared/notice — common notification primitives for chamber features.
//
// Two emission paths share a single capability check (hasUI + ui.setWidget):
//
// 1. notify(ctx, msg, type)
//    Top-of-screen toast via ctx.ui.notify, with a sensible fallback when no
//    UI is attached (errors throw + log to stderr; info/warning log to stdout
//    so headless `pi --print` users still see them).
//
// 2. createTransientNotice({ widgetKey, ttlMs, render, placement })
//    Factory that returns an emit function. Renders text as an ephemeral
//    widget anchored to the editor (auto-clears after ttlMs). Falls back to
//    notify() when ctx.ui has no setWidget. Each caller owns a widgetKey +
//    timer pair, so emissions from different features don't fight over the
//    same slot.
//
// renderNoticeLine(text, level) is the colored italic line both /room and
// /assembly use; exported so callers can build their own widgets while
// preserving the chamber's house style.

export type NoticeLevel = "info" | "warning";
export type NotifyType = "info" | "warning" | "error";

export type NoticeContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, type?: NotifyType): void;
		setWidget?: (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => void;
	};
};

export function notify(
	ctx: NoticeContext,
	message: string,
	type: NotifyType = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	if (type === "error") {
		// stderr so the message is visible in headless / `pi --print` runs even
		// though we're about to throw and let the caller decide how to surface it.
		console.error(message);
		throw new Error(message);
	}
	console.log(message);
}

export type TransientNoticeOptions = {
	widgetKey: string;
	ttlMs?: number;
	render?: (text: string, level: NoticeLevel) => string;
	placement?: "aboveEditor" | "belowEditor";
};

export type TransientNoticeEmitter = (
	ctx: NoticeContext,
	text: string,
	level?: NoticeLevel,
) => void;

const DEFAULT_TTL_MS = 8000;

export function createTransientNotice(
	opts: TransientNoticeOptions,
): TransientNoticeEmitter {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const render = opts.render ?? renderNoticeLine;
	const placement = opts.placement ?? "aboveEditor";
	let timer: ReturnType<typeof setTimeout> | undefined;

	return function emit(ctx, text, level = "info") {
		if (!ctx.hasUI) {
			notify(ctx, text, level);
			return;
		}
		const setWidget = ctx.ui.setWidget;
		if (!setWidget) {
			notify(ctx, text, level);
			return;
		}
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		setWidget(opts.widgetKey, [render(text, level)], { placement });
		timer = setTimeout(() => {
			timer = undefined;
			try {
				setWidget(opts.widgetKey, undefined);
			} catch {
				// ctx may be torn down by the time the timer fires
			}
		}, ttlMs);
		// Don't keep the process alive just to clear a notice.
		(timer as { unref?: () => void }).unref?.();
	};
}

const NOTICE_INFO_RGB: [number, number, number] = [140, 160, 180];
const NOTICE_WARNING_RGB: [number, number, number] = [220, 180, 100];

export function renderNoticeLine(
	text: string,
	level: NoticeLevel = "info",
): string {
	const rgb = level === "warning" ? NOTICE_WARNING_RGB : NOTICE_INFO_RGB;
	const dot = ansiFg(rgb, "·");
	const body = ansiFg(rgb, ansiItalic(text || ""));
	return `${dot} ${body}`;
}

// ---------------------------------------------------------------------------
// Transient panels — multi-line variant
//
// For multi-line structured info (signals summaries, proposals, authoring
// recaps) where a one-shot toast is the wrong shape. Same widget surface as
// transient notice (anchored above/below the editor), but the content is an
// array of pre-rendered lines and the default styling is pass-through so the
// caller controls layout.
//
// Pass `undefined` or `[]` to dismiss early. Successive emits with the same
// widgetKey replace prior content. ttlMs of 0 means "persistent until the
// next emit dismisses it" (use only when you guarantee a follow-up emit, or
// prepare to dismiss on every exit path).
// ---------------------------------------------------------------------------

const DEFAULT_PANEL_TTL_MS = 20000;

export type TransientPanelOptions = {
	widgetKey: string;
	/** Auto-clear after this many ms. Set to 0 to keep the panel open until
	 * the caller emits again (or passes `undefined` / `[]` to dismiss). */
	ttlMs?: number;
	placement?: "aboveEditor" | "belowEditor";
	/** Hook to style each line. Default: pass-through (no styling). */
	render?: (lines: ReadonlyArray<string>) => string[];
};

export type TransientPanelEmitter = (
	ctx: NoticeContext,
	lines: ReadonlyArray<string> | undefined,
) => void;

export function createTransientPanel(
	opts: TransientPanelOptions,
): TransientPanelEmitter {
	const ttlMs = opts.ttlMs ?? DEFAULT_PANEL_TTL_MS;
	const placement = opts.placement ?? "aboveEditor";
	const render = opts.render ?? ((lines) => lines.slice());
	let timer: ReturnType<typeof setTimeout> | undefined;

	const cancelTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	return function emit(ctx, lines) {
		const setWidget = ctx.ui.setWidget;

		// Headless / no widget host: print each line via shared notify so
		// `pi --print` users still see the content.
		if (!ctx.hasUI || !setWidget) {
			if (lines && lines.length > 0) {
				for (const line of lines) notify(ctx, line, "info");
			}
			return;
		}

		cancelTimer();

		if (!lines || lines.length === 0) {
			try {
				setWidget(opts.widgetKey, undefined);
			} catch {
				// widget host may already be torn down
			}
			return;
		}

		setWidget(opts.widgetKey, render(lines), { placement });

		if (ttlMs > 0) {
			timer = setTimeout(() => {
				timer = undefined;
				try {
					setWidget(opts.widgetKey, undefined);
				} catch {
					// ctx may be torn down by the time the timer fires
				}
			}, ttlMs);
			(timer as { unref?: () => void }).unref?.();
		}
	};
}

// ---------------------------------------------------------------------------
// Working-state panel — animated progress for long-running operations
//
// While a feature is doing opaque work (e.g. /assembly's proposer call,
// 10-30s), the operator needs proof the system is alive. Mirrors the
// /genesis "birth" indicator: spinner + rotating phrase + elapsed seconds,
// ticked into a setWidget slot. Optional static footer below the animated
// header carries a one-line summary of context (what's being scanned, etc.)
// so the user retains awareness of inputs without losing the "working" cue.
//
// Lifecycle: caller invokes startWorkingPanel(ctx, opts) which begins ticking
// immediately and returns a stop fn. Stop is idempotent, clears the widget,
// and is safe to call from finally / catch. Headless / no-setWidget fallback:
// emit one shared notify with initial phrase + footer; return a no-op stop.
// ---------------------------------------------------------------------------

const WORKING_SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
] as const;

const DEFAULT_FRAME_INTERVAL_MS = 120;
const DEFAULT_PHRASE_INTERVAL_MS = 1800;

export type WorkingPanelState = {
	label: string;
	phrase: string;
	spinner: string;
	elapsedMs: number;
	footer: ReadonlyArray<string>;
};

export type WorkingPanelOptions = {
	widgetKey: string;
	/** Header text shown next to the spinner (e.g. "assembly"). */
	label: string;
	/** Phrases rotated every phraseIntervalMs. Must contain at least one. */
	phrases: ReadonlyArray<string>;
	/** Static lines shown below the animated header. Pass-through to the
	 * widget; the caller controls styling. */
	footer?: ReadonlyArray<string>;
	frameIntervalMs?: number;
	phraseIntervalMs?: number;
	placement?: "aboveEditor" | "belowEditor";
	/** Custom render hook. Default: spinner + label + phrase + elapsed in
	 * the first line, then footer lines verbatim. */
	render?: (state: WorkingPanelState) => string[];
};

export function startWorkingPanel(
	ctx: NoticeContext,
	opts: WorkingPanelOptions,
): () => void {
	if (opts.phrases.length === 0) {
		throw new Error("startWorkingPanel requires at least one phrase");
	}
	const frameIntervalMs = opts.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
	const phraseIntervalMs = opts.phraseIntervalMs ?? DEFAULT_PHRASE_INTERVAL_MS;
	const placement = opts.placement ?? "aboveEditor";
	const render = opts.render ?? renderWorkingPanel;
	const footer = opts.footer ?? [];

	const setWidget = ctx.ui.setWidget;

	// Headless / no widget host: emit a one-shot notify so something is
	// visible, then return a no-op stop. We don't tick in headless mode
	// because there's no surface to update.
	if (!ctx.hasUI || !setWidget) {
		const initialPhrase = opts.phrases[0] ?? "";
		notify(ctx, `${opts.label} | ${initialPhrase}…`, "info");
		for (const line of footer) notify(ctx, line, "info");
		return () => {
			/* no-op in headless mode */
		};
	}

	const startedAt = Date.now();
	let frame = 0;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		const elapsedMs = Date.now() - startedAt;
		const phraseIndex =
			Math.floor(elapsedMs / phraseIntervalMs) % opts.phrases.length;
		const spinner =
			WORKING_SPINNER_FRAMES[frame % WORKING_SPINNER_FRAMES.length] ?? "·";
		const lines = render({
			label: opts.label,
			phrase: opts.phrases[phraseIndex] ?? "",
			spinner,
			elapsedMs,
			footer,
		});
		try {
			setWidget(opts.widgetKey, lines, { placement });
		} catch {
			// widget host may already be torn down
		}
		frame += 1;
	};

	tick();
	const handle = setInterval(tick, frameIntervalMs);
	(handle as { unref?: () => void }).unref?.();

	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(handle as ReturnType<typeof setInterval>);
		try {
			setWidget(opts.widgetKey, undefined);
		} catch {
			// widget host may already be torn down
		}
	};
}

function renderWorkingPanel(state: WorkingPanelState): string[] {
	const seconds = Math.floor(state.elapsedMs / 1000);
	const header = `${state.spinner} ${state.label} | ${state.phrase}… ${seconds}s`;
	return [header, ...state.footer];
}

function ansiFg(rgb: [number, number, number], text: string): string {
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function ansiItalic(text: string): string {
	return `\x1b[3m${text}\x1b[23m`;
}
