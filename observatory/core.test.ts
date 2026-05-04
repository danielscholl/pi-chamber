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
	ALLOWED_LENS_KINDS,
	DEFAULT_OBSERVATORY_CONFIG,
	discoverLenses,
	lensesActivitySummary,
	loadObservatoryConfig,
	newspaperLensName,
	newspaperLensSlug,
	readLensData,
	removeNewspaperLens,
	removeTeamStatusBoard,
	resolveDataFilePath,
	resolveLensesRoot,
	scaffoldNewspaper,
	scaffoldTeamStatusBoard,
	teamLensManifest,
	teamLensName,
	teamLensSlug,
	validateSourceFilename,
	validateLensId,
	validateLensManifest,
} from "./core.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-core-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function makeLensesRoot(cwd: string): string {
	const root = path.join(cwd, ".pi", "observatory", "lenses");
	fs.mkdirSync(root, { recursive: true });
	return root;
}

function writeLens(
	lensesRoot: string,
	id: string,
	manifest: unknown,
	data?: unknown,
): void {
	const folder = path.join(lensesRoot, id);
	fs.mkdirSync(folder, { recursive: true });
	const manifestText =
		typeof manifest === "string" ? manifest : JSON.stringify(manifest);
	fs.writeFileSync(path.join(folder, "lens.json"), manifestText);
	if (data !== undefined) {
		const dataText = typeof data === "string" ? data : JSON.stringify(data);
		fs.writeFileSync(path.join(folder, "data.json"), dataText);
	}
}

describe("validateSourceFilename", () => {
	test("accepts simple bare filenames", () => {
		expect(validateSourceFilename("data.json").ok).toBe(true);
		expect(validateSourceFilename("status.json").ok).toBe(true);
		expect(validateSourceFilename("a.json").ok).toBe(true);
	});

	test("rejects path-like values", () => {
		expect(validateSourceFilename("../foo.json").ok).toBe(false);
		expect(validateSourceFilename("/etc/passwd").ok).toBe(false);
		expect(validateSourceFilename("subdir/x.json").ok).toBe(false);
		expect(validateSourceFilename("nested\\path.json").ok).toBe(false);
		expect(validateSourceFilename(".").ok).toBe(false);
		expect(validateSourceFilename("..").ok).toBe(false);
	});

	test("rejects empty and the manifest filename itself", () => {
		expect(validateSourceFilename("").ok).toBe(false);
		expect(validateSourceFilename("lens.json").ok).toBe(false);
	});
});

describe("validateLensId", () => {
	test("accepts canonical slugs", () => {
		expect(validateLensId("mind-status").ok).toBe(true);
		expect(validateLensId("health1").ok).toBe(true);
		expect(validateLensId("a").ok).toBe(true);
		expect(validateLensId("operations-2").ok).toBe(true);
	});

	test("rejects non-canonical ids", () => {
		expect(validateLensId("My View").ok).toBe(false);
		expect(validateLensId("-bad").ok).toBe(false);
		expect(validateLensId("bad-").ok).toBe(false);
		expect(validateLensId("").ok).toBe(false);
		expect(validateLensId("..").ok).toBe(false);
		expect(validateLensId("UPPER").ok).toBe(false);
	});
});

describe("validateLensManifest", () => {
	test("accepts a minimal valid manifest", () => {
		const result = validateLensManifest("ops", {
			name: "Operations",
			kind: "briefing",
			source: "data.json",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				id: "ops",
				name: "Operations",
				kind: "briefing",
				source: "data.json",
			});
		}
	});

	test("accepts optional icon and description", () => {
		const result = validateLensManifest("ops", {
			name: "Operations",
			kind: "status-board",
			source: "status.json",
			icon: "activity",
			description: "Workspace ops at a glance",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.icon).toBe("activity");
			expect(result.value.description).toBe("Workspace ops at a glance");
		}
	});

	test("silently drops unknown fields", () => {
		const result = validateLensManifest("ops", {
			name: "Operations",
			kind: "briefing",
			source: "data.json",
			prompt: "ignored in v1",
			refreshOn: "click",
			schema: { ignored: true },
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				id: "ops",
				name: "Operations",
				kind: "briefing",
				source: "data.json",
			});
		}
	});

	test("rejects missing required fields and unknown kinds", () => {
		expect(validateLensManifest("ops", null).ok).toBe(false);
		expect(
			validateLensManifest("ops", { kind: "briefing", source: "data.json" }).ok,
		).toBe(false);
		expect(
			validateLensManifest("ops", { name: "Ops", source: "data.json" }).ok,
		).toBe(false);
		expect(validateLensManifest("ops", { name: "Ops", kind: "briefing" }).ok).toBe(
			false,
		);
		expect(
			validateLensManifest("ops", {
				name: "Ops",
				kind: "table",
				source: "data.json",
			}).ok,
		).toBe(false);
		expect(
			validateLensManifest("ops", {
				name: "Ops",
				kind: "briefing",
				source: "../escape.json",
			}).ok,
		).toBe(false);
	});

	test("only the documented v1 lens kinds are allowed", () => {
		expect(ALLOWED_LENS_KINDS).toEqual(["briefing", "status-board"]);
	});
});

