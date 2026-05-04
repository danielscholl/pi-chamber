// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, mock, test } from "bun:test";
import {
	createTransientNotice,
	createTransientPanel,
	notify,
	renderNoticeLine,
	startWorkingPanel,
	type WorkingPanelState,
} from "./notice.ts";

type Notification = { message: string; type: string };

type WidgetCall = {
	key: string;
	content: string[] | undefined;
	options?: { placement?: "aboveEditor" | "belowEditor" };
};

function makeCtx(opts?: {
	hasUI?: boolean;
	withSetWidget?: boolean;
}) {
	const notifications: Notification[] = [];
	const widgetCalls: WidgetCall[] = [];
	const setWidget = (
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	) => {
		widgetCalls.push({ key, content, options });
	};
	const ctx = {
		hasUI: opts?.hasUI ?? true,
		ui: {
			notify(message: string, type: "info" | "warning" | "error" = "info") {
				notifications.push({ message, type });
			},
			...(opts?.withSetWidget !== false ? { setWidget } : {}),
		},
	};
	return { ctx, notifications, widgetCalls };
}

describe("notify", () => {
	test("delegates to ctx.ui.notify when hasUI is true", () => {
		const { ctx, notifications } = makeCtx();
		notify(ctx, "hello", "info");
		expect(notifications).toEqual([{ message: "hello", type: "info" }]);
	});

	test("throws and logs to stderr on error when no UI", () => {
		const { ctx, notifications } = makeCtx({ hasUI: false });
		const stderr = mock(() => undefined);
		const original = console.error;
		console.error = stderr;
		try {
			expect(() => notify(ctx, "boom", "error")).toThrow("boom");
		} finally {
			console.error = original;
		}
		expect(notifications).toHaveLength(0);
		expect(stderr).toHaveBeenCalledWith("boom");
	});

	test("logs info/warning to stdout when no UI without throwing", () => {
		const { ctx, notifications } = makeCtx({ hasUI: false });
		const stdout = mock(() => undefined);
		const original = console.log;
		console.log = stdout;
		try {
			notify(ctx, "noted", "info");
			notify(ctx, "warn", "warning");
		} finally {
			console.log = original;
		}
		expect(notifications).toHaveLength(0);
		expect(stdout).toHaveBeenCalledTimes(2);
	});
});

describe("createTransientNotice", () => {
	test("renders a widget with the configured key and placement", () => {
		const emit = createTransientNotice({
			widgetKey: "test-notice",
			ttlMs: 50,
		});
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, "hi there");
		expect(widgetCalls).toHaveLength(1);
		expect(widgetCalls[0].key).toBe("test-notice");
		expect(widgetCalls[0].content?.[0]).toContain("hi there");
		expect(widgetCalls[0].options?.placement).toBe("aboveEditor");
	});

	test("auto-clears the widget after the TTL", async () => {
		const emit = createTransientNotice({
			widgetKey: "test-notice",
			ttlMs: 30,
		});
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, "transient");
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Two calls: the set, then the clear.
		expect(widgetCalls).toHaveLength(2);
		expect(widgetCalls[1].content).toBeUndefined();
	});

	test("a follow-up emit cancels the prior timer", async () => {
		const emit = createTransientNotice({
			widgetKey: "test-notice",
			ttlMs: 30,
		});
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, "first");
		emit(ctx, "second");
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Two sets + a single clear (the first set's timer was cancelled).
		expect(widgetCalls).toHaveLength(3);
		expect(widgetCalls[0].content?.[0]).toContain("first");
		expect(widgetCalls[1].content?.[0]).toContain("second");
		expect(widgetCalls[2].content).toBeUndefined();
	});

	test("falls back to notify when no UI", () => {
		const emit = createTransientNotice({ widgetKey: "test-notice" });
		const { ctx, notifications } = makeCtx({ hasUI: false });
		const stdout = mock(() => undefined);
		const original = console.log;
		console.log = stdout;
		try {
			emit(ctx, "headless");
		} finally {
			console.log = original;
		}
		expect(notifications).toHaveLength(0);
		expect(stdout).toHaveBeenCalledWith("headless");
	});

	test("falls back to ctx.ui.notify when setWidget is missing", () => {
		const emit = createTransientNotice({ widgetKey: "test-notice" });
		const { ctx, notifications, widgetCalls } = makeCtx({
			withSetWidget: false,
		});
		emit(ctx, "no-widget", "warning");
		expect(widgetCalls).toHaveLength(0);
		expect(notifications).toEqual([
			{ message: "no-widget", type: "warning" },
		]);
	});
});

