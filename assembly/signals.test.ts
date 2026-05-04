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
import { resolveGenesisPaths } from "../genesis/core.ts";
import { collectRepoSignals, DEFAULT_PER_FILE_BYTES } from "./signals.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "assembly-signals-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeMind(cwd: string, slug: string, soulFirstLine = "") {
	const paths = resolveGenesisPaths(cwd, slug);
	fs.mkdirSync(paths.mindPath, { recursive: true });
	for (const folder of paths.ideaFolders) fs.mkdirSync(folder, { recursive: true });
	fs.mkdirSync(paths.workingMemoryPath, { recursive: true });
	fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
	fs.writeFileSync(
		paths.soulPath,
		`${soulFirstLine || `# ${slug}`}\n\nIdentity body.\n`,
	);
	fs.writeFileSync(paths.mindIndexPath, "# Mind Index\n\n- SOUL.md\n");
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nDurable.\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- Be precise.\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- Created.\n");
	fs.writeFileSync(paths.shimPath, `---\nname: ${slug}\ndescription: "test"\n---\n\nbody\n`);
}

describe("collectRepoSignals", () => {
	test("returns empty signals when no project files exist", () => {
		withTempProject((cwd) => {
			const signals = collectRepoSignals(cwd);
			expect(signals.description).toBeUndefined();
			expect(signals.readme).toBeUndefined();
			expect(signals.agentsMd).toBeUndefined();
			expect(signals.claudeMd).toBeUndefined();
			expect(signals.manifest).toBeUndefined();
			expect(signals.topLevelDirs).toEqual([]);
			expect(signals.existingMinds).toEqual([]);
		});
	});

	test("captures user-provided description verbatim and trims it", () => {
		withTempProject((cwd) => {
			const signals = collectRepoSignals(cwd, {
				description: "  building a CLI for X  ",
			});
			expect(signals.description).toBe("building a CLI for X");
		});
	});

	test("reads README, AGENTS, CLAUDE files when present", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "# Project\n\nHello.\n");
			fs.writeFileSync(path.join(cwd, "AGENTS.md"), "agents contract\n");
			fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "claude notes\n");
			const signals = collectRepoSignals(cwd);
			expect(signals.readme?.content).toContain("# Project");
			expect(signals.readme?.truncated).toBe(false);
			expect(signals.agentsMd?.content).toBe("agents contract\n");
			expect(signals.claudeMd?.content).toBe("claude notes\n");
		});
	});

	test("truncates files larger than perFileBytes and marks them truncated", () => {
		withTempProject((cwd) => {
			const big = "x".repeat(DEFAULT_PER_FILE_BYTES * 2);
			fs.writeFileSync(path.join(cwd, "README.md"), big);
			const signals = collectRepoSignals(cwd, { perFileBytes: 128 });
			expect(signals.readme?.content.length).toBe(128);
			expect(signals.readme?.truncated).toBe(true);
		});
	});

	test("detects manifest in priority order (package.json wins over pyproject.toml)", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='x'\n");
			fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"x"}\n');
			const signals = collectRepoSignals(cwd);
			expect(signals.manifest?.kind).toBe("package.json");
			expect(signals.manifest?.content).toContain("\"name\":\"x\"");
		});
	});

	test("detects pyproject.toml when package.json is absent", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, "pyproject.toml"), "[project]\nname='x'\n");
			const signals = collectRepoSignals(cwd);
			expect(signals.manifest?.kind).toBe("pyproject.toml");
		});
	});

	test("detects go.mod, Cargo.toml, pom.xml, build.gradle in priority order", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, "build.gradle"), "// gradle\n");
			fs.writeFileSync(path.join(cwd, "Cargo.toml"), "[package]\n");
			fs.writeFileSync(path.join(cwd, "go.mod"), "module x\n");
			const signals = collectRepoSignals(cwd);
			expect(signals.manifest?.kind).toBe("go.mod");
		});
	});

	test("lists top-level directories and excludes hidden ones", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, "src"));
			fs.mkdirSync(path.join(cwd, "tests"));
			fs.mkdirSync(path.join(cwd, ".git"));
			fs.writeFileSync(path.join(cwd, "README.md"), "x");
			const signals = collectRepoSignals(cwd);
			expect(signals.topLevelDirs).toEqual(["src", "tests"]);
		});
	});

	test("enumerates existing complete minds and surfaces SOUL first line", () => {
		withTempProject((cwd) => {
			writeMind(cwd, "moneypenny", "# Miss Moneypenny");
			writeMind(cwd, "mycroft", "# Mycroft");
			const signals = collectRepoSignals(cwd);
			expect(signals.existingMinds.map((m) => m.slug)).toEqual([
				"moneypenny",
				"mycroft",
			]);
			expect(signals.existingMinds[0].soulFirstLine).toBe("# Miss Moneypenny");
		});
	});

	test("does not read .env files even if present", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, ".env"), "SECRET=value\n");
			fs.writeFileSync(path.join(cwd, ".env.local"), "TOKEN=value\n");
			const signals = collectRepoSignals(cwd);
			// Signals shape has no field for .env content; ensure it's not accidentally
			// surfaced via readme/agents/claude/manifest
			expect(signals.readme).toBeUndefined();
			expect(signals.agentsMd).toBeUndefined();
			expect(signals.claudeMd).toBeUndefined();
			expect(signals.manifest).toBeUndefined();
			// .env is hidden so it does not appear in topLevelDirs (it's a file anyway)
			expect(signals.topLevelDirs).toEqual([]);
		});
	});

	test("respects perFileBytes <= 0 by emitting empty truncated content", () => {
		withTempProject((cwd) => {
			fs.writeFileSync(path.join(cwd, "README.md"), "abc");
			const signals = collectRepoSignals(cwd, { perFileBytes: 0 });
			expect(signals.readme?.content).toBe("");
			expect(signals.readme?.truncated).toBe(true);
		});
	});
});
