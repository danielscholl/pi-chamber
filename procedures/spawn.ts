/**
 * Minimal child-Pi spawn helper for procedure prompt/command nodes.
 *
 * Adapted from `room/spawn.ts`. Kept narrow for procedures' needs:
 *   - one prompt per spawn (no streaming chat)
 *   - capture final assistant text and the session id
 *   - optional --resume for `context: 'shared'` sequential threading
 *   - optional --tools allowlist for `allowed_tools`
 *   - optional --append-system-prompt via temp file for `systemPrompt`
 *   - SIGTERM-then-SIGKILL on AbortSignal
 *
 * No fallback models, no per-mind sessions, no retry. Procedures are scripted;
 * if a step fails, the executor surfaces it and the run records `failed`.
 *
 * NDJSON parsing logic is duplicated rather than imported from `room/spawn.ts`
 * to keep `procedures/` independent of `room/` per the per-feature isolation
 * rule documented in AGENTS.md.
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

// ---------------------------------------------------------------------------
// NDJSON message shape (subset of pi-coding-agent's emitted events)
// ---------------------------------------------------------------------------

export type NdjsonEvent =
	| { type: "session"; sessionId?: string; [k: string]: unknown }
	| { type: "agent_start"; [k: string]: unknown }
	| { type: "turn_start"; [k: string]: unknown }
	| { type: "message_start"; [k: string]: unknown }
	| {
			type: "message_update";
			assistantMessageEvent?: {
				type?: string;
				delta?: string;
				text_delta?: string;
				[k: string]: unknown;
			};
			[k: string]: unknown;
	  }
	| { type: "message_end"; message?: AssistantMessage; [k: string]: unknown }
	| { type: "turn_end"; [k: string]: unknown }
	| { type: "agent_end"; [k: string]: unknown }
	| { type: string; [k: string]: unknown };

export interface AssistantMessage {
	role?: string;
	content?: Array<Record<string, unknown>>;
	stopReason?: string;
	errorMessage?: string;
}

export function parseNdjsonLine(line: string): NdjsonEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
			return parsed as NdjsonEvent;
		}
	} catch {
		/* non-JSON noise — ignore */
	}
	return null;
}

export function extractFinalText(messages: AssistantMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const parts: string[] = [];
		for (const part of msg.content) {
			const block = part as { type?: unknown; text?: unknown };
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
		if (parts.length > 0) return parts.join("");
	}
	return "";
}

export function extractDelta(event: NdjsonEvent): string | null {
	if (event.type !== "message_update") return null;
	const inner = (event as { assistantMessageEvent?: Record<string, unknown> }).assistantMessageEvent;
	if (!inner || typeof inner !== "object") return null;
	const innerType = (inner as { type?: unknown }).type;
	if (innerType !== "text_delta") return null;
	const delta =
		(inner as { delta?: unknown }).delta ?? (inner as { text_delta?: unknown }).text_delta;
	return typeof delta === "string" ? delta : null;
}

// ---------------------------------------------------------------------------
// Pi invocation discovery (mirrors room/spawn.ts:getPiInvocation)
// ---------------------------------------------------------------------------

/**
 * Pick the right command + arg-prefix for spawning a child pi process,
 * accounting for the case where the parent runs as a Bun-compiled binary or
 * via a generic `bun`/`node` runtime.
 */
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

// ---------------------------------------------------------------------------
// composeSpawnArgs — pure helper for argv composition (testable)
// ---------------------------------------------------------------------------

export interface ComposeSpawnArgsInput {
	model?: string;
	allowedTools?: string[];
	deniedTools?: string[];
	resumeSessionId?: string;
	systemPromptFile?: string;
	noChildExtensions?: boolean; // defaults true
}

export function composeSpawnArgs(input: ComposeSpawnArgsInput): string[] {
	const args: string[] = ["--mode", "json", "-p"];
	if (input.resumeSessionId) {
		args.push("--resume", input.resumeSessionId);
	} else {
		args.push("--no-session");
	}
	if (input.noChildExtensions !== false) args.push("--no-extensions");
	if (input.model) args.push("--model", input.model);
	if (input.allowedTools && input.allowedTools.length > 0) {
		args.push("--tools", input.allowedTools.join(","));
	}
	if (input.deniedTools && input.deniedTools.length > 0) {
		// pi CLI uses --disallowed-tools as the denylist flag (mirrors Claude SDK);
		// match Archon's bash composition on the same string-list shape.
		args.push("--disallowed-tools", input.deniedTools.join(","));
	}
	if (input.systemPromptFile) {
		args.push("--append-system-prompt", input.systemPromptFile);
	}
	return args;
}

// ---------------------------------------------------------------------------
// Persona / system-prompt temp file
// ---------------------------------------------------------------------------

export async function writeSystemPromptToTempFile(
	systemPrompt: string,
): Promise<{ dir: string; path: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-procedures-"));
	const filePath = path.join(tmpDir, "system-prompt.md");
	await fs.promises.writeFile(filePath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, path: filePath };
}