describe("discoverLenses", () => {
	test("returns an empty list when the lenses root does not exist", () => {
		withTempProject((cwd) => {
			const lensesRoot = path.join(cwd, ".pi", "observatory", "lenses");
			expect(discoverLenses(lensesRoot)).toEqual([]);
		});
	});

	test("classifies a mixed directory of valid and invalid lenses", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);

			// valid briefing
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				{ active_minds: 3 },
			);

			// valid status-board
			writeLens(
				lensesRoot,
				"health",
				{ name: "Health", kind: "status-board", source: "data.json" },
				[{ name: "extensions", status: "ok" }],
			);

			// invalid: bad slug folder name
			fs.mkdirSync(path.join(lensesRoot, "Bad Folder"), { recursive: true });
			fs.writeFileSync(
				path.join(lensesRoot, "Bad Folder", "lens.json"),
				JSON.stringify({
					name: "Bad",
					kind: "briefing",
					source: "data.json",
				}),
			);

			// invalid: malformed lens.json
			fs.mkdirSync(path.join(lensesRoot, "broken"), { recursive: true });
			fs.writeFileSync(
				path.join(lensesRoot, "broken", "lens.json"),
				"{ not json",
			);

			// invalid: missing lens.json entirely
			fs.mkdirSync(path.join(lensesRoot, "empty-lens"), { recursive: true });

			// hidden dotfile dir is skipped
			fs.mkdirSync(path.join(lensesRoot, ".hidden"), { recursive: true });

			const results = discoverLenses(lensesRoot);
			const ids = results.map((r) => r.id);
			expect(ids).toEqual(["Bad Folder", "broken", "empty-lens", "health", "operations"]);

			const operations = results.find((r) => r.id === "operations");
			expect(operations?.status).toBe("ok");
			if (operations?.status === "ok") {
				expect(operations.manifest.kind).toBe("briefing");
			}

			const badFolder = results.find((r) => r.id === "Bad Folder");
			expect(badFolder?.status).toBe("invalid");

			const broken = results.find((r) => r.id === "broken");
			expect(broken?.status).toBe("invalid");
			if (broken?.status === "invalid") {
				expect(broken.reason).toMatch(/not valid JSON/);
			}

			const empty = results.find((r) => r.id === "empty-lens");
			expect(empty?.status).toBe("invalid");
			if (empty?.status === "invalid") {
				expect(empty.reason).toMatch(/missing lens\.json/);
			}
		});
	});
});

describe("resolveDataFilePath", () => {
	test("resolves a clean source under the lens folder", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			writeLens(
				lensesRoot,
				"ops",
				{ name: "Ops", kind: "briefing", source: "data.json" },
				{ x: 1 },
			);
			const resolved = resolveDataFilePath(lensesRoot, "ops", "data.json");
			expect(resolved).toBe(path.join(lensesRoot, "ops", "data.json"));
		});
	});

	test("rejects bad ids and bad sources", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() => resolveDataFilePath(lensesRoot, "Bad", "data.json")).toThrow(
				/invalid lens id/,
			);
			expect(() => resolveDataFilePath(lensesRoot, "ops", "../escape")).toThrow(
				/invalid source/,
			);
			expect(() => resolveDataFilePath(lensesRoot, "ops", "lens.json")).toThrow(
				/invalid source/,
			);
		});
	});

	test("rejects symlinked data files inside the lens folder", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			writeLens(lensesRoot, "ops", {
				name: "Ops",
				kind: "briefing",
				source: "data.json",
			});
			const targetOutside = path.join(cwd, "outside.json");
			fs.writeFileSync(targetOutside, JSON.stringify({ leaked: true }));

			const symlinkPath = path.join(lensesRoot, "ops", "data.json");
			// lens.json was already written via writeLens with source "data.json";
			// no data.json was written, so we can drop a symlink at that name.
			fs.symlinkSync(targetOutside, symlinkPath);

			expect(() => resolveDataFilePath(lensesRoot, "ops", "data.json")).toThrow(
				/symbolic link/,
			);
		});
	});
});

