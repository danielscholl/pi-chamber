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
	loadMindContext,
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
		paths.sharedIdeaPath,
		"# Shared IDEA\n\nUse Capture and Ingest.\n",
	);
	fs.writeFileSync(
		paths.sharedObservatoryPath,
		"# Shared Observatory\n\nAuthor lenses with care.\n",
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
	test("reads required mind files and shared IDEA when present", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");

			const context = loadMindContext(cwd, "miss-moneypenny");

			expect(context.slug).toBe("miss-moneypenny");
			expect(context.paths.mindPath).toBe(".pi/minds/miss-moneypenny");
			expect(context.paths.sharedIdeaPath).toBe(".pi/minds/_shared/IDEA.md");
			expect(context.paths.sharedObservatoryPath).toBe(".pi/minds/_shared/OBSERVATORY.md");
			expect(context.paths.soulPath).toBe(".pi/minds/miss-moneypenny/SOUL.md");
			expect(context.paths.memoryPath).toBe(
				".pi/minds/miss-moneypenny/.working-memory/memory.md",
			);
			expect(context.sharedIdea).toContain("Use Capture and Ingest");
			expect(context.sharedObservatory).toContain("Author lenses with care");
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

describe("buildMindModeSystemPrompt", () => {
	test("includes required sections and direct-chat instructions", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "miss-moneypenny");
			const prompt = buildMindModeSystemPrompt(
				loadMindContext(cwd, "miss-moneypenny"),
			);

			expect(prompt).toContain("# Active Genesis Mind — miss-moneypenny");
			expect(prompt).toContain("## Shared IDEA Doctrine");
			expect(prompt).toContain("Use Capture and Ingest");
			expect(prompt).toContain("## Shared Observatory Doctrine");
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