describe("createTransientPanel", () => {
	test("emits each line as widget content under the configured key", () => {
		const emit = createTransientPanel({
			widgetKey: "test-panel",
			ttlMs: 50,
		});
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["header", "  body 1", "  body 2"]);
		expect(widgetCalls).toHaveLength(1);
		expect(widgetCalls[0].key).toBe("test-panel");
		expect(widgetCalls[0].content).toEqual(["header", "  body 1", "  body 2"]);
		expect(widgetCalls[0].options?.placement).toBe("aboveEditor");
	});

	test("dismisses on undefined or empty array", () => {
		const emit = createTransientPanel({ widgetKey: "test-panel", ttlMs: 0 });
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["a"]);
		emit(ctx, undefined);
		emit(ctx, ["b"]);
		emit(ctx, []);
		expect(widgetCalls).toHaveLength(4);
		expect(widgetCalls[0].content).toEqual(["a"]);
		expect(widgetCalls[1].content).toBeUndefined();
		expect(widgetCalls[2].content).toEqual(["b"]);
		expect(widgetCalls[3].content).toBeUndefined();
	});

	test("auto-clears the panel after the TTL when ttlMs > 0", async () => {
		const emit = createTransientPanel({ widgetKey: "test-panel", ttlMs: 30 });
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["x"]);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(widgetCalls).toHaveLength(2);
		expect(widgetCalls[1].content).toBeUndefined();
	});

	test("ttlMs of 0 keeps the panel persistent (no auto-clear)", async () => {
		const emit = createTransientPanel({ widgetKey: "test-panel", ttlMs: 0 });
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["x"]);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(widgetCalls).toHaveLength(1);
	});

	test("a follow-up emit cancels the prior timer", async () => {
		const emit = createTransientPanel({ widgetKey: "test-panel", ttlMs: 30 });
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["first"]);
		emit(ctx, ["second"]);
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Two sets + one auto-clear (the first set's timer was cancelled).
		expect(widgetCalls).toHaveLength(3);
		expect(widgetCalls[0].content).toEqual(["first"]);
		expect(widgetCalls[1].content).toEqual(["second"]);
		expect(widgetCalls[2].content).toBeUndefined();
	});

	test("falls back to per-line notify when no UI", () => {
		const emit = createTransientPanel({ widgetKey: "test-panel" });
		const { ctx, notifications } = makeCtx({ hasUI: false });
		const stdout = mock(() => undefined);
		const original = console.log;
		console.log = stdout;
		try {
			emit(ctx, ["alpha", "beta"]);
		} finally {
			console.log = original;
		}
		expect(notifications).toHaveLength(0);
		expect(stdout).toHaveBeenCalledTimes(2);
		expect(stdout).toHaveBeenCalledWith("alpha");
		expect(stdout).toHaveBeenCalledWith("beta");
	});

	test("falls back to per-line ctx.ui.notify when setWidget is missing", () => {
		const emit = createTransientPanel({ widgetKey: "test-panel" });
		const { ctx, notifications, widgetCalls } = makeCtx({
			withSetWidget: false,
		});
		emit(ctx, ["alpha", "beta"]);
		expect(widgetCalls).toHaveLength(0);
		expect(notifications).toEqual([
			{ message: "alpha", type: "info" },
			{ message: "beta", type: "info" },
		]);
	});

	test("custom render hook transforms each line", () => {
		const emit = createTransientPanel({
			widgetKey: "test-panel",
			ttlMs: 0,
			render: (lines) => lines.map((l) => `> ${l}`),
		});
		const { ctx, widgetCalls } = makeCtx();
		emit(ctx, ["a", "b"]);
		expect(widgetCalls[0].content).toEqual(["> a", "> b"]);
	});
});

describe("renderNoticeLine", () => {
	test("includes the message and ANSI escapes", () => {
		const out = renderNoticeLine("ready", "info");
		expect(out).toContain("ready");
		expect(out).toContain("\x1b[");
	});

	test("uses different color for warning vs info", () => {
		const info = renderNoticeLine("x", "info");
		const warn = renderNoticeLine("x", "warning");
		expect(info).not.toBe(warn);
	});
});