describe("loadObservatoryConfig", () => {
	test("returns defaults when no settings file exists", () => {
		withTempProject((cwd) => {
			expect(loadObservatoryConfig(cwd)).toEqual(DEFAULT_OBSERVATORY_CONFIG);
		});
	});

	test("merges lensesPath when provided", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					observatory: {
						lensesPath: "./.pi/observatory/lenses",
					},
				}),
			);
			const config = loadObservatoryConfig(cwd);
			expect(config.lensesPath).toBe("./.pi/observatory/lenses");
		});
	});

	test("silently ignores legacy server fields (port, host, openOnStart)", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					observatory: {
						lensesPath: "./.pi/observatory/lenses",
						port: 9999,
						host: "0.0.0.0",
						openOnStart: true,
					},
				}),
			);
			const config = loadObservatoryConfig(cwd);
			expect(config).toEqual({ lensesPath: "./.pi/observatory/lenses" });
		});
	});

	test("rejects malformed settings.json", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), "{ not json");
			expect(() => loadObservatoryConfig(cwd)).toThrow(
				/Failed to parse \.pi\/settings\.json for Observatory config/,
			);
		});
	});
});

describe("resolveLensesRoot", () => {
	test("uses the configured lensesPath under the project root", () => {
		withTempProject((cwd) => {
			const root = resolveLensesRoot(cwd, DEFAULT_OBSERVATORY_CONFIG);
			expect(root).toBe(path.resolve(cwd, ".pi", "observatory", "lenses"));
		});
	});

	test("rejects absolute lensesPath", () => {
		withTempProject((cwd) => {
			expect(() =>
				resolveLensesRoot(cwd, {
					...DEFAULT_OBSERVATORY_CONFIG,
					lensesPath: path.resolve(cwd, ".pi", "observatory", "lenses"),
				}),
			).toThrow(/lensesPath must be relative/);
		});
	});

	test("rejects lensesPath that escapes the project root", () => {
		withTempProject((cwd) => {
			expect(() =>
				resolveLensesRoot(cwd, {
					...DEFAULT_OBSERVATORY_CONFIG,
					lensesPath: "../escape",
				}),
			).toThrow(/lensesPath escapes project root/);
		});
	});
});

describe("default constants", () => {
	test("defaults match the documented v1 contract", () => {
		expect(DEFAULT_OBSERVATORY_CONFIG).toEqual({
			lensesPath: "./.pi/observatory/lenses",
		});
	});
});

describe("readLensData", () => {
	test("returns parsed JSON for a well-formed data file", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			writeLens(
				lensesRoot,
				"ops",
				{ name: "Ops", kind: "briefing", source: "data.json" },
				{ active_minds: 3, top_priority: "Ship the TUI." },
			);
			const result = readLensData(lensesRoot, "ops", { source: "data.json" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data).toEqual({
					active_minds: 3,
					top_priority: "Ship the TUI.",
				});
			}
		});
	});

	test("reports a missing data file with a helpful reason", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			writeLens(lensesRoot, "ops", {
				name: "Ops",
				kind: "briefing",
				source: "data.json",
			});
			const result = readLensData(lensesRoot, "ops", { source: "data.json" });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toMatch(/data file is missing/);
			}
		});
	});

	test("reports invalid JSON", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			writeLens(
				lensesRoot,
				"ops",
				{ name: "Ops", kind: "briefing", source: "data.json" },
				"{ not json",
			);
			const result = readLensData(lensesRoot, "ops", { source: "data.json" });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toMatch(/not valid JSON/);
			}
		});
	});

	test("rejects bad ids and bad sources via path containment", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const badId = readLensData(lensesRoot, "Bad Id", { source: "data.json" });
			expect(badId.ok).toBe(false);
			const badSource = readLensData(lensesRoot, "ops", { source: "../escape" });
			expect(badSource.ok).toBe(false);
		});
	});
});

