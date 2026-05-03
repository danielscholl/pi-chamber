import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listGenesisMinds } from "../mind/core.ts";
import {
	DEFAULT_OBSERVATORY_CONFIG,
	type ObservatoryConfig,
	type ScaffoldNewspaperResult,
	discoverLenses,
	loadObservatoryConfig,
	resolveLensesRoot,
	scaffoldNewspaper,
} from "./core.ts";
import { ObservatoryOverlay } from "./tui/component.ts";

type ObservatoryCommandContext = {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
		custom<T>(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

const STATUS_KEY = "observatory";
const LEGACY_NOTE =
	"/observatory no longer runs an HTTP server. Just /observatory opens the TUI.";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("observatory:newspaper", {
		description:
			"Scaffold a newspaper briefing lens for a Genesis mind (or all minds when no slug is given).",
		getArgumentCompletions: (prefix: string) =>
			newspaperArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			const command = ctx as ObservatoryCommandContext;
			await runNewspaperScaffold(args, command);
		},
	});

	pi.registerCommand("observatory", {
		description:
			"Open the local observatory TUI for Genesis-mind-authored lenses.",
		getArgumentCompletions: (prefix: string) =>
			observatoryArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			const value = (args || "").trim().toLowerCase();
			const command: ObservatoryCommandContext =
				ctx as ObservatoryCommandContext;

			if (value === "help" || value === "?") {
				notify(command, observatoryHelpText(), "info");
				return;
			}
			if (value === "list") {
				showLensList(command);
				return;
			}
			if (value === "status" || value === "stop" || value === "open") {
				notify(command, LEGACY_NOTE, "info");
				return;
			}
			if (value && value !== "start") {
				notify(
					command,
					`Unknown /observatory subcommand: ${value}. Try /observatory help.`,
					"warning",
				);
				return;
			}
			await openObservatory(command);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const command = ctx as unknown as ObservatoryCommandContext;
		// Defensive cleanup: clear any stale status set by a prior server-era session.
		command.ui.setStatus(STATUS_KEY, undefined);
	});
}

async function openObservatory(ctx: ObservatoryCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(
			ctx,
			"Observatory needs an interactive UI session.",
			"warning",
		);
		return;
	}
	let config: ObservatoryConfig;
	try {
		config = loadObservatoryConfig(ctx.cwd);
	} catch (error) {
		notify(
			ctx,
			`Observatory configuration could not be loaded: ${errorMessage(error)}`,
			"error",
		);
		return;
	}
	let lensesRoot: string;
	try {
		lensesRoot = resolveLensesRoot(ctx.cwd, config);
	} catch (error) {
		notify(
			ctx,
			`Observatory lenses path is invalid: ${errorMessage(error)}`,
			"error",
		);
		return;
	}

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new ObservatoryOverlay(
					tui as never,
					theme as never,
					ctx.cwd,
					lensesRoot,
					() => done(undefined as never),
				),
			{ overlay: false },
		);
	} catch (error) {
		notify(
			ctx,
			`Observatory overlay failed to open: ${errorMessage(error)}`,
			"error",
		);
	}
}

async function runNewspaperScaffold(
	rawArgs: string,
	ctx: ObservatoryCommandContext,
): Promise<void> {
	const requestedSlug = (rawArgs || "").trim();
	let lensesRoot: string;
	try {
		lensesRoot = resolveLensesRoot(ctx.cwd, loadObservatoryConfig(ctx.cwd));
	} catch (error) {
		notify(
			ctx,
			`Cannot resolve lenses root: ${errorMessage(error)}`,
			"error",
		);
		return;
	}

	let availableMinds: string[];
	try {
		availableMinds = listGenesisMinds(ctx.cwd);
	} catch (error) {
		notify(ctx, `Cannot list Genesis minds: ${errorMessage(error)}`, "error");
		return;
	}
	if (availableMinds.length === 0) {
		notify(
			ctx,
			"No Genesis minds found. Run /genesis to create one first.",
			"warning",
		);
		return;
	}

	let targets: string[];
	if (requestedSlug) {
		if (!availableMinds.includes(requestedSlug)) {
			notify(
				ctx,
				`Mind "${requestedSlug}" not found. Available: ${availableMinds.join(", ")}.`,
				"warning",
			);
			return;
		}
		targets = [requestedSlug];
	} else {
		targets = availableMinds;
	}

	const created: ScaffoldNewspaperResult[] = [];
	const skipped: ScaffoldNewspaperResult[] = [];
	const failed: Array<{ mindSlug: string; error: string }> = [];
	for (const mindSlug of targets) {
		try {
			const result = scaffoldNewspaper(lensesRoot, mindSlug);
			if (result.created) created.push(result);
			else skipped.push(result);
		} catch (error) {
			failed.push({ mindSlug, error: errorMessage(error) });
		}
	}

	const parts: string[] = [];
	if (created.length > 0) {
		parts.push(
			`Created ${created.length} newspaper${created.length === 1 ? "" : "s"}: ${created
				.map((r) => r.lensSlug)
				.join(", ")}.`,
		);
	}
	if (skipped.length > 0) {
		parts.push(
			`Skipped ${skipped.length} (already exist): ${skipped
				.map((r) => r.lensSlug)
				.join(", ")}.`,
		);
	}
	if (failed.length > 0) {
		parts.push(
			`Failed ${failed.length}: ${failed
				.map((f) => `${f.mindSlug} (${f.error})`)
				.join("; ")}.`,
		);
	}
	const message =
		parts.length > 0 ? parts.join(" ") : "No newspapers to scaffold.";
	notify(
		ctx,
		failed.length > 0 ? message : message,
		failed.length > 0 ? "error" : "info",
	);
}

function newspaperArgumentCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	let mindSlugs: string[];
	try {
		mindSlugs = listGenesisMinds(".");
	} catch {
		return null;
	}
	const items: AutocompleteItem[] = mindSlugs.map((slug) => ({
		value: slug,
		label: slug,
		description: `Scaffold newspaper for ${slug}`,
	}));
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function showLensList(ctx: ObservatoryCommandContext): void {
	let lensesRoot: string;
	try {
		lensesRoot = resolveLensesRoot(ctx.cwd, loadObservatoryConfig(ctx.cwd));
	} catch (error) {
		notify(ctx, `Cannot read observatory lenses: ${errorMessage(error)}`, "error");
		return;
	}
	let entries: ReturnType<typeof discoverLenses>;
	try {
		entries = discoverLenses(lensesRoot);
	} catch (error) {
		notify(ctx, `Cannot read observatory lenses: ${errorMessage(error)}`, "error");
		return;
	}
	if (!entries.length) {
		notify(
			ctx,
			`No observatory lenses in ${lensesRoot}. Ask a Genesis mind to author one (see /observatory help).`,
			"info",
		);
		return;
	}
	const lines = entries.map((entry) => {
		if (entry.status === "ok") {
			return `- ${entry.id} (${entry.manifest.kind}) — ${entry.manifest.name}`;
		}
		return `- ${entry.id} (invalid: ${entry.reason})`;
	});
	notify(ctx, `Observatory lenses in ${lensesRoot}:\n${lines.join("\n")}`, "info");
}

function observatoryHelpText(): string {
	return [
		"Usage: /observatory (open the TUI), /observatory list, /observatory:newspaper [<slug>], /observatory help.",
		"",
		"  /observatory:newspaper        scaffold a newspaper lens for every Genesis mind",
		"  /observatory:newspaper <slug> scaffold a newspaper lens for one mind",
		"",
		"Lenses live under .pi/observatory/lenses/<slug>/. Each lens needs two files:",
		"",
		"  lens.json:",
		"    {",
		'      "name": "Operations",',
		'      "kind": "briefing",          // or "status-board"',
		'      "source": "data.json",       // bare filename only',
		'      "icon": "activity",          // optional',
		'      "description": "..."         // optional',
		"    }",
		"",
		"  data.json (briefing):",
		"    sectioned   → { priority, metrics, activity, lists, narrative, details, summary, status }",
		'    flat        → { "active_minds": 3, ... } (legacy card grid)',
		"",
		"  data.json (status-board):",
		"    array       → [{ name, status, ... }, ...]",
		"",
		'Ask a Genesis mind to populate a scaffolded newspaper, e.g.: /run jarvis "Update your newspaper lens with current state."',
	].join("\n");
}

function observatoryArgumentCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = [
		{
			value: "list",
			label: "list",
			description: "List discovered lenses (text only — no TUI takeover).",
		},
		{
			value: "help",
			label: "help",
			description: "Show /observatory usage and the lens.json shape.",
		},
	];
	const filtered = items.filter((item) =>
		item.value.toLowerCase().startsWith(query),
	);
	return filtered.length ? filtered : null;
}

function notify(
	ctx: ObservatoryCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// Re-export for tests and downstream tools.
export { DEFAULT_OBSERVATORY_CONFIG };
