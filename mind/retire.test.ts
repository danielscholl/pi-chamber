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
import { writeSavedRoom } from "../room/core.ts";
import {
	type MindRetireCommandContext,
	type MindRetireDeps,
	runRetireCommand,
} from "./retire.ts";

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mind-retire-test-"));
	try {
		return await fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	fs.mkdirSync(paths.mindPath, { recursive: true });
	for (const folder of paths.ideaFolders)
		fs.mkdirSync(folder, { recursive: true });
	fs.mkdirSync(paths.workingMemoryPath, { recursive: true });
	fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
	fs.writeFileSync(paths.agentPath, "# Operating Doctrine\n");
	fs.writeFileSync(paths.soulPath, `# ${slug}\n\nbody\n`);
	fs.writeFileSync(paths.mindIndexPath, "# Index\n\n- SOUL.md\n");
	fs.writeFileSync(paths.memoryPath, "# Memory\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n");
	fs.writeFileSync(paths.logPath, "# Log\n");
	fs.writeFileSync(
		paths.shimPath,
		`---\nname: ${slug}\ndescription: "x"\n---\n\nbody\n`,
	);
	const lensFolder = path.join(
		cwd,
		".pi",
		"observatory",
		"lenses",
		`${slug}-newspaper`,
	);
	fs.mkdirSync(lensFolder, { recursive: true });
	fs.writeFileSync(
		path.join(lensFolder, "lens.json"),
		JSON.stringify({
			name: "Test Newspaper",
			kind: "briefing",
			source: "data.json",
		}),
	);
	fs.writeFileSync(path.join(lensFolder, "data.json"), "{}");
}

function seedSavedRoom(
	cwd: string,
	slug: string,
	displayName: string,
	members: string[],
	options: { assembledBy?: "assembly" } = {},
): void {
	const now = new Date().toISOString();
	writeSavedRoom(cwd, {
		slug,
		name: displayName,
		mode: "concurrent",
		participants: members,
		createdAt: now,
		updatedAt: now,
		...(options.assembledBy ? { assembledBy: options.assembledBy } : {}),
	});
}

interface FakeCtxOptions {
	hasUI?: boolean;
	selectChoices?: Array<string | undefined>;
	noSelect?: boolean;
}

interface FakeCtxResult {
	ctx: MindRetireCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	selects: Array<{ prompt: string; options: string[] }>;
}

function makeCtx(cwd: string, opts: FakeCtxOptions = {}): FakeCtxResult {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ prompt: string; options: string[] }> = [];
	const queue = [...(opts.selectChoices ?? [])];
	const ctx: MindRetireCommandContext = {
		cwd,
		hasUI: opts.hasUI ?? true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {},
			...(opts.noSelect
				? {}
				: {
						async select(prompt, options) {
							selects.push({ prompt, options });
							return queue.length ? queue.shift() : undefined;
						},
					}),
		},
	};
	return { ctx, notifications, selects };
}

interface AuditEntry {
	stream: string;
	entry: Record<string, unknown>;
}

function makeDeps(activeSlug?: string): {
	deps: MindRetireDeps;
	audits: AuditEntry[];
} {
	const audits: AuditEntry[] = [];
	const deps: MindRetireDeps = {
		appendEntry: (stream, entry) => audits.push({ stream, entry }),
		isActiveMind: (slug) => slug === activeSlug,
	};
	return { deps, audits };
}