describe("newspaper helpers", () => {
	test("newspaperLensSlug appends -newspaper", () => {
		expect(newspaperLensSlug("jarvis")).toBe("jarvis-newspaper");
		expect(newspaperLensSlug("ariadne-mind")).toBe("ariadne-mind-newspaper");
	});

	test("newspaperLensName title-cases the slug", () => {
		expect(newspaperLensName("jarvis")).toBe("Jarvis Newspaper");
		expect(newspaperLensName("ariadne-mind")).toBe("Ariadne Mind Newspaper");
		expect(newspaperLensName("moneypenny")).toBe("Moneypenny Newspaper");
	});
});

describe("scaffoldNewspaper", () => {
	test("creates lens.json + data.json with sectioned shape when missing", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const result = scaffoldNewspaper(lensesRoot, "jarvis");
			expect(result.created).toBe(true);
			expect(result.lensSlug).toBe("jarvis-newspaper");
			expect(fs.existsSync(result.manifestPath)).toBe(true);
			expect(fs.existsSync(result.dataPath)).toBe(true);

			const manifest = JSON.parse(
				fs.readFileSync(result.manifestPath, "utf-8"),
			);
			expect(manifest.kind).toBe("briefing");
			expect(manifest.name).toBe("Jarvis Newspaper");
			expect(manifest.source).toBe("data.json");

			const data = JSON.parse(fs.readFileSync(result.dataPath, "utf-8"));
			expect(data.priority?.title).toBeDefined();
			expect(data.priority?.body).toContain("jarvis");
			expect(Array.isArray(data.activity)).toBe(true);
		});
	});

	test("the scaffolded data file passes sectioned-shape detection", async () => {
		withTempProject(async (cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const result = scaffoldNewspaper(lensesRoot, "moneypenny");
			const data = JSON.parse(fs.readFileSync(result.dataPath, "utf-8"));
			const { isSectionedShape } = await import("./page.ts");
			expect(isSectionedShape(data)).toBe(true);
		});
	});

	test("idempotent: returns created=false and does not overwrite", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			scaffoldNewspaper(lensesRoot, "jarvis");
			// Operator customizes the file
			const customManifest = JSON.stringify(
				{
					name: "Custom Name",
					kind: "briefing",
					source: "data.json",
				},
				null,
				2,
			);
			const folder = path.join(lensesRoot, "jarvis-newspaper");
			fs.writeFileSync(path.join(folder, "lens.json"), customManifest);
			// Re-run
			const result = scaffoldNewspaper(lensesRoot, "jarvis");
			expect(result.created).toBe(false);
			expect(result.reason).toMatch(/already exists/);
			// Custom content preserved
			const after = fs.readFileSync(path.join(folder, "lens.json"), "utf-8");
			expect(after).toBe(customManifest);
		});
	});

	test("each scaffolded lens passes discovery validation", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			scaffoldNewspaper(lensesRoot, "jarvis");
			scaffoldNewspaper(lensesRoot, "moneypenny");
			const entries = discoverLenses(lensesRoot);
			expect(entries.length).toBe(2);
			for (const e of entries) {
				expect(e.status).toBe("ok");
			}
		});
	});

	test("rejects mind slugs that would produce invalid lens ids", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() => scaffoldNewspaper(lensesRoot, "Bad Slug")).toThrow();
			expect(() => scaffoldNewspaper(lensesRoot, "")).toThrow();
		});
	});
});

