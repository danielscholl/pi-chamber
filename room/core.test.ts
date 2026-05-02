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
	appendRoomTranscriptTurn,
	buildRoomHistoryFromEntries,
	buildRoomSystemPrompt,
	deleteSavedRoom,
	latestRoomState,
	listSavedRooms,
	mergeRoomHistory,
	normalizeParticipantInput,
	normalizeRoomSlug,
	parseRoomArgs,
	type RoomState,
	readRoomTranscript,
	readRoomTranscriptHeader,
	readSavedRoom,
	TRANSCRIPT_FORMAT_VERSION,
	resolveRoomParticipants,
	resolveSavedRoomPaths,
	type SavedRoom,
	validateRoomState,
	writeSavedRoom,
	xmlEscape,
} from "./core.ts";
import { createMindStructure, resolveGenesisPaths } from "../genesis/core.ts";

function withTempProject<T>(fn: (cwd: string) => T): T {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "room-core-test-"));
	try {
		return fn(cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeCompleteMind(cwd: string, slug: string) {
	const paths = resolveGenesisPaths(cwd, slug);
	createMindStructure(paths);
	fs.writeFileSync(paths.soulPath, `# ${slug}\n\nIdentity.\n`);
	fs.writeFileSync(paths.mindIndexPath, "# Mind Index\n\n- SOUL.md\n");
	fs.writeFileSync(paths.memoryPath, "# Memory\n\nDurable context.\n");
	fs.writeFileSync(paths.rulesPath, "# Rules\n\n- Be precise.\n");
	fs.writeFileSync(paths.logPath, "# Log\n\n- Created.\n");
	return paths;
}

function activeState(overrides: Partial<RoomState> = {}): RoomState {
	return {
		active: true,
		mode: "concurrent",
		participants: ["ariadne", "mycroft"],
		...overrides,
	};
}

describe("parseRoomArgs", () => {
	test("recognizes empty and basic command forms", () => {
		expect(parseRoomArgs("")).toEqual({ type: "setupOrStatus" });
		expect(parseRoomArgs("status")).toEqual({ type: "status" });
		expect(parseRoomArgs("list")).toEqual({ type: "list" });
		expect(parseRoomArgs("clear")).toEqual({ type: "clear" });
	});

	test("rejects legacy off command in favor of /exit", () => {
		expect(parseRoomArgs("off")).toEqual({
			type: "error",
			message: expect.stringContaining("Use /exit"),
		});
	});

	test("recognizes on, mode, and minds forms", () => {
		expect(parseRoomArgs("on")).toEqual({ type: "on" });
		expect(parseRoomArgs("on concurrent all")).toEqual({
			type: "on",
			mode: "concurrent",
			participants: "all",
		});
		expect(parseRoomArgs("on sequential ariadne,mycroft")).toEqual({
			type: "on",
			mode: "sequential",
			participants: "ariadne,mycroft",
		});
		expect(parseRoomArgs("on ariadne mycroft")).toEqual({
			type: "on",
			participants: "ariadne mycroft",
		});
		expect(parseRoomArgs("mode group-chat")).toEqual({
			type: "mode",
			mode: "group-chat",
		});
		expect(parseRoomArgs("minds all")).toEqual({
			type: "minds",
			participants: "all",
		});
	});

	test("rejects the removed moderator subcommand", () => {
		expect(parseRoomArgs("moderator ariadne")).toEqual(
			expect.objectContaining({ type: "error" }),
		);
	});

	test("rejects unsupported modes", () => {
		expect(parseRoomArgs("mode handoff")).toEqual(
			expect.objectContaining({ type: "error" }),
		);
		expect(parseRoomArgs("on magentic all")).toEqual(
			expect.objectContaining({ type: "error" }),
		);
	});
});

describe("normalizeParticipantInput", () => {
	test("accepts all, comma-separated slugs, whitespace slugs, and dedupes", () => {
		expect(normalizeParticipantInput("all")).toBe("all");
		expect(normalizeParticipantInput("ariadne,mycroft")).toEqual([
			"ariadne",
			"mycroft",
		]);
		expect(normalizeParticipantInput("ariadne mycroft ariadne")).toEqual([
			"ariadne",
			"mycroft",
		]);
	});

	test("rejects empty input and display-name-ish values", () => {
		expect(() => normalizeParticipantInput("   ")).toThrow(/empty/);
		expect(() => normalizeParticipantInput("Miss Moneypenny")).toThrow(
			/display names/,
		);
		expect(() => normalizeParticipantInput("ariadne all")).toThrow(/either/);
	});
});

describe("resolveRoomParticipants", () => {
	test("accepts all and rejects unknown or incomplete minds", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const incomplete = resolveGenesisPaths(cwd, "broken");
			createMindStructure(incomplete);
			fs.writeFileSync(incomplete.soulPath, "# Broken\n");

			expect(resolveRoomParticipants(cwd, "all")).toEqual([
				"ariadne",
				"mycroft",
			]);
			expect(resolveRoomParticipants(cwd, "mycroft")).toEqual(["mycroft"]);
			expect(() => resolveRoomParticipants(cwd, "broken")).toThrow(
				/Unknown or incomplete/,
			);
			expect(() => resolveRoomParticipants(cwd, "unknown")).toThrow(
				/Unknown or incomplete/,
			);
		});
	});
});