// ---------------------------------------------------------------------------
// spawnPiOnce — single-shot spawn used by prompt/command nodes
// ---------------------------------------------------------------------------

export interface SpawnPiOptions {
	prompt: string;
	cwd: string;
	model?: string;
	allowedTools?: string[];
	deniedTools?: string[];
	systemPrompt?: string;
	resumeSessionId?: string;
	/**
	 * Additional environment variables merged into `process.env` for the child
	 * pi process. Procedure handlers should pass `NodeExecuteInput.env` here so
	 * AI nodes that use tools (Bash, Write, etc.) inside the spawned pi see
	 * `$ARTIFACTS_DIR`, `$BASE_BRANCH`, `$1..$9`, `$ARGUMENTS`, and
	 * `$<upstreamId>` exactly like bash nodes do.
	 */
	env?: Record<string, string>;
	signal?: AbortSignal;
	killGraceMs?: number;
	onDelta?: (delta: string) => void;
	/** Override the spawn-args composer for tests. */
	composeSpawnArgsImpl?: typeof composeSpawnArgs;
	/** Override the pi-invocation discovery for tests. */
	getPiInvocationImpl?: typeof getPiInvocation;
}

export interface SpawnPiResult {
	exitCode: number;
	finalText: string;
	sessionId?: string;
	stderr: string;
	aborted: boolean;
	stopReason?: string;
	errorMessage?: string;
	durationMs: number;
}

/**
 * Run one pi invocation and capture the final assistant text. On abort, sends
 * SIGTERM and follows up with SIGKILL after `killGraceMs`. The returned
 * `aborted` flag distinguishes a cancelled run from a crashed one.
 */
export async function spawnPiOnce(options: SpawnPiOptions): Promise<SpawnPiResult> {
	const start = Date.now();
	const composeFn = options.composeSpawnArgsImpl ?? composeSpawnArgs;
	const pickInvocationFn = options.getPiInvocationImpl ?? getPiInvocation;

	let systemPromptDir: string | undefined;
	let systemPromptFile: string | undefined;
	if (options.systemPrompt) {
		const written = await writeSystemPromptToTempFile(options.systemPrompt);
		systemPromptDir = written.dir;
		systemPromptFile = written.path;
	}

	const flagArgs = composeFn({
		model: options.model,
		allowedTools: options.allowedTools,
		deniedTools: options.deniedTools,
		resumeSessionId: options.resumeSessionId,
		systemPromptFile,
	});
	const finalArgs = [...flagArgs, options.prompt];
	const { command, args } = pickInvocationFn(finalArgs);

	const child = spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...(options.env ?? {}) },
		stdio: ["ignore", "pipe", "pipe"],
	}) as ReturnType<typeof spawn>;

	let aborted = false;
	let stderrBuffer = "";
	const messages: AssistantMessage[] = [];
	let sessionId: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	const onAbort = () => {
		aborted = true;
		try {
			child.kill("SIGTERM");
		} catch {
			/* already dead */
		}
		const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, grace).unref?.();
	};
	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	let stdoutBuffer = "";
	const stdout = (child as { stdout?: { on: (event: string, fn: (chunk: Buffer) => void) => void } }).stdout;
	if (stdout) {
		stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf-8");
			let newlineIdx: number;
			while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
				const line = stdoutBuffer.slice(0, newlineIdx);
				stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
				const event = parseNdjsonLine(line);
				if (!event) continue;
				if (event.type === "session" && typeof (event as { sessionId?: unknown }).sessionId === "string") {
					sessionId = (event as { sessionId: string }).sessionId;
				}
				if (event.type === "message_update" && options.onDelta) {
					const delta = extractDelta(event);
					if (delta) options.onDelta(delta);
				}
				if (event.type === "message_end") {
					const msg = (event as { message?: AssistantMessage }).message;
					if (msg) {
						messages.push(msg);
						if (typeof msg.stopReason === "string") stopReason = msg.stopReason;
						if (typeof msg.errorMessage === "string") errorMessage = msg.errorMessage;
					}
				}
			}
		});
	}
	const stderr = (child as { stderr?: { on: (event: string, fn: (chunk: Buffer) => void) => void } }).stderr;
	if (stderr) {
		stderr.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString("utf-8");
		});
	}

	const exitCode = await new Promise<number>((resolve) => {
		(child as { on: (event: string, fn: (code: number | null) => void) => void }).on(
			"exit",
			(code) => resolve(code ?? 0),
		);
	});

	if (options.signal) {
		options.signal.removeEventListener?.("abort", onAbort);
	}
	if (systemPromptDir) {
		fs.promises.rm(systemPromptDir, { recursive: true, force: true }).catch(() => {});
	}

	return {
		exitCode,
		finalText: extractFinalText(messages),
		sessionId,
		stderr: stderrBuffer,
		aborted,
		stopReason,
		errorMessage,
		durationMs: Date.now() - start,
	};
}