describe("lensesActivitySummary", () => {
	test("returns null when the root does not exist", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lenses-activity-"));
		try {
			expect(lensesActivitySummary(path.join(tmp, "missing"))).toBeNull();
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("returns the most recently modified non-manifest file", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lenses-activity-"));
		try {
			const lensesRoot = path.join(tmp, "lenses");
			fs.mkdirSync(path.join(lensesRoot, "ops"), { recursive: true });
			fs.mkdirSync(path.join(lensesRoot, "room"), { recursive: true });
			fs.writeFileSync(path.join(lensesRoot, "ops", "lens.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "ops", "data.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "room", "lens.json"), "{}");
			fs.writeFileSync(path.join(lensesRoot, "room", "data.json"), "{}");

			const opsData = path.join(lensesRoot, "ops", "data.json");
			const roomData = path.join(lensesRoot, "room", "data.json");
			fs.utimesSync(opsData, new Date(2025, 0, 1), new Date(2025, 0, 1));
			fs.utimesSync(roomData, new Date(2026, 0, 1), new Date(2026, 0, 1));

			const summary = lensesActivitySummary(lensesRoot);
			expect(summary?.lensId).toBe("room");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("scaffoldTeamStatusBoard", () => {
	test("derives lens slug as <teamSlug>-team", () => {
		expect(teamLensSlug("alpha")).toBe("alpha-team");
		expect(teamLensName("alpha")).toBe("Alpha Team");
		expect(teamLensName("lens-team")).toBe("Lens Team Team");
	});

	test("manifest is a status-board with users icon and bare data.json source", () => {
		const manifest = teamLensManifest("alpha");
		expect(manifest.kind).toBe("status-board");
		expect(manifest.source).toBe("data.json");
		expect(manifest.icon).toBe("users");
		expect(manifest.name).toBe("Alpha Team");
		expect(manifest.description).toContain("alpha");
	});

	test("creates lens.json and data.json on first run", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const result = scaffoldTeamStatusBoard(lensesRoot, "alpha", [
				{ slug: "neil", role: "lead" },
				{ slug: "chris", role: "executor" },
			]);
			expect(result.created).toBe(true);
			expect(result.lensSlug).toBe("alpha-team");
			expect(fs.existsSync(result.manifestPath)).toBe(true);
			expect(fs.existsSync(result.dataPath)).toBe(true);

			const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
			expect(manifest.kind).toBe("status-board");
			expect(manifest.source).toBe("data.json");

			const data = JSON.parse(fs.readFileSync(result.dataPath, "utf-8"));
			expect(Array.isArray(data)).toBe(true);
			expect(data).toHaveLength(2);
			expect(data[0]).toEqual({ name: "neil", status: "ready", role: "lead" });
		});
	});

	test("idempotent on second run", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			scaffoldTeamStatusBoard(lensesRoot, "alpha", [
				{ slug: "neil", role: "lead" },
			]);
			const second = scaffoldTeamStatusBoard(lensesRoot, "alpha", [
				{ slug: "different", role: "writer" },
			]);
			expect(second.created).toBe(false);
			expect(second.reason).toContain("already exists");
			const data = JSON.parse(fs.readFileSync(second.dataPath, "utf-8"));
			expect(data[0].name).toBe("neil"); // not overwritten
		});
	});

	test("rejects invalid team slug", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() =>
				scaffoldTeamStatusBoard(lensesRoot, "Bad_Slug", []),
			).toThrow(/lens id/);
		});
	});

	test("rejects path-escaping team slug", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() =>
				scaffoldTeamStatusBoard(lensesRoot, "../escape", []),
			).toThrow();
		});
	});
});

describe("removeNewspaperLens", () => {
	test("removes the newspaper folder when present", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			scaffoldNewspaper(lensesRoot, "neil");
			const result = removeNewspaperLens(lensesRoot, "neil");
			expect(result.removed).toBe(true);
			expect(result.lensSlug).toBe("neil-newspaper");
			expect(fs.existsSync(path.join(lensesRoot, "neil-newspaper"))).toBe(false);
		});
	});

	test("idempotent: removed=false when folder missing", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const result = removeNewspaperLens(lensesRoot, "ghost");
			expect(result.removed).toBe(false);
		});
	});

	test("rejects bad mind slug", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() => removeNewspaperLens(lensesRoot, "Bad_Slug")).toThrow(/lens id/);
		});
	});
});

describe("removeTeamStatusBoard", () => {
	test("removes the team folder when present", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			scaffoldTeamStatusBoard(lensesRoot, "alpha", [
				{ slug: "neil", role: "lead" },
			]);
			const result = removeTeamStatusBoard(lensesRoot, "alpha");
			expect(result.removed).toBe(true);
			expect(result.lensSlug).toBe("alpha-team");
			expect(fs.existsSync(path.join(lensesRoot, "alpha-team"))).toBe(false);
		});
	});

	test("idempotent: removed=false when folder missing", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			const result = removeTeamStatusBoard(lensesRoot, "ghost-team");
			expect(result.removed).toBe(false);
		});
	});

	test("rejects path-escaping team slug", () => {
		withTempProject((cwd) => {
			const lensesRoot = makeLensesRoot(cwd);
			expect(() => removeTeamStatusBoard(lensesRoot, "../escape")).toThrow();
		});
	});
});
