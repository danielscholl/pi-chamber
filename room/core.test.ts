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
	deleteSavedRoom,
	dropRoomSessions,
	latestRoomState,
	listRoomSessions,
	listSavedRooms,
	mergeRoomHistory,
	normalizeParticipantInput,
	normalizeRoomSlug,
	parseRoomArgs,
	type RoomState,
	readRoomTranscript,
	readRoomTranscriptHeader,
	readSavedRoom,
	resolveRoomSessionPath,
	resolveRoomSessionsDir,
	TRANSCRIPT_FORMAT_VERSION,
	resolveRoomParticipants,
	resolveSavedRoomPaths,
	type SavedRoom,
	safeReadSavedRoom,
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

/** Build a V2 transcript turn shaped like the V1 single-blob equivalent.
 * Used to keep legacy-shape transcript tests readable. */
function v2TurnFromV1(
	user: string,
	assistant: string,
	ts: string,
): import("./core.ts").RoomTranscriptTurnV2 {
	return {
		version: 2,
		user,
		mode: "concurrent",
		ts,
		turns: [{ speaker: "room", role: "speaker", content: assistant }],
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

	test("recognizes reset with and without a slug", () => {
		expect(parseRoomArgs("reset")).toEqual({ type: "reset" });
		expect(parseRoomArgs("reset design-review")).toEqual({
			type: "reset",
			slug: "design-review",
		});
	});

	test("rejects reset with non-canonical slug", () => {
		expect(parseRoomArgs("reset Bad Slug")).toEqual(
			expect.objectContaining({ type: "error" }),
		);
		expect(parseRoomArgs("reset BAD")).toEqual(
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
	test("validates participants and mode; group-chat is supported (chairman is built-in)", () => {
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
				activeState({ mode: "group-chat" }),
			);
			expect(group.ok).toBe(true);
			expect(group.state?.mode).toBe("group-chat");
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
				appendRoomTranscriptTurn(
					cwd,
					"daily",
					v2TurnFromV1(
						`u${i}`,
						`a${i}`,
						new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
					),
				);
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
			appendRoomTranscriptTurn(
				cwd,
				"headered",
				v2TurnFromV1("u1", "a1", "2026-05-02T00:00:00.000Z"),
			);

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
			const turnLine = JSON.parse(lines[1]);
			expect(turnLine).toMatchObject({
				version: 2,
				user: "u1",
				mode: "concurrent",
			});
			expect(turnLine.turns).toEqual([
				{ speaker: "room", role: "speaker", content: "a1" },
			]);
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
				appendRoomTranscriptTurn(
					cwd,
					"single-header",
					v2TurnFromV1(
						`u${i}`,
						`a${i}`,
						new Date(Date.UTC(2026, 4, 2, 0, i)).toISOString(),
					),
				);
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
				appendRoomTranscriptTurn(
					cwd,
					"skip-header",
					v2TurnFromV1(
						`u${i}`,
						`a${i}`,
						new Date(Date.UTC(2026, 4, 2, 0, i)).toISOString(),
					),
				);
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
			appendRoomTranscriptTurn(
				cwd,
				"with-header",
				v2TurnFromV1("u", "a", "2026-05-02T00:00:00.000Z"),
			);
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
	test("pads from transcript (V2) when session rounds are short of target", () => {
		const session = [{ user: "now", assistant: "now-answer" }];
		const transcript = [
			v2TurnFromV1("old", "old-answer", ""),
			v2TurnFromV1("older", "older-answer", ""),
		];
		expect(mergeRoomHistory(session, transcript, 2)).toEqual([
			{ user: "older", assistant: "[room]\nolder-answer" },
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

	test("flattens multi-speaker V2 turns into per-speaker assistant blob", () => {
		const transcript: import("./core.ts").RoomTranscriptTurnV2[] = [
			{
				version: 2,
				user: "what next?",
				mode: "group-chat",
				ts: "",
				turns: [
					{ speaker: "ariadne", role: "speaker", content: "do A" },
					{ speaker: "mycroft", role: "speaker", content: "do B" },
				],
			},
		];
		expect(mergeRoomHistory([], transcript, 1)).toEqual([
			{ user: "what next?", assistant: "[ariadne]\ndo A\n\n[mycroft]\ndo B" },
		]);
	});
});

describe("saved room optional fields", () => {
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

	test("round-trips groupChat, synthesizer, concurrentSynthesis, and forkPerMind", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			writeSavedRoom(
				cwd,
				makeRoom({
					groupChat: { maxTurns: 8, minRounds: 2, maxSpeakerRepeats: 3 },
					synthesizer: "ariadne",
					concurrentSynthesis: "chairman",
					forkPerMind: true,
				}),
			);
			const read = readSavedRoom(cwd, "design-review");
			expect(read.groupChat).toEqual({
				maxTurns: 8,
				minRounds: 2,
				maxSpeakerRepeats: 3,
			});
			expect(read.synthesizer).toBe("ariadne");
			expect(read.concurrentSynthesis).toBe("chairman");
			expect(read.forkPerMind).toBe(true);
		});
	});

	test("rooms without optional fields read as undefined", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			writeSavedRoom(cwd, makeRoom());
			const read = readSavedRoom(cwd, "design-review");
			expect(read.groupChat).toBeUndefined();
			expect(read.synthesizer).toBeUndefined();
			expect(read.concurrentSynthesis).toBeUndefined();
			expect(read.forkPerMind).toBeUndefined();
		});
	});

	test("malformed optional fields silently coerce to undefined", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			// Hand-craft a room.json with bogus optional fields to bypass writer normalization.
			const { roomDir, configPath } = resolveSavedRoomPaths(cwd, "design-review");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					slug: "design-review",
					name: "Design Review",
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					groupChat: { maxTurns: "eight", minRounds: -1 },
					synthesizer: 42,
					concurrentSynthesis: "Bad Slug",
					forkPerMind: "yes",
				}),
				"utf-8",
			);
			const read = readSavedRoom(cwd, "design-review");
			expect(read.groupChat).toBeUndefined();
			expect(read.synthesizer).toBeUndefined();
			expect(read.concurrentSynthesis).toBeUndefined();
			expect(read.forkPerMind).toBeUndefined();
		});
	});

	test("partially malformed groupChat keeps valid fields and drops invalid ones", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			const { roomDir, configPath } = resolveSavedRoomPaths(cwd, "design-review");
			fs.mkdirSync(roomDir, { recursive: true });
			const now = new Date().toISOString();
			fs.writeFileSync(
				configPath,
				JSON.stringify({
					slug: "design-review",
					name: "Design Review",
					mode: "concurrent",
					participants: ["ariadne", "mycroft"],
					createdAt: now,
					updatedAt: now,
					groupChat: { maxTurns: 6, minRounds: "bad", maxSpeakerRepeats: 2 },
				}),
				"utf-8",
			);
			const read = readSavedRoom(cwd, "design-review");
			expect(read.groupChat).toEqual({ maxTurns: 6, maxSpeakerRepeats: 2 });
		});
	});

	test("safeReadSavedRoom returns undefined on missing or malformed config", () => {
		withTempProject((cwd) => {
			expect(safeReadSavedRoom(cwd, "nonexistent")).toBeUndefined();
			const { roomDir, configPath } = resolveSavedRoomPaths(cwd, "broken");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(configPath, "{not json", "utf-8");
			expect(safeReadSavedRoom(cwd, "broken")).toBeUndefined();
		});
	});
});

