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
	type ObservatoryServer,
	startObservatoryServer,
} from "./server.ts";

const RENDERER_FIXTURE = "<!doctype html><html><body>fixture</body></html>";

function makeLensesRoot(): { cwd: string; lensesRoot: string } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-server-test-"));
	const lensesRoot = path.join(cwd, ".pi", "observatory", "lenses");
	fs.mkdirSync(lensesRoot, { recursive: true });
	return { cwd, lensesRoot };
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

async function withServer(
	lensesRoot: string,
	port: number,
	fn: (server: ObservatoryServer) => Promise<void> | void,
): Promise<void> {
	const server = await startObservatoryServer({
		lensesRoot,
		port,
		hostname: "127.0.0.1",
		rendererHtml: RENDERER_FIXTURE,
	});
	try {
		await fn(server);
	} finally {
		server.stop(true);
	}
}

describe("startObservatoryServer", () => {
	test("serves the renderer HTML at /", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			await withServer(lensesRoot, 0, async (server) => {
				expect(server.port).toBeGreaterThan(0);
				expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

				const res = await fetch(server.url);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toMatch(/text\/html/);
				expect(res.headers.get("cache-control")).toBe("no-store");
				expect(await res.text()).toBe(RENDERER_FIXTURE);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns discovery entries from /api/lenses", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				{ active_minds: 3, top_priority: "ship observatory" },
			);
			writeLens(lensesRoot, "broken", "{ not json");

			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses`);
				expect(res.status).toBe(200);
				expect(res.headers.get("content-type")).toMatch(/application\/json/);
				expect(res.headers.get("cache-control")).toBe("no-store");
				const body = (await res.json()) as { lenses: Array<Record<string, unknown>> };
				expect(body.lenses).toHaveLength(2);
				const operations = body.lenses.find((v) => v.id === "operations");
				const broken = body.lenses.find((v) => v.id === "broken");
				expect(operations?.status).toBe("ok");
				expect(broken?.status).toBe("invalid");
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns parsed JSON for a valid lens's data file", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				{ active_minds: 3, top_priority: "ship observatory" },
			);

			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses/operations/data`);
				expect(res.status).toBe(200);
				const body = (await res.json()) as { data: Record<string, unknown> };
				expect(body.data).toEqual({
					active_minds: 3,
					top_priority: "ship observatory",
				});
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns 404 for an unknown lens id", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses/missing/data`);
				expect(res.status).toBe(404);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/lens not found/);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns 400 when a discovered lens's manifest is invalid", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			writeLens(lensesRoot, "broken", "{ not json");
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses/broken/data`);
				expect(res.status).toBe(400);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/lens is invalid/);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns 404 when the data file is missing", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			writeLens(lensesRoot, "operations", {
				name: "Operations",
				kind: "briefing",
				source: "data.json",
			});
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses/operations/data`);
				expect(res.status).toBe(404);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/data file not found/);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns 500 when the data file is not valid JSON", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			writeLens(
				lensesRoot,
				"operations",
				{ name: "Operations", kind: "briefing", source: "data.json" },
				"{ not json",
			);
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/api/lenses/operations/data`);
				expect(res.status).toBe(500);
				const body = (await res.json()) as { error: string };
				expect(body.error).toMatch(/not valid JSON/);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns 404 for unknown routes", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(`${server.url}/nope`);
				expect(res.status).toBe(404);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects non-GET methods", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			await withServer(lensesRoot, 0, async (server) => {
				const res = await fetch(server.url, { method: "POST" });
				expect(res.status).toBe(405);
			});
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("server.stop releases the bound port", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			const first = await startObservatoryServer({
				lensesRoot,
				port: 0,
				hostname: "127.0.0.1",
				rendererHtml: RENDERER_FIXTURE,
			});
			const port = first.port;
			first.stop(true);

			const second = await startObservatoryServer({
				lensesRoot,
				port,
				hostname: "127.0.0.1",
				rendererHtml: RENDERER_FIXTURE,
			});
			try {
				expect(second.port).toBe(port);
			} finally {
				second.stop(true);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("falls back to an ephemeral port when the configured port is busy", async () => {
		const { cwd, lensesRoot } = makeLensesRoot();
		try {
			const occupant = await startObservatoryServer({
				lensesRoot,
				port: 0,
				hostname: "127.0.0.1",
				rendererHtml: RENDERER_FIXTURE,
			});
			try {
				const fallback = await startObservatoryServer({
					lensesRoot,
					port: occupant.port,
					hostname: "127.0.0.1",
					rendererHtml: RENDERER_FIXTURE,
				});
				try {
					expect(fallback.port).toBeGreaterThan(0);
					expect(fallback.port).not.toBe(occupant.port);
				} finally {
					fallback.stop(true);
				}
			} finally {
				occupant.stop(true);
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
