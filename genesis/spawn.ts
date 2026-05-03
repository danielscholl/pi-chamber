/**
 * genesis-spawn — minimal child-Pi spawn helper for Genesis authoring.
 *
 * Runs the authoring prompt in a separate `pi --mode json -p --no-session
 * --no-extensions` process so the parent session never sees the streaming
 * authoring content. The child emits NDJSON; we collect the final assistant
 * message text and return it for downstream JSON parsing.
 *
 * Adapted from room/spawn.ts; kept narrow because Genesis only needs the
 * final assistant text, not per-token streaming.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { spawn } from "node:child_process";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import process from "node:process";

export const DEFAULT_KILL_GRACE_MS = 5000;

export type SpawnGenesisOptions = {
	/** Mind slug (used for diagnostics only). */
	slug: string;
	/** Authoring prompt; passed as the final positional arg to pi. */
	prompt: string;
	/** Working directory for the child process. */
	cwd: string;
	/** Optional abort signal. Sends SIGTERM, then SIGKILL after killGraceMs. */
	signal?: AbortSignal;
	/** Time before SIGKILL after SIGTERM. */
	killGraceMs?: number;
};

export type SpawnGenesisResult = {
	exitCode: number;
	finalText: string;
	stderr: string;
	aborted: boolean;
	durationMs: number;
};

export type SpawnGenesisFn = (
	options: SpawnGenesisOptions,
) => Promise<SpawnGenesisResult>;

type Message = {
	role?: unknown;
	content?: unknown;
};

type NdjsonEvent = {
	type?: unknown;
	message?: Message;
};

function parseLine(line: string): NdjsonEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object") return parsed as NdjsonEvent;
	} catch {
		/* ignore non-JSON lines */
	}
	return null;
}

function extractAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		const parts: string[] = [];
		for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) return parts.join("");
	}
	return "";
}

export function getPiInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		typeof currentScript === "string" &&
		currentScript.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function spawnGenesisAuthoring(
	options: SpawnGenesisOptions,
): Promise<SpawnGenesisResult> {
	const startedAt = Date.now();
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		options.prompt,
	];

	const messages: Message[] = [];
	let stderr = "";
	let aborted = false;
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	const exitCode = await new Promise<number>((resolve) => {
		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";

		const processLine = (line: string) => {
			const event = parseLine(line);
			if (!event) return;
			if (
				(event.type === "message_end" || event.type === "tool_result_end") &&
				event.message
			) {
				messages.push(event.message);
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer);
			resolve(code ?? 0);
		});

		proc.on("error", () => {
			resolve(1);
		});

		if (options.signal) {
			const killProc = () => {
				aborted = true;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					try {
						if (!proc.killed) proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, killGraceMs);
			};
			if (options.signal.aborted) killProc();
			else options.signal.addEventListener("abort", killProc, { once: true });
		}
	});

	return {
		exitCode,
		finalText: extractAssistantText(messages),
		stderr,
		aborted,
		durationMs: Date.now() - startedAt,
	};
}