describe("V2 transcript shape", () => {
	test("appendRoomTranscriptTurn writes per-speaker structured turns", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeCompleteMind(cwd, "mycroft");
			writeSavedRoom(cwd, {
				slug: "v2",
				name: "v2",
				mode: "group-chat",
				participants: ["ariadne", "mycroft"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			appendRoomTranscriptTurn(cwd, "v2", {
				version: 2,
				user: "thoughts?",
				mode: "group-chat",
				durationMs: 1234,
				ts: "2026-05-03T00:00:00.000Z",
				turns: [
					{
						speaker: "ariadne",
						role: "speaker",
						content: "lean A",
						turnNumber: 1,
						paletteIndex: 0,
					},
					{
						speaker: "chairman",
						role: "synthesis",
						content: "consensus: A",
						turnNumber: 2,
						paletteIndex: 4,
					},
				],
			});
			const turns = readRoomTranscript(cwd, "v2");
			expect(turns).toHaveLength(1);
			expect(turns[0].user).toBe("thoughts?");
			expect(turns[0].mode).toBe("group-chat");
			expect(turns[0].durationMs).toBe(1234);
			expect(turns[0].turns.map((t) => t.speaker)).toEqual([
				"ariadne",
				"chairman",
			]);
			expect(turns[0].turns[1].role).toBe("synthesis");
		});
	});

	test("readRoomTranscript lifts V1 legacy lines into V2 shape", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "legacy-v1",
				name: "legacy-v1",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, "legacy-v1");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify({ user: "u0", assistant: "a0", ts: "" })}\n${JSON.stringify({ user: "u1", assistant: "a1", ts: "" })}\n`,
				"utf-8",
			);
			const turns = readRoomTranscript(cwd, "legacy-v1");
			expect(turns).toHaveLength(2);
			expect(turns[0].turns[0]).toEqual({
				speaker: "room",
				role: "speaker",
				content: "a0",
			});
		});
	});

	test("readRoomTranscript drops V2 lines whose inner turns are malformed", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "bad-inner",
				name: "bad-inner",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const { roomDir, transcriptPath } = resolveSavedRoomPaths(
				cwd,
				"bad-inner",
			);
			fs.mkdirSync(roomDir, { recursive: true });
			// One well-formed V2 turn, then several malformed ones, then another good turn.
			const lines = [
				JSON.stringify({
					_meta: true,
					v: 2,
					roomSlug: "bad-inner",
					createdAt: "",
				}),
				JSON.stringify({
					version: 2,
					user: "good-1",
					mode: "concurrent",
					ts: "",
					turns: [{ speaker: "ariadne", role: "speaker", content: "ok" }],
				}),
				// Inner turn is a primitive
				JSON.stringify({
					version: 2,
					user: "bad-primitive",
					mode: "concurrent",
					ts: "",
					turns: [1],
				}),
				// Inner turn missing required fields
				JSON.stringify({
					version: 2,
					user: "bad-missing",
					mode: "concurrent",
					ts: "",
					turns: [{ content: 5 }],
				}),
				// Inner turn has invalid role
				JSON.stringify({
					version: 2,
					user: "bad-role",
					mode: "concurrent",
					ts: "",
					turns: [
						{ speaker: "ariadne", role: "narrator", content: "x" },
					],
				}),
				JSON.stringify({
					version: 2,
					user: "good-2",
					mode: "concurrent",
					ts: "",
					turns: [{ speaker: "ariadne", role: "speaker", content: "ok2" }],
				}),
			];
			fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf-8");
			const turns = readRoomTranscript(cwd, "bad-inner");
			expect(turns.map((t) => t.user)).toEqual(["good-1", "good-2"]);
		});
	});

	test("readRoomTranscript handles mixed V1+V2 lines in one file", () => {
		withTempProject((cwd) => {
			writeCompleteMind(cwd, "ariadne");
			writeSavedRoom(cwd, {
				slug: "mixed",
				name: "mixed",
				mode: "concurrent",
				participants: ["ariadne"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const { roomDir, transcriptPath } = resolveSavedRoomPaths(cwd, "mixed");
			fs.mkdirSync(roomDir, { recursive: true });
			fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify({ _meta: true, v: 1, roomSlug: "mixed", createdAt: "" })}\n${JSON.stringify({ user: "u0", assistant: "old-blob", ts: "" })}\n${JSON.stringify({ version: 2, user: "u1", mode: "concurrent", ts: "", turns: [{ speaker: "ariadne", role: "speaker", content: "new" }] })}\n`,
				"utf-8",
			);
			const turns = readRoomTranscript(cwd, "mixed");
			expect(turns).toHaveLength(2);
			expect(turns[0].turns[0].speaker).toBe("room");
			expect(turns[0].turns[0].content).toBe("old-blob");
			expect(turns[1].turns[0].speaker).toBe("ariadne");
			expect(turns[1].turns[0].content).toBe("new");
		});
	});
});

