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
import { ObservatoryOverlay } from "./component.ts";

interface StubTui {
	requestRender(): void;
	renderCalls: number;
}

function makeTui(): StubTui {
	const tui: StubTui = {
		renderCalls: 0,
		requestRender() {
			tui.renderCalls++;
		},
	};
	return tui;
}

const stubTheme = {
	fg(_color: string, text: string): string {
		return text;
	},
};

function withTempProject(fn: (cwd: string, lensesRoot: string) => void): void {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-overlay-"));
	const lensesRoot = path.join(cwd, ".pi", "observatory", "lenses");
	fs.mkdirSync(lensesRoot, { recursive: true });
	try {
		fn(cwd, lensesRoot);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

function writeLens(
	lensesRoot: string,
	id: string,
	manifest: unknown,
	data?: unknown,
): void {
	const folder = path.join(lensesRoot, id);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(
		path.join(folder, "lens.json"),
		typeof manifest === "string" ? manifest : JSON.stringify(manifest),
	);
	if (data !== undefined) {
		fs.writeFileSync(
			path.join(folder, "data.json"),
			typeof data === "string" ? data : JSON.stringify(data),
		);
	}
}

describe("ObservatoryOverlay render — empty workspace", () => {
	test("opens on the Dashboard with the four built-in panels", () => {
		withTempProject((cwd, lensesRoot) => {
			const tui = makeTui();
			const overlay = new ObservatoryOverlay(
				tui as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				const lines = overlay.render(80);
				const text = lines.join("\n");
				expect(text).toContain("Observatory");
				expect(text).toContain("Dashboard");
				expect(text).toContain("Lenses");
				expect(text).toContain("Room");
				expect(text).toContain("Minds");
				expect(text).toContain("Activity");
			} finally {
				overlay.dispose();
			}
		});
	});
});

describe("ObservatoryOverlay render — with lenses", () => {
	test("sidebar lists discovered lenses next to Dashboard", () => {
		withTempProject((cwd, lensesRoot) => {
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				{ active_minds: 3, top_priority: "Ship the TUI" },
			);
			writeLens(
				lensesRoot,
				"room",
				{ name: "Chamber Room", kind: "status-board", source: "data.json" },
				[{ name: "moneypenny", status: "thinking" }],
			);
			const tui = makeTui();
			const overlay = new ObservatoryOverlay(
				tui as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				const text = overlay.render(80).join("\n");
				expect(text).toContain("Operations");
				expect(text).toContain("Chamber Room");
				expect(text).toContain("operations");
				expect(text).toContain("room");
			} finally {
				overlay.dispose();
			}
		});
	});

	test("selecting a briefing lens renders its key/value rows", () => {
		withTempProject((cwd, lensesRoot) => {
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				{ active_minds: 3, top_priority: "Ship the TUI" },
			);
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				overlay.handleInput("j"); // select operations
				const text = overlay.render(80).join("\n");
				expect(text).toContain("active minds");
				expect(text).toContain("3");
				expect(text).toContain("top priority");
			} finally {
				overlay.dispose();
			}
		});
	});

	test("selecting a status-board lens renders status entries", () => {
		withTempProject((cwd, lensesRoot) => {
			writeLens(
				lensesRoot,
				"room",
				{ name: "Chamber Room", kind: "status-board", source: "data.json" },
				[
					{ name: "moneypenny", status: "thinking" },
					{ name: "scribe", status: "running" },
				],
			);
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				overlay.handleInput("j"); // select room (only lens)
				const text = overlay.render(80).join("\n");
				expect(text).toContain("moneypenny");
				expect(text).toContain("scribe");
				expect(text).toContain("[thinking]");
				expect(text).toContain("[running]");
			} finally {
				overlay.dispose();
			}
		});
	});

	test("invalid lenses surface their reason on selection", () => {
		withTempProject((cwd, lensesRoot) => {
			fs.mkdirSync(path.join(lensesRoot, "broken"), { recursive: true });
			fs.writeFileSync(path.join(lensesRoot, "broken", "lens.json"), "{ not json");
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				overlay.handleInput("j");
				const text = overlay.render(80).join("\n");
				expect(text).toContain("invalid");
				expect(text).toContain("not valid JSON");
			} finally {
				overlay.dispose();
			}
		});
	});

	test("? toggles the help screen", () => {
		withTempProject((cwd, lensesRoot) => {
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			try {
				overlay.handleInput("?");
				const helpText = overlay.render(80).join("\n");
				expect(helpText).toContain("Observatory — keys");
				overlay.handleInput("?");
				const backText = overlay.render(80).join("\n");
				expect(backText).not.toContain("Observatory — keys");
			} finally {
				overlay.dispose();
			}
		});
	});

	test("q invokes the done callback", () => {
		withTempProject((cwd, lensesRoot) => {
			let exits = 0;
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {
					exits++;
				},
			);
			try {
				overlay.handleInput("q");
				expect(exits).toBe(1);
			} finally {
				overlay.dispose();
			}
		});
	});

	test("dispose stops the watcher cleanly", () => {
		withTempProject((cwd, lensesRoot) => {
			const overlay = new ObservatoryOverlay(
				makeTui() as never,
				stubTheme as never,
				cwd,
				lensesRoot,
				() => {},
			);
			expect(() => overlay.dispose()).not.toThrow();
			// Calling dispose twice should also not throw.
			expect(() => overlay.dispose()).not.toThrow();
		});
	});
});
