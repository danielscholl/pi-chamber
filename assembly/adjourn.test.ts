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
import { runAdjournCommand } from "./adjourn.ts";
import type { AssembleCommandContext } from "./core.ts";
import { resolveGenesisPaths } from "../genesis/core.ts";
import { listSavedRooms, writeSavedRoom } from "../room/core.ts";

async function withTempProject<T>(
	fn: (cwd: string) => Promise<T> | T,
): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "assembly-adjourn-test-"));
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

function writeTeamLens(cwd: string, teamSlug: string) {
	const folder = path.join(
		cwd,
		".pi",
		"observatory",
		"lenses",
		`${teamSlug}-team`,
	);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(
		path.join(folder, "lens.json"),
		JSON.stringify({
			name: "Test Team",
			kind: "status-board",
			source: "data.json",
		}),
	);
	fs.writeFileSync(path.join(folder, "data.json"), "[]");
}

function seedAssemblyRoom(
	cwd: string,
	slug: string,
	displayName: string,
	members: string[],
): void {
	for (const m of members) writeMind(cwd, m);
	const now = new Date().toISOString();
	writeSavedRoom(cwd, {
		slug,
		name: displayName,
		mode: "open-floor",
		participants: members,
		createdAt: now,
		updatedAt: now,
		assembledBy: "assembly",
	});
	writeTeamLens(cwd, slug);
}

interface FakeCtxOptions {
	hasUI?: boolean;
	selectChoices?: Array<string | undefined>;
}

interface FakeCtxResult {
	ctx: AssembleCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	selects: Array<{ prompt: string; options: string[] }>;
}

function makeCtx(cwd: string, opts: FakeCtxOptions = {}): FakeCtxResult {
	const notifications: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ prompt: string; options: string[] }> = [];
	const queue = [...(opts.selectChoices ?? [])];
	const ctx: AssembleCommandContext = {
		cwd,
		hasUI: opts.hasUI ?? true,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
			setStatus() {},
			async select(prompt, options) {
				selects.push({ prompt, options });
				return queue.length ? queue.shift() : undefined;
			},
			async input() {
				return undefined;
			},
			setWidget() {},
		},
	};
	return { ctx, notifications, selects };
}

interface AuditEntry {
	stream: string;
	entry: Record<string, unknown>;
}

function makeDeps(): {
	pi: never;
	appendEntry: (stream: string, entry: Record<string, unknown>) => void;
	audits: AuditEntry[];
} {
	const audits: AuditEntry[] = [];
	return {
		pi: {} as never,
		appendEntry: (stream, entry) => audits.push({ stream, entry }),
		audits,
	};
}