describe("xmlEscape", () => {
	test("escapes XML-sensitive characters", () => {
		expect(xmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
	});
});

describe("validateRoomState", () => {
	test("validates participants and mode; group-chat strips moderator (chairman is built-in)", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");

			expect(validateRoomState(cwd, activeState()).ok).toBe(true);
			expect(validateRoomState(cwd, activeState({ participants: [] })).ok).toBe(
				false,
			);
			expect(validateRoomState(cwd, activeState({ mode: "handoff" })).ok).toBe(
				false,
			);
			const group = validateRoomState(
				cwd,
				activeState({ mode: "group-chat", moderator: undefined }),
			);
			expect(group.ok).toBe(true);
			expect(group.state?.moderator).toBeUndefined();
			const legacy = validateRoomState(
				cwd,
				activeState({ mode: "group-chat", moderator: "outside" }),
			);
			expect(legacy.ok).toBe(true);
			expect(legacy.state?.moderator).toBeUndefined();
		});
	});
});

describe("latestRoomState", () => {
	test("chooses the last custom chamber room state and ignores unrelated entries", () => {
		expect(
			latestRoomState([
				{ type: "custom", customType: "other", data: activeState() },
				{
					type: "custom",
					customType: "room-state",
					data: activeState({ mode: "concurrent" }),
				},
				{ type: "message", data: { active: true } },
				{
					type: "custom",
					customType: "room-state",
					data: activeState({ mode: "sequential" }),
				},
			])?.mode,
		).toBe("sequential");
	});
});

describe("buildRoomHistoryFromEntries", () => {
	test("extracts the last two completed rounds after the latest room state", () => {
		const history = buildRoomHistoryFromEntries([
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "before" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ignored" }],
				},
			},
			{ type: "custom", customType: "room-state", data: activeState() },
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "one" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer one" }],
				},
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "two" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer two" }],
				},
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "three" }] },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer three" }],
				},
			},
		]);

		expect(history).toEqual([
			{ user: "two", assistant: "answer two" },
			{ user: "three", assistant: "answer three" },
		]);
	});
});

describe("normalizeRoomSlug", () => {
	test("derives slugs from human names and rejects empty input", () => {
		expect(normalizeRoomSlug("Design Review")).toBe("design-review");
		expect(normalizeRoomSlug("daily-standup")).toBe("daily-standup");
		expect(normalizeRoomSlug("  Mixed  CASE  ")).toBe("mixed-case");
		expect(() => normalizeRoomSlug("")).toThrow(/alphanumeric/);
		expect(() => normalizeRoomSlug("   ")).toThrow(/alphanumeric/);
		expect(() => normalizeRoomSlug("---")).toThrow(/valid room slug/);
	});
});

describe("resolveSavedRoomPaths", () => {
	test("locates room files under .pi/rooms/<slug>/ inside the project", () => {
		withTempProject((cwd) => {
			const paths = resolveSavedRoomPaths(cwd, "design-review");
			expect(paths.roomDir).toBe(path.join(cwd, ".pi/rooms/design-review"));
			expect(paths.configPath).toBe(
				path.join(cwd, ".pi/rooms/design-review/room.json"),
			);
			expect(paths.transcriptPath).toBe(
				path.join(cwd, ".pi/rooms/design-review/transcript.jsonl"),
			);
		});
	});

	test("rejects slugs that are not canonical", () => {
		withTempProject((cwd) => {
			expect(() => resolveSavedRoomPaths(cwd, "Bad Slug")).toThrow(/Invalid/);
			expect(() => resolveSavedRoomPaths(cwd, "../escape")).toThrow(/Invalid/);
		});
	});
});

