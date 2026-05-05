// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import * as fs from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import os from "node:os";
// biome-ignore lint/suspicious/noTsIgnore: Bun tests run with Node built-ins available.
// @ts-ignore
import path from "node:path";
import { createMindStructure, resolveGenesisPaths } from "../genesis/core.ts";
import {
	buildMindModeSystemPrompt,
	listGenesisMinds,
	loadMindConfig,
	loadMindContext,
	MIND_CONFIG_FILE,
	normalizeMindSlug,
	validateMindModeFiles,
} from "./core.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mind-core-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeCompleteMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	createMindStructure(paths);
	fs.writeFileSync(paths.soulPath, `# Soul\n\nIdentity for ${slug}.\n`);
	fs.writeFileSync(
		paths.mindIndexPath,
		"# Mind Index\n\n- SOUL.md: identity.\n",
	);
	fs.writeFileSync(
		paths.agentPath,
		"# Operating Doctrine\n\nUse Capture and Ingest. Author lenses with care.\n",
	);
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nDurable context.\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- Be precise.\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- Created for test.\n");
	return paths;
}

describe("normalizeMindSlug", () => {
	test("keeps existing slug strings and slugifies display names", () => {
		expect(normalizeMindSlug("miss-moneypenny")).toBe("miss-moneypenny");
		expect(normalizeMindSlug("  ariadne-2  ")).toBe("ariadne-2");
		expect(normalizeMindSlug("Miss Moneypenny")).toBe("miss-moneypenny");
	});

	test("rejects empty or punctuation-only values", () => {
		expect(() => normalizeMindSlug("!!!")).toThrow(/ASCII letter or number/);
		expect(() => normalizeMindSlug("   ")).toThrow(/ASCII letter or number/);
	});

	test("rejects /mind subcommand keywords as slugs", () => {
		for (const reserved of ["help", "list", "create", "new"]) {
			expect(() => normalizeMindSlug(reserved)).toThrow(/reserved/);
			expect(() => normalizeMindSlug(reserved.toUpperCase())).toThrow(
				/reserved/,
			);
		}
		// Non-reserved slugs that share a prefix still pass through.
		expect(normalizeMindSlug("listener")).toBe("listener");
		expect(normalizeMindSlug("creative")).toBe("creative");
		// `off` is intentionally NOT reserved; it falls through to the standard
		// "mind not ready" error path when no such mind exists.
		expect(normalizeMindSlug("off")).toBe("off");
	});
});

describe("listGenesisMinds", () => {
	test("returns complete mind slugs and ignores incomplete directories", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "complete");
			const incomplete = resolveGenesisPaths(cwd, "incomplete");
			createMindStructure(incomplete);
			fs.writeFileSync(incomplete.soulPath, "# Soul\n");

			expect(listGenesisMinds(cwd)).toEqual(["complete"]);
		});
	});
});

describe("validateMindModeFiles", () => {
	test("requires all direct-chat mind files but not the subagent shim", () => {
		withTempProject((cwd) => {
			const paths = writeCompleteMind(cwd, "ariadne");
			expect(fs.existsSync(paths.shimPath)).toBe(false);
			expect(validateMindModeFiles(paths)).toEqual({
				ok: true,
				errors: [],
				missing: [],
				invalid: [],
			});
		});
	});

	test("reports missing and empty required files with useful errors", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "broken");
			createMindStructure(paths);
			fs.writeFileSync(paths.soulPath, "# Soul\n");
			fs.writeFileSync(paths.mindIndexPath, "   \n");
			fs.writeFileSync(paths.memoryPath, "# Memory\n");
			fs.writeFileSync(paths.rulesPath, "# Rules\n");
			fs.rmSync(paths.logPath);

			const result = validateMindModeFiles(paths);
			expect(result.ok).toBe(false);
			expect(result.invalid).toContain(paths.mindIndexPath);
			expect(result.missing).toContain(paths.logPath);
			expect(result.errors.join("\n")).toContain("Empty file");
			expect(result.errors.join("\n")).toContain("Missing file");
		});
	});
});