describe("room session path helpers", () => {
	test("resolveRoomSessionPath returns the expected location", () => {
		withTempProject((cwd) => {
			const sessionPath = resolveRoomSessionPath(cwd, "design-review", "ariadne");
			expect(sessionPath).toBe(
				path.join(cwd, ".pi/rooms/design-review/sessions/ariadne.session.jsonl"),
			);
			expect(resolveRoomSessionsDir(cwd, "design-review")).toBe(
				path.join(cwd, ".pi/rooms/design-review/sessions"),
			);
		});
	});

	test("rejects non-canonical slugs", () => {
		withTempProject((cwd) => {
			expect(() =>
				resolveRoomSessionPath(cwd, "design-review", "Bad Slug"),
			).toThrow(/Invalid mind slug/);
			expect(() => resolveRoomSessionPath(cwd, "Bad Room", "ariadne")).toThrow(
				/Invalid room slug/,
			);
		});
	});

	test("listRoomSessions returns sorted slugs and ignores non-session files", () => {
		withTempProject((cwd) => {
			const sessionsDir = path.join(cwd, ".pi/rooms/daily/sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "mycroft.session.jsonl"),
				"{}",
				"utf-8",
			);
			fs.writeFileSync(
				path.join(sessionsDir, "ariadne.session.jsonl"),
				"{}",
				"utf-8",
			);
			fs.writeFileSync(path.join(sessionsDir, "README.md"), "# notes", "utf-8");
			expect(listRoomSessions(cwd, "daily")).toEqual(["ariadne", "mycroft"]);
		});
	});

	test("listRoomSessions returns [] when the dir does not exist", () => {
		withTempProject((cwd) => {
			expect(listRoomSessions(cwd, "missing")).toEqual([]);
		});
	});

	test("dropRoomSessions removes the directory and reports the count", () => {
		withTempProject((cwd) => {
			const sessionsDir = path.join(cwd, ".pi/rooms/daily/sessions");
			fs.mkdirSync(sessionsDir, { recursive: true });
			fs.writeFileSync(
				path.join(sessionsDir, "ariadne.session.jsonl"),
				"{}",
				"utf-8",
			);
			fs.writeFileSync(
				path.join(sessionsDir, "mycroft.session.jsonl"),
				"{}",
				"utf-8",
			);
			expect(dropRoomSessions(cwd, "daily")).toBe(2);
			expect(fs.existsSync(sessionsDir)).toBe(false);
			expect(dropRoomSessions(cwd, "daily")).toBe(0);
		});
	});
});