describe("saved room CRUD", () => {
	function makeRoom(overrides: Partial<SavedRoom> = {}): SavedRoom {
		const now = new Date().toISOString();
		return {
			slug: "design-review",
			name: "Design Review",
			mode: "concurrent",
			participants: ["ariadne", "mycroft"],
			createdAt: now,
			updatedAt: now,
			...overrides,
		};
	}

	test("writes and reads a saved room round-trip with normalized timestamps", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const written = writeSavedRoom(cwd, makeRoom());
			expect(written.slug).toBe("design-review");
			expect(written.updatedAt).toBeTruthy();

			const read = readSavedRoom(cwd, "design-review");
			expect(read).toEqual(
				expect.objectContaining({
					slug: "design-review",
					name: "Design Review",
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
				}),
			);
		});
	});

	test("listSavedRooms tolerates broken configs and surfaces validation problems", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			writeSavedRoom(cwd, makeRoom());
			writeSavedRoom(
				cwd,
				makeRoom({
					slug: "missing-mind",
					name: "Missing Mind",
					participants: ["nope"],
				}),
			);

			const summaries = listSavedRooms(cwd);
			expect(summaries.map((s) => s.slug)).toEqual([
				"design-review",
				"missing-mind",
			]);
			expect(summaries[0].problems).toEqual([]);
			expect(summaries[1].problems.join(" ")).toMatch(/Unknown or incomplete/);
		});
	});

	test("deleteSavedRoom removes the room directory", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			writeSavedRoom(cwd, makeRoom());
			deleteSavedRoom(cwd, "design-review");
			expect(() => readSavedRoom(cwd, "design-review")).toThrow(
				/No saved room/,
			);
			expect(listSavedRooms(cwd)).toEqual([]);
		});
	});

	test("rejects non-canonical slugs and unsupported modes when writing", () => {
		withTempProject((cwd) => {
			expect(() => writeSavedRoom(cwd, makeRoom({ slug: "Bad Slug" }))).toThrow(
				/canonical/,
			);
			expect(() =>
				writeSavedRoom(cwd, makeRoom({ mode: "handoff" as never })),
			).toThrow(/v1 modes/);
		});
	});
});

describe("transcript IO", () => {
	test("appends turns and reads with cap", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "daily",
				name: "daily",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			for (let i = 0; i < 60; i++) {
				appendRoomTranscriptTurn(cwd, "daily", {
					user: `u${i}`,
					assistant: `a${i}`,
					ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
				});
			}
			const turns = readRoomTranscript(cwd, "daily");
			expect(turns).toHaveLength(50);
			expect(turns[0].user).toBe("u10");
			expect(turns[turns.length - 1].user).toBe("u59");

			const fewer = readRoomTranscript(cwd, "daily", 5);
			expect(fewer).toHaveLength(5);
			expect(fewer.map((t) => t.user)).toEqual([
				"u55",
				"u56",
				"u57",
				"u58",
				"u59",
			]);
		});
	});

	test("read returns empty array when no transcript file exists", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "empty",
				name: "empty",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			expect(readRoomTranscript(cwd, "empty")).toEqual([]);
		});
	});

	test("first append writes a metadata header line", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "headered",
				name: "headered",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			appendRoomTranscriptTurn(cwd, "headered", {
				user: "u1",
				assistant: "a1",
				ts: "2026-05-02T00:00:00.000Z",
			});

			const { transcriptPath } = resolveSavedRoomPaths(cwd, "headered");
			const lines = fs
				.readFileSync(transcriptPath, "utf-8")
				.split(/\r?\n/)
				.filter((l) => l.trim());
			expect(lines).toHaveLength(2);
			const header = JSON.parse(lines[0]);
			expect(header).toMatchObject({
				_meta: true,
				v: TRANSCRIPT_FORMAT_VERSION,
				roomSlug: "headered",
			});
			expect(typeof header.createdAt).toBe("string");
			expect(JSON.parse(lines[1])).toMatchObject({ user: "u1", assistant: "a1" });
		});
	});

	test("subsequent appends do not write duplicate headers", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "single-header",
				name: "single-header",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			for (let i = 0; i < 3; i++) {
				appendRoomTranscriptTurn(cwd, "single-header", {
					user: `u${i}`,
					assistant: `a${i}`,
					ts: new Date(Date.UTC(2026, 4, 2, 0, i)).toISOString(),
				});
			}

			const { transcriptPath } = resolveSavedRoomPaths(cwd, "single-header");
			const lines = fs
				.readFileSync(transcriptPath, "utf-8")
				.split(/\r?\n/)
				.filter((l) => l.trim());
			const headers = lines.filter((l) => {
				try {
					return JSON.parse(l)._meta === true;
				} catch {
					return false;
				}
			});
			expect(headers).toHaveLength(1);
			expect(lines).toHaveLength(4); // 1 header + 3 turns
		});
	});

	test("reader skips the metadata header and returns only turns", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "skip-header",
				name: "skip-header",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			for (let i = 0; i < 3; i++) {
				appendRoomTranscriptTurn(cwd, "skip-header", {
					user: `u${i}`,
					assistant: `a${i}`,
					ts: new Date(Date.UTC(2026, 4, 2, 0, i)).toISOString(),
				});
			}
			const turns = readRoomTranscript(cwd, "skip-header");
			expect(turns).toHaveLength(3);
			expect(turns.map((t) => t.user)).toEqual(["u0", "u1", "u2"]);
		});
	});

	test("reader handles legacy transcripts that lack a header", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "legacy",
				name: "legacy",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, "legacy");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify({ user: "u0", assistant: "a0", ts: "2025-01-01T00:00:00.000Z" })}\n${JSON.stringify({ user: "u1", assistant: "a1", ts: "2025-01-01T00:01:00.000Z" })}\n`,
				"utf-8",
			);
			const turns = readRoomTranscript(cwd, "legacy");
			expect(turns).toHaveLength(2);
			expect(turns.map((t) => t.user)).toEqual(["u0", "u1"]);
		});
	});

	test("readRoomTranscriptHeader returns header for new transcripts", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "with-header",
				name: "with-header",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			appendRoomTranscriptTurn(cwd, "with-header", {
				user: "u",
				assistant: "a",
				ts: "2026-05-02T00:00:00.000Z",
			});
			const header = readRoomTranscriptHeader(cwd, "with-header");
			expect(header).toBeDefined();
			expect(header?._meta).toBe(true);
			expect(header?.v).toBe(TRANSCRIPT_FORMAT_VERSION);
			expect(header?.roomSlug).toBe("with-header");
		});
	});

	test("readRoomTranscriptHeader returns undefined for legacy or missing files", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "legacy-2",
				name: "legacy-2",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, "legacy-2");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify({ user: "u0", assistant: "a0", ts: "2025-01-01T00:00:00.000Z" })}\n`,
				"utf-8",
			);
			expect(readRoomTranscriptHeader(cwd, "legacy-2")).toBeUndefined();

			writeSavedRoom(cwd, {
				slug: "missing",
				name: "missing",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			expect(readRoomTranscriptHeader(cwd, "missing")).toBeUndefined();
		});
	});
});

