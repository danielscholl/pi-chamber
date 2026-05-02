/**
 * room-spawn — pure spawn helper for Genesis minds in chamber rooms.
 *
 * Each speaking turn spawns a child `pi --mode json -p --no-session` process
 * with the mind's persona attached via --append-system-prompt. The child
 * emits NDJSON events on stdout; we stream text deltas to onDelta and capture
 * full messages on message_end.
 *
 * Adapted from @mariozechner/pi-coding-agent/examples/extensions/subagent.
 */

// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import { spawn } from "node:child_process";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import * as path from "node:path";
// biome-ignore lint/suspicious/noTsIgnore: Bun bundles Node built-ins at runtime.
// @ts-ignore
import process from "node:process";

export const DEFAULT_KILL_GRACE_MS = 5000;

export type MindUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

export type MindMessage = {
	role: "assistant" | "user" | "tool";
	content: Array<Record<string, unknown>>;
	model?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	stopReason?: string;
	errorMessage?: string;
};

export type NdjsonEvent =
	| { type: "session"; [key: string]: unknown }
	| { type: "agent_start"; [key: string]: unknown }
	| { type: "turn_start"; [key: string]: unknown }
	| { type: "message_start"; [key: string]: unknown }
	| {
			type: "message_update";
			assistantMessageEvent?: {
				type?: string;
				delta?: string;
				text_delta?: string;
				[key: string]: unknown;
			};
			[key: string]: unknown;
	  }
	| { type: "message_end"; message?: MindMessage; [key: string]: unknown }
	| { type: "tool_result_end"; message?: MindMessage; [key: string]: unknown }
	| { type: "turn_end"; [key: string]: unknown }
	| { type: "agent_end"; [key: string]: unknown }
	| { type: string; [key: string]: unknown };

export type SpawnMindResult = {
	exitCode: number;
	finalText: string;
	messages: MindMessage[];
	usage: MindUsage;
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	aborted: boolean;
	durationMs: number;
};

export type SpawnDeltaCallback = (delta: string) => void;
export type SpawnMessageCallback = (message: MindMessage) => void;
export type SpawnEventCallback = (event: NdjsonEvent) => void;

export type SpawnMindOptions = {
	/** Mind slug (used for temp-file naming and result tracking). */
	slug: string;
	/** Persona text to write to a temp file and pass via --append-system-prompt. */
	persona: string;
	/** Task prompt passed as the final positional argument to pi. */
	prompt: string;
	/** Working directory for the child process. */
	cwd: string;
	/** Optional model override (e.g., "github-copilot/gpt-5.5"). */
	model?: string;
	/** Optional comma-separated tools list. */
	tools?: string[];
	/** Abort signal — sends SIGTERM, then SIGKILL after killGraceMs. */
	signal?: AbortSignal;
	/** Token-level streaming callback. */
	onDelta?: SpawnDeltaCallback;
	/** Fired when the child emits message_end for an assistant message. */
	onMessage?: SpawnMessageCallback;
	/** Fired for every parsed NDJSON event (escape hatch for callers that need it). */
	onEvent?: SpawnEventCallback;
	/** Pass --no-extensions to skip child stack init. Defaults to true. */
	noChildExtensions?: boolean;
	/** Time before SIGKILL after SIGTERM. Defaults to DEFAULT_KILL_GRACE_MS. */
	killGraceMs?: number;
};

export function parseNdjsonLine(line: string): NdjsonEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
			return parsed as NdjsonEvent;
		}
		return null;
	} catch {
		return null;
	}
}

export function extractFinalText(messages: MindMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const parts = msg.content;
		const textParts: string[] = [];
		for (const part of parts) {
			const block = part as { type?: unknown; text?: unknown };
			if (block.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			}
		}
		if (textParts.length > 0) return textParts.join("");
	}
	return "";
}

export function extractDelta(event: NdjsonEvent): string | null {
	if (event.type !== "message_update") return null;
	const inner = (event as { assistantMessageEvent?: Record<string, unknown> })
		.assistantMessageEvent;
	if (!inner || typeof inner !== "object") return null;
	const innerType = (inner as { type?: unknown }).type;
	if (innerType !== "text_delta") return null;
	const delta =
		(inner as { delta?: unknown }).delta ??
		(inner as { text_delta?: unknown }).text_delta;
	return typeof delta === "string" ? delta : null;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function writePersonaToTempFile(
	slug: string,
	persona: string,
): Promise<{ dir: string; path: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-room-"),
	);
	const safeName = slug.replace(/[^\w.-]+/g, "_") || "mind";
	const filePath = path.join(tmpDir, `persona-${safeName}.md`);
	await fs.promises.writeFile(filePath, persona, {
		encoding: "utf-8",
		mode: 0o600,
	});
	return { dir: tmpDir, path: filePath };
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
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

export async function spawnMind(
	options: SpawnMindOptions,
): Promise<SpawnMindResult> {
	const startedAt = Date.now();
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (options.noChildExtensions !== false) args.push("--no-extensions");
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0)
		args.push("--tools", options.tools.join(","));

	let tmpPersonaDir: string | null = null;
	let tmpPersonaPath: string | null = null;
	let stderr = "";
	let aborted = false;
	const messages: MindMessage[] = [];
	const usage: MindUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
	let model: string | undefined = options.model;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	try {
		if (options.persona.trim()) {
			const tmp = await writePersonaToTempFile(options.slug, options.persona);
			tmpPersonaDir = tmp.dir;
			tmpPersonaPath = tmp.path;
			args.push("--append-system-prompt", tmpPersonaPath);
		}
		args.push(options.prompt);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				const event = parseNdjsonLine(line);
				if (!event) return;

				if (options.onEvent) {
					try {
						options.onEvent(event);
					} catch {
						/* swallow */
					}
				}

				if (event.type === "message_update" && options.onDelta) {
					const delta = extractDelta(event);
					if (delta) {
						try {
							options.onDelta(delta);
						} catch {
							/* swallow */
						}
					}
				}

				if (event.type === "message_end") {
					const msg = (event as { message?: MindMessage }).message;
					if (msg) {
						messages.push(msg);
						if (msg.role === "assistant") {
							usage.turns += 1;
							const u = msg.usage;
							if (u) {
								usage.input += u.input ?? 0;
								usage.output += u.output ?? 0;
								usage.cacheRead += u.cacheRead ?? 0;
								usage.cacheWrite += u.cacheWrite ?? 0;
								usage.cost += u.cost?.total ?? 0;
								usage.contextTokens = u.totalTokens ?? usage.contextTokens;
							}
							if (!model && msg.model) model = msg.model;
							if (msg.stopReason) stopReason = msg.stopReason;
							if (msg.errorMessage) errorMessage = msg.errorMessage;
						}
						if (options.onMessage) {
							try {
								options.onMessage(msg);
							} catch {
								/* swallow */
							}
						}
					}
				}

				if (event.type === "tool_result_end") {
					const msg = (event as { message?: MindMessage }).message;
					if (msg) {
						messages.push(msg);
						if (options.onMessage) {
							try {
								options.onMessage(msg);
							} catch {
								/* swallow */
							}
						}
					}
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
				else
					options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		const finalText = extractFinalText(messages);
		return {
			exitCode,
			finalText,
			messages,
			usage,
			stderr,
			model,
			stopReason,
			errorMessage,
			aborted,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (tmpPersonaPath) {
			try {
				fs.unlinkSync(tmpPersonaPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPersonaDir) {
			try {
				fs.rmdirSync(tmpPersonaDir);
			} catch {
				/* ignore */
			}
		}
	}
}