describe("loadMindContext", () => {
	test("reads required mind files including operating doctrine", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");

			const context = loadMindContext(cwd, "miss-moneypenny");

			expect(context.slug).toBe("miss-moneypenny");
			expect(context.paths.mindPath).toBe(".pi/minds/miss-moneypenny");
			expect(context.paths.agentPath).toBe(
				".pi/minds/miss-moneypenny/AGENT.md",
			);
			expect(context.paths.soulPath).toBe(".pi/minds/miss-moneypenny/SOUL.md");
			expect(context.paths.memoryPath).toBe(
				".pi/minds/miss-moneypenny/.working-memory/memory.md",
			);
			expect(context.agentDoctrine).toContain("Use Capture and Ingest");
			expect(context.agentDoctrine).toContain("Author lenses with care");
			expect(context.soul).toContain("Identity for miss-moneypenny");
			expect(context.mindIndex).toContain("SOUL.md");
			expect(context.memory).toContain("Durable context");
			expect(context.rules).toContain("Be precise");
			expect(context.log).toContain("Created for test");
		});
	});

	test("truncates long logs from the front and keeps the tail", () => {
		withTempProject((cwd) => {
			const paths = writeCompleteMind(cwd, "logger");
			fs.writeFileSync(paths.logPath, "start-" + "x".repeat(30) + "-end");

			const context = loadMindContext(cwd, "logger", { logMaxChars: 8 });

			expect(context.logTruncated).toBe(true);
			expect(context.log).toContain(
				"earlier chronological log entries omitted",
			);
			expect(context.log).toContain("xxxx-end");
			expect(context.log).not.toContain("start-");
		});
	});

	test("throws clear validation errors for incomplete minds", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "incomplete");
			createMindStructure(paths);
			expect(() => loadMindContext(cwd, "incomplete")).toThrow(
				/Genesis mind "incomplete" is not ready for \/mind/,
			);
		});
	});
});

describe("loadMindConfig", () => {
	function writeMindConfig(cwd: string, slug: string, body: unknown): void {
		const paths = resolveGenesisPaths(cwd, slug);
		fs.mkdirSync(paths.mindPath, { recursive: true });
		fs.writeFileSync(
			path.join(paths.mindPath, MIND_CONFIG_FILE),
			typeof body === "string" ? body : JSON.stringify(body),
			"utf-8",
		);
	}

	test("returns parsed config when present and well-formed", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeMindConfig(cwd, "ariadne", {
				tools: ["read", "grep"],
				model: "openai/gpt-4o",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			});
			expect(loadMindConfig(cwd, "ariadne")).toEqual({
				tools: ["read", "grep"],
				model: "openai/gpt-4o",
				fallbackModels: ["anthropic/claude-sonnet-4"],
			});
		});
	});

	test("returns undefined when the file is missing", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			expect(loadMindConfig(cwd, "ariadne")).toBeUndefined();
		});
	});

	test("returns undefined when the JSON is malformed", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeMindConfig(cwd, "ariadne", "{not json");
			expect(loadMindConfig(cwd, "ariadne")).toBeUndefined();
		});
	});

	test("drops malformed individual fields silently", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeMindConfig(cwd, "ariadne", {
				tools: "read,grep",
				model: 42,
				fallbackModels: ["", "valid"],
			});
			expect(loadMindConfig(cwd, "ariadne")).toEqual({
				fallbackModels: ["valid"],
			});
		});
	});

	test("drops empty tools entries and dedupes", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeMindConfig(cwd, "ariadne", {
				tools: ["read", "", "read", "bad name", "mcp:chrome"],
			});
			expect(loadMindConfig(cwd, "ariadne")).toEqual({
				tools: ["read", "mcp:chrome"],
			});
		});
	});

	test("returns undefined when no field survives validation", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeMindConfig(cwd, "ariadne", {
				tools: [],
				model: "",
				fallbackModels: [""],
			});
			expect(loadMindConfig(cwd, "ariadne")).toBeUndefined();
		});
	});
});

describe("buildMindModeSystemPrompt", () => {
	test("includes required sections and direct-chat instructions", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const prompt = buildMindModeSystemPrompt(
				loadMindContext(cwd, "miss-moneypenny"),
			);

			expect(prompt).toContain("# Active Genesis Mind — miss-moneypenny");
			expect(prompt).toContain("## Operating Doctrine — AGENT.md");
			expect(prompt).toContain("Use Capture and Ingest");
			expect(prompt).toContain("Author lenses with care");
			expect(prompt).toContain("## Identity — SOUL.md");
			expect(prompt).toContain("## Mind Index");
			expect(prompt).toContain("## Durable Memory");
			expect(prompt).toContain("## Operating Rules");
			expect(prompt).toContain("## Recent Chronological Log");
			expect(prompt).toContain("not a delegated subagent task");
			expect(prompt).toContain("genesis_write_files exactly once");
		});
	});
});