describe("runAdjournCommand", () => {
	test("refuses without UI", async () => {
		await withTempProject(async (cwd) => {
			const { ctx } = makeCtx(cwd, { hasUI: false });
			const deps = makeDeps();
			await expect(
				runAdjournCommand({}, ctx, deps),
			).rejects.toThrow(/requires interactive UI/);
		});
	});

	test("errors when no assemblies exist", async () => {
		await withTempProject(async (cwd) => {
			const { ctx, notifications } = makeCtx(cwd);
			const deps = makeDeps();
			await runAdjournCommand({}, ctx, deps);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("No assemblies to adjourn");
		});
	});

	test("auto-targets the only assembly when no slug is provided", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil", "chris"]);
			const { ctx } = makeCtx(cwd, { selectChoices: ["Adjourn"] });
			const deps = makeDeps();

			await runAdjournCommand({}, ctx, deps);

			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(false);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "neil")),
			).toBe(false);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "chris")),
			).toBe(false);
			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "observatory", "lenses", "assembly-team"),
				),
			).toBe(false);
			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "observatory", "lenses", "neil-newspaper"),
				),
			).toBe(false);

			const summary = deps.audits.find(
				(e) => e.stream === "genesis-assemble",
			);
			expect(summary).toBeDefined();
			expect(summary?.entry.action).toBe("adjourn");
			expect(summary?.entry.removedMembers).toEqual(["neil", "chris"]);
		});
	});

	test("shows picker when multiple assemblies exist", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil"]);
			seedAssemblyRoom(cwd, "auth-review", "Auth Review", ["alice"]);
			const { ctx, selects } = makeCtx(cwd, {
				selectChoices: [
					"Auth Review (auth-review) — 1 member",
					"Adjourn",
				],
			});
			const deps = makeDeps();

			await runAdjournCommand({}, ctx, deps);

			// Assembly is the picker; second select is the confirmation
			expect(selects[0].prompt).toContain("Adjourn which team?");
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "auth-review")),
			).toBe(false);
			// 'assembly' team is untouched
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(true);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "neil")),
			).toBe(true);
		});
	});

	test("adjourns the named team when slug is provided", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil"]);
			seedAssemblyRoom(cwd, "auth-review", "Auth Review", ["alice"]);
			const { ctx } = makeCtx(cwd, { selectChoices: ["Adjourn"] });
			const deps = makeDeps();

			await runAdjournCommand({ adjournSlug: "auth-review" }, ctx, deps);

			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "auth-review")),
			).toBe(false);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "alice")),
			).toBe(false);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(true);
		});
	});

	test("refuses when target room lacks the assembledBy marker", async () => {
		await withTempProject(async (cwd) => {
			writeMind(cwd, "alice");
			const now = new Date().toISOString();
			writeSavedRoom(cwd, {
				slug: "hand-rolled",
				name: "Hand Rolled",
				mode: "concurrent",
				participants: ["alice"],
				createdAt: now,
				updatedAt: now,
			});
			const { ctx, notifications } = makeCtx(cwd);
			const deps = makeDeps();

			await runAdjournCommand({ adjournSlug: "hand-rolled" }, ctx, deps);

			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain("/room delete");
			// Nothing removed
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "hand-rolled")),
			).toBe(true);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "alice")),
			).toBe(true);
		});
	});

	test("preserves members shared with another saved room", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil", "chris"]);
			// hand-rolled room that also references neil
			const now = new Date().toISOString();
			writeSavedRoom(cwd, {
				slug: "hand-rolled",
				name: "Hand Rolled",
				mode: "concurrent",
				participants: ["neil"],
				createdAt: now,
				updatedAt: now,
			});

			const { ctx } = makeCtx(cwd, { selectChoices: ["Adjourn"] });
			const deps = makeDeps();
			await runAdjournCommand({}, ctx, deps);

			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "neil")),
			).toBe(true);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "chris")),
			).toBe(false);

			const audit = deps.audits.find((e) => e.stream === "genesis-assemble");
			expect(audit?.entry.removedMembers).toEqual(["chris"]);
			expect(audit?.entry.preservedMembers).toEqual([
				{ slug: "neil", otherRooms: ["hand-rolled"] },
			]);
		});
	});

	test("errors when slug is provided but room does not exist", async () => {
		await withTempProject(async (cwd) => {
			const { ctx, notifications } = makeCtx(cwd);
			const deps = makeDeps();
			await runAdjournCommand({ adjournSlug: "nope" }, ctx, deps);
			const last = notifications[notifications.length - 1];
			expect(last.type).toBe("error");
			expect(last.message).toContain('"nope"');
		});
	});

	test("cancel leaves files in place", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil"]);
			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Cancel"],
			});
			const deps = makeDeps();

			await runAdjournCommand({}, ctx, deps);

			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(true);
			expect(
				fs.existsSync(path.join(cwd, ".pi", "minds", "neil")),
			).toBe(true);
			expect(deps.audits).toHaveLength(0);
			const last = notifications[notifications.length - 1];
			expect(last.message).toContain("cancelled");
		});
	});

	test("dedupes duplicate participant slugs to avoid double removal", async () => {
		await withTempProject(async (cwd) => {
			// Hand-roll a saved room with a duplicated participant. writeSavedRoom
			// preserves participants verbatim, so the duplicate exercises the
			// partitionMembers dedupe path.
			writeMind(cwd, "neil");
			const now = new Date().toISOString();
			writeSavedRoom(cwd, {
				slug: "assembly",
				name: "Assembly",
				mode: "open-floor",
				participants: ["neil", "neil"],
				createdAt: now,
				updatedAt: now,
				assembledBy: "assembly",
			});
			writeTeamLens(cwd, "assembly");

			const { ctx } = makeCtx(cwd, { selectChoices: ["Adjourn"] });
			const deps = makeDeps();

			await runAdjournCommand({}, ctx, deps);

			const audit = deps.audits.find(
				(e) => e.stream === "genesis-assemble",
			);
			expect(audit?.entry.removedMembers).toEqual(["neil"]);
			// And the inner per-mind audit stream should not have a duplicate entry.
			const mindAudits = deps.audits.filter((e) => e.stream === "genesis");
			expect(mindAudits).toHaveLength(1);
		});
	});

	test("preserves lens and room when a member removal fails", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil", "chris"]);

			// Make `neil`'s shim path read-only so rmSync fails. We replace the
			// parent directory with a regular file to provoke an error from
			// rmSync(paths.shimPath, { force: true }) — `force: true` bypasses
			// missing-file errors but not type errors.
			const neilShim = path.join(cwd, ".pi", "agents", "neil.md");
			// Replace neil's mind dir with a path we can't delete cleanly: lock
			// down by removing the shim and inserting a directory in its place
			// after the mind dir is deleted. Simpler: chmod the agents dir to 0.
			const agentsDir = path.dirname(neilShim);
			fs.chmodSync(agentsDir, 0o500);

			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Adjourn"],
			});
			const deps = makeDeps();

			try {
				await runAdjournCommand({}, ctx, deps);
			} finally {
				// Restore so withTempProject teardown can succeed.
				fs.chmodSync(agentsDir, 0o755);
			}

			// At least one mind removal failed → lens and room should remain.
			expect(
				fs.existsSync(path.join(cwd, ".pi", "rooms", "assembly")),
			).toBe(true);
			expect(
				fs.existsSync(
					path.join(cwd, ".pi", "observatory", "lenses", "assembly-team"),
				),
			).toBe(true);

			const summary = notifications.find((n) =>
				n.message.startsWith("ADJOURNED"),
			);
			expect(summary?.message).toContain("skipped (member removal failed)");
			expect(notifications.some((n) => n.type === "warning")).toBe(true);
		});
	});

	test("summary distinguishes removed vs already-absent members", async () => {
		await withTempProject(async (cwd) => {
			// Seed a room with neil + chris, but only neil has any on-disk artifacts.
			writeMind(cwd, "neil");
			const now = new Date().toISOString();
			writeSavedRoom(cwd, {
				slug: "assembly",
				name: "Assembly",
				mode: "open-floor",
				participants: ["neil", "chris"],
				createdAt: now,
				updatedAt: now,
				assembledBy: "assembly",
			});
			writeTeamLens(cwd, "assembly");

			const { ctx, notifications } = makeCtx(cwd, {
				selectChoices: ["Adjourn"],
			});
			const deps = makeDeps();

			await runAdjournCommand({}, ctx, deps);

			const summary = notifications.find((n) =>
				n.message.startsWith("ADJOURNED"),
			);
			expect(summary?.message).toContain("removed:    1 mind (neil)");
			expect(summary?.message).toContain("already absent: chris");

			const audit = deps.audits.find(
				(e) => e.stream === "genesis-assemble",
			);
			expect(audit?.entry.removedMembers).toEqual(["neil"]);
			expect(audit?.entry.alreadyAbsent).toEqual(["chris"]);
		});
	});

	test("filters assembly rooms via SavedRoomSummary marker (no per-room re-read)", async () => {
		await withTempProject(async (cwd) => {
			seedAssemblyRoom(cwd, "assembly", "Assembly", ["neil"]);
			// Hand-rolled room without the marker should be excluded from picker.
			writeMind(cwd, "alice");
			const now = new Date().toISOString();
			writeSavedRoom(cwd, {
				slug: "manual",
				name: "Manual",
				mode: "concurrent",
				participants: ["alice"],
				createdAt: now,
				updatedAt: now,
			});

			const summaries = listSavedRooms(cwd);
			const assemblyMarked = summaries.filter(
				(s) => s.assembledBy === "assembly",
			);
			expect(assemblyMarked.map((s) => s.slug)).toEqual(["assembly"]);
		});
	});
});
