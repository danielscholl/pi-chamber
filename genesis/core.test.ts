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
import {
	collapseOneLine,
	createMindStructure,
	DEFAULT_GENESIS_CONFIG,
	ensureTrailingNewline,
	IDEA_FOLDERS,
	loadGenesisConfig,
	normalizeVoiceDescription,
	parseGenesisArgs,
	quoteYamlString,
	resolveGenesisPaths,
	seedSharedDoctrine,
	slugify,
	validateMind,
	WORKING_MEMORY_DIR,
} from "./core.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "genesis-core-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

describe("slugify", () => {
	test("normalizes names to short lowercase slugs", () => {
		expect(slugify("Ariadne Mind")).toBe("ariadne-mind");
		expect(slugify("Café ☕")).toBe("caf");
		expect(slugify("---Hello___World---")).toBe("hello---world");
		expect(slugify("a".repeat(45))).toBe("a".repeat(40));
		expect(slugify(`${"a".repeat(39)}!`)).toBe("a".repeat(39));
	});

	test("leaves empty or punctuation-only names as empty slugs", () => {
		expect(slugify("")).toBe("");
		expect(slugify("!!!")).toBe("");
	});
});

describe("parseGenesisArgs", () => {
	test("parses key-value arguments", () => {
		expect(
			parseGenesisArgs(
				'name="Ariadne" role="OSDU architecture scout" voice="calm systems thinker"',
			),
		).toEqual({
			name: "Ariadne",
			role: "OSDU architecture scout",
			voice: "calm systems thinker",
		});
	});

	test("parses positional name with flag arguments", () => {
		expect(
			parseGenesisArgs(
				'Ariadne --role "OSDU reviewer" --voice "precise, skeptical, constructive"',
			),
		).toEqual({
			name: "Ariadne",
			role: "OSDU reviewer",
			voice: "precise, skeptical, constructive",
		});
	});

	test("ignores unknown flags and their separate values", () => {
		expect(
			parseGenesisArgs('--foo bar --role reviewer name="Ariadne"'),
		).toEqual({
			name: "Ariadne",
			role: "reviewer",
		});
	});
});

describe("normalizeVoiceDescription", () => {
	test("wraps short persona-like values with the documented Chamber-style note", () => {
		expect(normalizeVoiceDescription("calm systems thinker")).toBe(
			'Character/voice: "calm systems thinker"',
		);
		expect(normalizeVoiceDescription("precise, skeptical, constructive")).toBe(
			'Character/voice: "precise, skeptical, constructive"',
		);
	});

	test("keeps detailed descriptions as direct text", () => {
		const detailed =
			"Speak in concise paragraphs. Be warm, practical, and careful under pressure.";
		expect(normalizeVoiceDescription(detailed)).toBe(detailed);
		expect(
			normalizeVoiceDescription(
				"clear practical technically sharp collaborative systems reviewer",
			),
		).toBe("clear practical technically sharp collaborative systems reviewer");
	});
});

describe("config and path helpers", () => {
	test("loads defaults, honors seedLensViews, and pins unwired booleans to false", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					genesis: {
						basePath: "./custom/minds",
						agentShimPath: "./custom/agents",
						defaultRole: "Reviewer",
						defaultVoice: "direct",
						commit: true,
						seedLensViews: false,
						bootstrapSkills: true,
					},
				}),
			);

			const config = loadGenesisConfig(cwd);
			expect(config).toEqual({
				...DEFAULT_GENESIS_CONFIG,
				basePath: "./custom/minds",
				agentShimPath: "./custom/agents",
				defaultRole: "Reviewer",
				defaultVoice: "direct",
				commit: false,
				seedLensViews: false,
				bootstrapSkills: false,
			});
		});
	});

	test("seedLensViews defaults to true when omitted from settings", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					genesis: { defaultRole: "Reviewer" },
				}),
			);

			const config = loadGenesisConfig(cwd);
			expect(config.seedLensViews).toBe(true);
		});
	});

	test("seedLensViews can be disabled via settings", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					genesis: { seedLensViews: false },
				}),
			);

			const config = loadGenesisConfig(cwd);
			expect(config.seedLensViews).toBe(false);
		});
	});

	test("reports malformed project settings with a clear Genesis error", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{not json");

			expect(() => loadGenesisConfig(cwd)).toThrow(
				/Failed to parse \.pi\/settings\.json for Genesis config/,
			);
		});
	});

	test("rejects absolute configured paths and attempts to escape cwd", () => {
		withTempProject((cwd) => {
			expect(() =>
				resolveGenesisPaths(cwd, "ariadne", {
					...DEFAULT_GENESIS_CONFIG,
					basePath: path.resolve(cwd, ".pi", "minds"),
				}),
			).toThrow(/basePath must be relative/);

			expect(() =>
				resolveGenesisPaths(cwd, "ariadne", {
					...DEFAULT_GENESIS_CONFIG,
					agentShimPath: path.resolve(cwd, ".pi", "agents"),
				}),
			).toThrow(/agentShimPath must be relative/);

			expect(() =>
				resolveGenesisPaths(cwd, "ariadne", {
					...DEFAULT_GENESIS_CONFIG,
					basePath: "../outside",
				}),
			).toThrow(/basePath escapes project root/);

			expect(() =>
				resolveGenesisPaths(cwd, "ariadne", {
					...DEFAULT_GENESIS_CONFIG,
					agentShimPath: "../agents",
				}),
			).toThrow(/agentShimPath escapes project root/);
		});
	});
});

