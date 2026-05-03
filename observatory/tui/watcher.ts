// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, watch, type FSWatcher } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import { LENS_MANIFEST_FILE } from "../core.ts";

export type WatcherChange = "discover" | "data";

export interface LensWatcher {
	stop(): void;
}

export interface LensWatcherOptions {
	debounceMs?: number;
	existencePollMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_POLL_MS = 2_000;

/**
 * Watch a lens root directory for manifest and data file changes.
 * Coalesces bursts of fs events into a single callback per debounce window.
 * If lensesRoot does not exist yet, polls for its creation and attaches when
 * it appears.
 */
export function startLensWatcher(
	lensesRoot: string,
	onChange: (kind: WatcherChange) => void,
	options: LensWatcherOptions = {},
): LensWatcher {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const pollMs = options.existencePollMs ?? DEFAULT_POLL_MS;

	let watcher: FSWatcher | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingKinds = new Set<WatcherChange>();
	let stopped = false;

	const flush = () => {
		debounceTimer = null;
		if (stopped) return;
		const kinds = pendingKinds;
		pendingKinds = new Set();
		// Manifest changes always force a re-discover; data-only changes are
		// emitted as "data" so the component can invalidate just that lens.
		if (kinds.has("discover")) onChange("discover");
		else if (kinds.has("data")) onChange("data");
	};

	const enqueue = (kind: WatcherChange) => {
		pendingKinds.add(kind);
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(flush, debounceMs);
	};

	const attach = () => {
		if (watcher || stopped) return;
		try {
			watcher = watch(lensesRoot, { recursive: true }, (_event, filename) => {
				if (!filename) {
					enqueue("discover");
					return;
				}
				const base = path.basename(String(filename));
				if (base === LENS_MANIFEST_FILE) {
					enqueue("discover");
					return;
				}
				const containsManifest = String(filename)
					.split(path.sep)
					.includes(LENS_MANIFEST_FILE);
				if (containsManifest) {
					enqueue("discover");
				} else if (path.dirname(String(filename)) === ".") {
					// Top-level dir add/remove: re-discover.
					enqueue("discover");
				} else {
					enqueue("data");
				}
			});
			watcher.on("error", () => {
				// Silently drop watcher errors; consumer can re-discover via 'r'.
			});
		} catch {
			watcher = null;
		}
	};

	if (existsSync(lensesRoot)) {
		attach();
	} else {
		pollTimer = setInterval(() => {
			if (stopped) return;
			if (existsSync(lensesRoot)) {
				if (pollTimer) clearInterval(pollTimer);
				pollTimer = null;
				enqueue("discover");
				attach();
			}
		}, pollMs);
	}

	return {
		stop() {
			stopped = true;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			if (watcher) {
				try {
					watcher.close();
				} catch {
					// ignore
				}
				watcher = null;
			}
		},
	};
}