describe("runRetireCommand", () => {
	test("refuses without UI", async () => {
		await withTempProject(async (cwd) => {
			const { ctx } = makeCtx(cwd, { hasUI: false });
			const { deps } = makeDeps();
			await expect(runRetireCommand({}, ctx, deps)).rejects.toThrow(
				/requires interactive UI/,
			);
		});
	});

	test("errors when no minds exist and no slug given", async () => {
		await withTempProject(async (cwd) => {
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps();
			await runRetireCommand({}, ctx, deps);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("No Genesis minds to retire");
		});
	});

	test("errors when slug provided but mind directory does not exist", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "alice");
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps();
			await runRetireCommand({ slug: "ghost" }, ctx, deps);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain('"ghost"');
			expect(last.message).toContain("alice");
		});
	});

	test("retires a mind cleanly when no rooms reference it", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Retire"],
			});
			const { deps, audits } = makeDeps();

			await runRetireCommand({ slug: "neil" }, ctx, deps);

			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "neil"))).toBe(
				false,
			);
			expect(fs.existsSync(path.join(cwd, ".pi", "agents", "neil.md"))).toBe(
				false,
			);
			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "observatory", "lenses", "neil-newspaper"),
				),
			).toBe(false);

			const audit = audits.find((e) => e.stream === "genesis");
			expect(audit).toBeDefined();
			expect(audit?.entry.action).toBe("remove");
			expect(audit?.entry.slug).toBe("neil");
			expect(audit?.entry.source).toBe("mind-retire");

			const retiredNotice = notifications.find(
				(n) => n.type === "info" && n.message.includes("RETIRED"),
			);
			expect(retiredNotice).toBeDefined();
			expect(retiredNotice!.message).toContain("neil");
		});
	});

	test("refuses when the mind is currently active in this session", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps("neil"); // neil is active

			await runRetireCommand({ slug: "neil" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("currently active");
			expect(last.message).toContain("/leave");
			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "neil"))).toBe(
				true,
			);
		});
	});

	test("refuses when a hand-rolled saved room references the mind", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			seedSavedRoom(cwd, "review", "Review Crew", ["neil"]);
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps();

			await runRetireCommand({ slug: "neil" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("still referenced");
			expect(last.message).toContain("/room close review");
			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "neil"))).toBe(
				true,
			);
		});
	});

	test("refuses when an assembly room references the mind, pointing at adjourn", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "chris");
			seedSavedRoom(cwd, "assembly", "Assembly", ["chris"], {
				assembledBy: "assembly",
			});
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps();

			await runRetireCommand({ slug: "chris" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("/assembly adjourn assembly");
			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "chris"))).toBe(
				true,
			);
		});
	});

	test("cancel preserves all files", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Cancel"],
			});
			const { deps, audits } = makeDeps();

			await runRetireCommand({ slug: "neil" }, ctx, deps);

			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "neil"))).toBe(
				true,
			);
			expect(audits).toHaveLength(0);
			const last = notifications[notifications.length - 1];
			expect(last.message).toContain("cancelled");
		});
	});

	test("shows picker when no slug is provided and minds exist", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "alice");
			writeMind(cwd, "neil");
			const { ctx, selects } = makeCtx(cwd, {
				selectChoices: ["neil", "Retire"],
			});
			const { deps } = makeDeps();

			await runRetireCommand({}, ctx, deps);

			expect(selects[0].prompt).toContain("Retire which mind?");
			expect(selects[0].options).toEqual(["alice", "neil"]);
			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "neil"))).toBe(
				false,
			);
			expect(fs.existsSync(path.join(cwd, ".pi", "minds", "alice"))).toBe(
				true,
			);
		});
	});

	test("rejects a reserved subcommand keyword as a slug", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			const { ctx, notifications } = makeCtx(cwd);
			const { deps } = makeDeps();

			// `retire` itself is reserved by normalizeMindSlug so it can never be
			// a valid mind name; passing it as the target slug should fail at
			// normalization rather than silently picking up a real mind.
			await runRetireCommand({ slug: "retire" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toMatch(/reserved/);
		});
	});

	test("retires a partially-authored mind (missing shim) without erroring", async () => {
		await withTempProject(async (cwd) => {
			// Write a mind directory but skip the shim — simulates a crashed
			// genesis run. listGenesisMinds() rejects this because validation
			// fails, but retire targets the directory directly.
			const paths = resolveGenesisPaths(cwd, "stub");
			fs.mkdirSync(paths.mindPath, { recursive: true });
			fs.writeFileSync(paths.soulPath, "# stub\n");
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Retire"],
			});
			const { deps } = makeDeps();

			await runRetireCommand({ slug: "stub" }, ctx, deps);

			expect(fs.existsSync(paths.mindPath)).toBe(false);
			const retiredNotice = notifications.find(
				(n) => n.type === "info" && n.message.includes("RETIRED"),
			);
			expect(retiredNotice).toBeDefined();
		});
	});

	test("refuses without a select-capable UI", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "neil");
			const { ctx, notifications } = makeCtx(cwd, { noSelect: true });
			const { deps } = makeDeps();

			await runRetireCommand({ slug: "neil" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("UI does not support select");
		});
	});
});