describe("mergeRoomHistory", () => {
	test("pads from transcript when session rounds are short of target", () => {
		const session = [{ user: "now", assistant: "now-answer" }];
		const transcript = [
			{ user: "old", assistant: "old-answer", ts: "" },
			{ user: "older", assistant: "older-answer", ts: "" },
		];
		expect(mergeRoomHistory(session, transcript, 2)).toEqual([
			{ user: "older", assistant: "older-answer" },
			{ user: "now", assistant: "now-answer" },
		]);
	});

	test("returns session-only view when session already meets target", () => {
		const session = [
			{ user: "a", assistant: "1" },
			{ user: "b", assistant: "2" },
			{ user: "c", assistant: "3" },
		];
		expect(mergeRoomHistory(session, [], 2)).toEqual([
			{ user: "b", assistant: "2" },
			{ user: "c", assistant: "3" },
		]);
	});
});

describe("buildRoomSystemPrompt", () => {
	test("includes concurrent routing contract and history hygiene", () => {
		const prompt = buildRoomSystemPrompt({
			state: activeState(),
			history: [
				{ user: "old", assistant: "old answer" },
				{ user: "first <ask>", assistant: "answer & one" },
				{ user: "second", assistant: `answer "two"` },
			],
		});

		expect(prompt).toContain("subagent");
		expect(prompt).toContain('context: "fresh"');
		expect(prompt).toContain('agentScope: "project"');
		expect(prompt).toContain("- Mode: concurrent");
		expect(prompt).toContain("- ariadne");
		expect(prompt).toContain("concurrency: 2");
		expect(prompt).toContain("At most the last two visible room rounds");
		expect(prompt).toContain("first &lt;ask&gt;");
		expect(prompt).not.toContain("<user>old</user>");
		expect(prompt).toContain("Strip control JSON");
		expect(prompt).toContain("Handoff and magentic are future modes only");
	});

	test("includes sequential and group-chat mode-specific instructions", () => {
		const sequential = buildRoomSystemPrompt({
			state: activeState({ mode: "sequential" }),
		});
		expect(sequential).toContain("chain: [{ agent, task }, ...]");
		expect(sequential).toContain("Each later mind must see prior responses");

		const groupChat = buildRoomSystemPrompt({
			state: activeState({ mode: "group-chat" }),
		});
		expect(groupChat).toContain("strict JSON speaker selection");
		expect(groupChat).toContain(
			"The active participant slug list: ariadne, mycroft",
		);
		expect(groupChat).toContain('agent: "chairman"');
		expect(groupChat).toContain("Moderator: chairman");
		expect(groupChat).toContain("Active participant slugs: ariadne, mycroft");
		expect(groupChat).toContain("next_speaker as exactly one of those slugs");
		expect(groupChat).toContain("maximum turns 4");
	});
});
