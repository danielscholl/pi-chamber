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
	DEFAULT_OBSERVATORY_HOST,
	DEFAULT_OBSERVATORY_PORT,
	discoverLenses,
	loadObservatoryConfig,
	resolveDataFilePath,
	resolveLensesRoot,
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

	test("merges supported settings and ignores absent ones", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({
					observatory: {
						lensesPath: "./.pi/observatory/lenses",
						port: 9999,
						host: DEFAULT_OBSERVATORY_HOST,
						openOnStart: true,
					},
				}),
			);
			const config = loadObservatoryConfig(cwd);
			expect(config.lensesPath).toBe("./.pi/observatory/lenses");
			expect(config.port).toBe(9999);
			expect(config.host).toBe(DEFAULT_OBSERVATORY_HOST);
			expect(config.openOnStart).toBe(true);
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

	test("rejects non-loopback host bindings", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({ observatory: { host: "0.0.0.0" } }),
			);
			expect(() => loadObservatoryConfig(cwd)).toThrow(/host must be 127\.0\.0\.1/);
		});
	});

	test("rejects out-of-range and non-integer ports", () => {
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({ observatory: { port: 70000 } }),
			);
			expect(() => loadObservatoryConfig(cwd)).toThrow(/port must be between/);
		});
		withTempProject((cwd) => {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi", "settings.json"),
				JSON.stringify({ observatory: { port: "8080" } }),
			);
			expect(() => loadObservatoryConfig(cwd)).toThrow(/port must be an integer/);
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
		expect(DEFAULT_OBSERVATORY_HOST).toBe("127.0.0.1");
		expect(DEFAULT_OBSERVATORY_PORT).toBe(7878);
		expect(DEFAULT_OBSERVATORY_CONFIG).toEqual({
			lensesPath: "./.pi/observatory/lenses",
			port: 7878,
			host: "127.0.0.1",
			openOnStart: false,
		});
	});
});