describe("startWorkingPanel", () => {
	test("emits an animated header on the configured widgetKey", async () => {
		const { ctx, widgetCalls } = makeCtx();
		const stop = startWorkingPanel(ctx, {
			widgetKey: "work",
			label: "assembly",
			phrases: ["thinking"],
			footer: ["scanning..."],
			frameIntervalMs: 10,
			phraseIntervalMs: 30,
		});
		// First tick happens synchronously; the emit lands on the widget surface.
		expect(widgetCalls.length).toBeGreaterThan(0);
		expect(widgetCalls[0].key).toBe("work");
		expect(widgetCalls[0].content?.[0]).toContain("assembly");
		expect(widgetCalls[0].content?.[0]).toContain("thinking");
		expect(widgetCalls[0].content?.[1]).toBe("scanning...");
		stop();
	});

	test("ticks repeatedly and rotates phrases over time", async () => {
		const { ctx, widgetCalls } = makeCtx();
		const stop = startWorkingPanel(ctx, {
			widgetKey: "work",
			label: "assembly",
			phrases: ["alpha", "beta"],
			frameIntervalMs: 5,
			phraseIntervalMs: 25,
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 80));
		} finally {
			stop();
		}
		// Many ticks happened.
		expect(widgetCalls.length).toBeGreaterThan(5);
		// At least one tick rendered each phrase.
		const headers = widgetCalls
			.filter((c) => c.content !== undefined)
			.map((c) => c.content?.[0] ?? "");
		expect(headers.some((h) => h.includes("alpha"))).toBe(true);
		expect(headers.some((h) => h.includes("beta"))).toBe(true);
	});

	test("stop clears the widget and is idempotent", async () => {
		const { ctx, widgetCalls } = makeCtx();
		const stop = startWorkingPanel(ctx, {
			widgetKey: "work",
			label: "assembly",
			phrases: ["x"],
			frameIntervalMs: 5,
		});
		// Let one or two ticks land.
		await new Promise((resolve) => setTimeout(resolve, 12));
		const beforeStop = widgetCalls.length;
		stop();
		stop(); // second stop must not throw, must not re-emit.
		const afterStop = widgetCalls.length;
		// The stop produced exactly one extra emit (undefined content) on top
		// of whatever ticks landed before stop.
		expect(afterStop).toBe(beforeStop + 1);
		expect(widgetCalls[afterStop - 1].content).toBeUndefined();
		// No further ticks after stop.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(widgetCalls.length).toBe(afterStop);
	});

	test("headless fallback emits initial phrase + footer via notify, returns no-op stop", () => {
		const { ctx, notifications, widgetCalls } = makeCtx({ hasUI: false });
		const stdout = mock(() => undefined);
		const original = console.log;
		console.log = stdout;
		try {
			const stop = startWorkingPanel(ctx, {
				widgetKey: "work",
				label: "assembly",
				phrases: ["thinking"],
				footer: ["scanning..."],
			});
			stop(); // must not throw
		} finally {
			console.log = original;
		}
		// No widget activity in headless mode.
		expect(widgetCalls).toHaveLength(0);
		// Header line + each footer line printed via shared notify (console.log).
		expect(stdout).toHaveBeenCalledTimes(2);
		expect(notifications).toHaveLength(0);
	});

	test("headless fallback when ui has no setWidget", () => {
		const { ctx, notifications, widgetCalls } = makeCtx({
			withSetWidget: false,
		});
		const stop = startWorkingPanel(ctx, {
			widgetKey: "work",
			label: "assembly",
			phrases: ["thinking"],
		});
		stop();
		expect(widgetCalls).toHaveLength(0);
		// hasUI=true but no setWidget → fall back to ui.notify rather than console.
		expect(notifications.length).toBeGreaterThanOrEqual(1);
		expect(notifications[0].message).toContain("assembly");
		expect(notifications[0].message).toContain("thinking");
	});

	test("custom render hook receives state and overrides default", () => {
		const { ctx, widgetCalls } = makeCtx();
		const seen: WorkingPanelState[] = [];
		const stop = startWorkingPanel(ctx, {
			widgetKey: "work",
			label: "assembly",
			phrases: ["go"],
			footer: ["context"],
			frameIntervalMs: 5,
			render: (state) => {
				seen.push(state);
				return [`>>> ${state.label}: ${state.phrase}`];
			},
		});
		stop();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0].label).toBe("assembly");
		expect(seen[0].phrase).toBe("go");
		expect(seen[0].footer).toEqual(["context"]);
		expect(typeof seen[0].elapsedMs).toBe("number");
		expect(seen[0].spinner.length).toBeGreaterThan(0);
		expect(widgetCalls[0].content).toEqual([">>> assembly: go"]);
	});

	test("throws when phrases is empty", () => {
		const { ctx } = makeCtx();
		expect(() =>
			startWorkingPanel(ctx, {
				widgetKey: "work",
				label: "assembly",
				phrases: [],
			}),
		).toThrow(/at least one phrase/);
	});
});
