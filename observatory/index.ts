// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { spawn } from "node:child_process";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { readFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type ObservatoryConfig,
	DEFAULT_OBSERVATORY_CONFIG,
	discoverLenses,
	loadObservatoryConfig,
	resolveLensesRoot,
} from "./core.ts";
import {
	type ObservatoryServer,
	startObservatoryServer,
} from "./server.ts";

type ObservatoryCommandContext = {
	cwd: string;
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, value: string | undefined): void;
	};
};

type AutocompleteItem = {
	value: string;
	label: string;
	description?: string;
};

const STATUS_KEY = "observatory";

let server: ObservatoryServer | undefined;
let serverCwd: string | undefined;
let exitHooksInstalled = false;

const RENDERER_HTML = loadRendererHtml();

export default function (pi: ExtensionAPI) {
	installExitHooks();

	pi.registerCommand("observatory", {
		description:
			"Open a local observatory server that renders Genesis-mind-authored lenses.",
		getArgumentCompletions: (prefix: string) =>
			observatoryArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			const value = (args || "").trim().toLowerCase();
			const command: ObservatoryCommandContext = ctx as ObservatoryCommandContext;

			if (value === "help" || value === "?") {
				notify(command, observatoryHelpText(), "info");
				return;
			}
			if (value === "list") {
				showLensList(command);
				return;
			}
			if (value === "status") {
				showStatus(command);
				return;
			}
			if (value === "stop") {
				await stopObservatory(command);
				return;
			}
			if (value === "open") {
				await openObservatory(command);
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
			await startObservatory(command);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const command = ctx as unknown as ObservatoryCommandContext;
		if (server && serverCwd === command.cwd) {
			command.ui.setStatus(STATUS_KEY, statusValue());
		} else {
			command.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}

async function startObservatory(ctx: ObservatoryCommandContext): Promise<void> {
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

	if (server && serverCwd === ctx.cwd) {
		notify(
			ctx,
			`Observatory already running at ${server.url}. Use /observatory open to launch a browser, or /observatory stop to stop it.`,
			"info",
		);
		ctx.ui.setStatus(STATUS_KEY, statusValue());
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
		server = await startObservatoryServer({
			lensesRoot,
			port: config.port,
			hostname: config.host,
			rendererHtml: RENDERER_HTML,
		});
		serverCwd = ctx.cwd;
	} catch (error) {
		notify(
			ctx,
			`Observatory server failed to start: ${errorMessage(error)}`,
			"error",
		);
		return;
	}

	const portNote =
		server.port === config.port
			? ""
			: ` (configured port ${config.port} was busy)`;
	const lensesCount = countLenses(lensesRoot);
	const lensesNote =
		lensesCount.total === 0
			? "No lenses yet — ask a Genesis mind to author one. Try /observatory help for the lens shape."
			: `${lensesCount.ok} lens${lensesCount.ok === 1 ? "" : "es"}` +
				(lensesCount.invalid
					? `, ${lensesCount.invalid} invalid (visit the observatory for details).`
					: ".");
	notify(
		ctx,
		`Observatory running at ${server.url}${portNote}.\n${lensesNote}`,
		"info",
	);
	ctx.ui.setStatus(STATUS_KEY, statusValue());

	if (config.openOnStart) {
		await launchBrowser(ctx, server.url);
	}
}

async function openObservatory(ctx: ObservatoryCommandContext): Promise<void> {
	if (!server || serverCwd !== ctx.cwd) {
		await startObservatory(ctx);
	}
	if (!server) return;
	await launchBrowser(ctx, server.url);
}

async function stopObservatory(ctx: ObservatoryCommandContext): Promise<void> {
	if (!server) {
		notify(ctx, "Observatory is not running.", "info");
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const stoppedUrl = server.url;
	server.stop(true);
	server = undefined;
	serverCwd = undefined;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	notify(ctx, `Observatory stopped (${stoppedUrl}).`, "info");
}

function showStatus(ctx: ObservatoryCommandContext): void {
	if (!server) {
		notify(ctx, "Observatory is not running. Start with /observatory.", "info");
		return;
	}
	let lensesRoot: string;
	try {
		lensesRoot = resolveLensesRoot(ctx.cwd, loadObservatoryConfig(ctx.cwd));
	} catch (error) {
		notify(
			ctx,
			`Observatory running at ${server.url}, but lenses path is invalid: ${errorMessage(error)}`,
			"warning",
		);
		return;
	}
	const counts = countLenses(lensesRoot);
	notify(
		ctx,
		[
			`Observatory running at ${server.url}.`,
			`Lenses: ${counts.ok} ok, ${counts.invalid} invalid.`,
			`Lenses path: ${lensesRoot}`,
		].join("\n"),
		"info",
	);
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

async function launchBrowser(
	ctx: ObservatoryCommandContext,
	url: string,
): Promise<void> {
	const platform = process.platform;
	let command: string[];
	if (platform === "darwin") {
		command = ["open", url];
	} else if (platform === "win32") {
		command = ["cmd", "/c", "start", "", url];
	} else {
		command = ["xdg-open", url];
	}
	try {
		const proc = spawn(command[0], command.slice(1), {
			stdio: "ignore",
			detached: true,
		});
		// Detach: let the launcher exit independently of Pi.
		proc.unref?.();
		proc.on?.("error", () => {
			// Best-effort launch; ignore async failures (the user already saw the URL).
		});
		notify(ctx, `Opened ${url} in your browser.`, "info");
	} catch (error) {
		notify(
			ctx,
			`Could not launch browser (${errorMessage(error)}). Open ${url} manually.`,
			"warning",
		);
	}
}

function countLenses(lensesRoot: string): {
	total: number;
	ok: number;
	invalid: number;
} {
	try {
		const entries = discoverLenses(lensesRoot);
		let ok = 0;
		let invalid = 0;
		for (const entry of entries) {
			if (entry.status === "ok") ok++;
			else invalid++;
		}
		return { total: entries.length, ok, invalid };
	} catch {
		return { total: 0, ok: 0, invalid: 0 };
	}
}

function statusValue(): string | undefined {
	if (!server) return undefined;
	return `observatory :${server.port}`;
}

function observatoryHelpText(): string {
	return [
		"Usage: /observatory, /observatory open, /observatory stop, /observatory status, /observatory list, /observatory help.",
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
		"  data.json:",
		'    briefing     → flat object: { "active_minds": 3, "top_priority": "..." }',
		'    status-board → array of { name, status, ... }',
		"",
		'Ask a Genesis mind to author one, e.g.: /run moneypenny "Author a briefing lens at .pi/observatory/lenses/operations/."',
	].join("\n");
}

function observatoryArgumentCompletions(
	prefix: string,
): AutocompleteItem[] | null {
	const query = prefix.trimStart().toLowerCase();
	const items: AutocompleteItem[] = [
		{
			value: "open",
			label: "open",
			description: "Start the server (if needed) and open it in your browser.",
		},
		{
			value: "stop",
			label: "stop",
			description: "Stop the observatory server.",
		},
		{
			value: "status",
			label: "status",
			description: "Show observatory server state and lens counts.",
		},
		{
			value: "list",
			label: "list",
			description: "List discovered lenses (works without the server).",
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

function loadRendererHtml(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const rendererPath = path.join(here, "renderer.html");
	return readFileSync(rendererPath, "utf-8");
}

function installExitHooks(): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	process.on("exit", () => {
		try {
			server?.stop(true);
		} catch {
			// ignore
		}
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => {
			try {
				server?.stop(true);
			} catch {
				// ignore
			}
		});
	}
}

// Re-export for tests and downstream tools.
export { DEFAULT_OBSERVATORY_CONFIG, RENDERER_HTML };