describe("mind structure and validation", () => {
	test("creates required directories and empty working-memory placeholders", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			createMindStructure(paths);

			for (const folder of IDEA_FOLDERS) {
				expect(fs.existsSync(path.join(paths.mindPath, folder))).toBe(true);
			}
			expect(fs.existsSync(paths.sharedMindPath)).toBe(true);
			expect(paths.sharedIdeaPath).toBe(
				path.join(paths.basePath, "_shared", "IDEA.md"),
			);
			expect(paths.sharedObservatoryPath).toBe(
				path.join(paths.basePath, "_shared", "OBSERVATORY.md"),
			);
			expect(fs.existsSync(path.join(paths.mindPath, WORKING_MEMORY_DIR))).toBe(
				true,
			);
			expect(fs.existsSync(paths.memoryPath)).toBe(true);
			expect(fs.readFileSync(paths.memoryPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.rulesPath)).toBe(true);
			expect(fs.readFileSync(paths.rulesPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.logPath)).toBe(true);
			expect(fs.readFileSync(paths.logPath, "utf-8")).toBe("");
			expect(fs.existsSync(paths.soulPath)).toBe(false);
			expect(fs.existsSync(paths.mindIndexPath)).toBe(false);
			expect(fs.existsSync(paths.shimPath)).toBe(false);
		});
	});

	test("reports missing files, then passes after all required files and shim frontmatter exist", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			createMindStructure(paths);

			const initial = validateMind(paths);
			expect(initial.ok).toBe(false);
			expect(initial.missing).toContain(paths.soulPath);
			expect(initial.missing).toContain(paths.mindIndexPath);
			expect(initial.invalid).toContain(paths.memoryPath);
			expect(initial.invalid).toContain(paths.rulesPath);
			expect(initial.invalid).toContain(paths.logPath);
			expect(initial.missing).toContain(paths.shimPath);

			fs.writeFileSync(paths.soulPath, "# Soul\n");
			fs.writeFileSync(paths.mindIndexPath, "# Index\n");
			fs.writeFileSync(paths.memoryPath, "# Memory\n");
			fs.writeFileSync(paths.rulesPath, "# Rules\n");
			fs.writeFileSync(paths.logPath, "# Log\n");
			fs.writeFileSync(
				paths.shimPath,
				'---\nname: ariadne\ndescription: "OSDU architecture scout"\n---\n\nBody\n',
			);

			expect(validateMind(paths)).toEqual({
				ok: true,
				errors: [],
				missing: [],
				invalid: [],
			});
		});
	});
});

describe("seedSharedDoctrine", () => {
	test("writes IDEA.md and OBSERVATORY.md from bundled templates when missing", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			const seeded = seedSharedDoctrine(paths);
			expect(seeded).toContain(paths.sharedIdeaPath);
			expect(seeded).toContain(paths.sharedObservatoryPath);
			expect(fs.existsSync(paths.sharedIdeaPath)).toBe(true);
			expect(fs.existsSync(paths.sharedObservatoryPath)).toBe(true);
			expect(fs.readFileSync(paths.sharedIdeaPath, "utf-8")).toContain(
				"Shared IDEA Doctrine",
			);
			expect(fs.readFileSync(paths.sharedObservatoryPath, "utf-8")).toContain(
				"Shared Observatory Doctrine",
			);
		});
	});

	test("does not overwrite an existing IDEA.md", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			fs.mkdirSync(paths.sharedMindPath, { recursive: true });
			fs.writeFileSync(paths.sharedIdeaPath, "# Custom user IDEA\n");
			const seeded = seedSharedDoctrine(paths);
			expect(seeded).not.toContain(paths.sharedIdeaPath);
			expect(seeded).toContain(paths.sharedObservatoryPath);
			expect(fs.readFileSync(paths.sharedIdeaPath, "utf-8")).toBe(
				"# Custom user IDEA\n",
			);
		});
	});

	test("does not overwrite an existing OBSERVATORY.md", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			fs.mkdirSync(paths.sharedMindPath, { recursive: true });
			fs.writeFileSync(paths.sharedObservatoryPath, "# Custom Observatory\n");
			const seeded = seedSharedDoctrine(paths);
			expect(seeded).toContain(paths.sharedIdeaPath);
			expect(seeded).not.toContain(paths.sharedObservatoryPath);
			expect(fs.readFileSync(paths.sharedObservatoryPath, "utf-8")).toBe(
				"# Custom Observatory\n",
			);
		});
	});

	test("returns an empty array when both files already exist", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			fs.mkdirSync(paths.sharedMindPath, { recursive: true });
			fs.writeFileSync(paths.sharedIdeaPath, "# A\n");
			fs.writeFileSync(paths.sharedObservatoryPath, "# B\n");
			expect(seedSharedDoctrine(paths)).toEqual([]);
		});
	});

	test("creates the shared mind directory if it does not exist yet", () => {
		withTempProject((cwd) => {
			const paths = resolveGenesisPaths(cwd, "ariadne");
			// Note: NOT calling createMindStructure first.
			expect(fs.existsSync(paths.sharedMindPath)).toBe(false);
			seedSharedDoctrine(paths);
			expect(fs.existsSync(paths.sharedMindPath)).toBe(true);
			expect(fs.existsSync(paths.sharedIdeaPath)).toBe(true);
			expect(fs.existsSync(paths.sharedObservatoryPath)).toBe(true);
		});
	});
});

describe("string helpers", () => {
	test("normalizes generated text for safe frontmatter/content", () => {
		expect(ensureTrailingNewline("hello")).toBe("hello\n");
		expect(ensureTrailingNewline("hello\n")).toBe("hello\n");
		expect(collapseOneLine(" hello\n\tworld  ")).toBe("hello world");
		expect(quoteYamlString('say "hello"')).toBe('"say \\"hello\\""');
	});
});
