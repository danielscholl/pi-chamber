// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { existsSync, readFileSync } from "node:fs";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import { createServer as createHttpServer } from "node:http";
// biome-ignore lint/suspicious/noTsIgnore: Project runtime provides Node built-ins; this workspace does not install @types/node.
// @ts-ignore
import path from "node:path";
import {
	type DiscoveryEntry,
	discoverLenses,
	resolveDataFilePath,
} from "./core.ts";

// Bun is provided by the runtime when Pi runs under Bun. Under Node it is undefined,
// in which case we fall back to node:http.
// biome-ignore lint/suspicious/noExplicitAny: Bun runtime types are not installed.
declare const Bun: any;

export interface ObservatoryServer {
	url: string;
	port: number;
	hostname: string;
	stop: (closeActiveConnections?: boolean) => void;
}

export interface StartObservatoryServerOptions {
	lensesRoot: string;
	port: number;
	hostname: string;
	rendererHtml: string;
}

type FetchHandler = (req: Request) => Promise<Response>;
type ServerStarter = (
	port: number,
	hostname: string,
	fetch: FetchHandler,
) => Promise<ObservatoryServer>;

const DATA_ROUTE_PATTERN = /^\/api\/lenses\/([^/]+)\/data\/?$/;

export async function startObservatoryServer(
	opts: StartObservatoryServerOptions,
): Promise<ObservatoryServer> {
	const fetch = makeFetchHandler(opts);
	const start: ServerStarter =
		typeof Bun !== "undefined" ? startBunServer : startNodeServer;

	try {
		return await start(opts.port, opts.hostname, fetch);
	} catch (error) {
		if (opts.port !== 0 && isAddressInUse(error)) {
			return await start(0, opts.hostname, fetch);
		}
		throw error;
	}
}

function startBunServer(
	port: number,
	hostname: string,
	fetch: FetchHandler,
): Promise<ObservatoryServer> {
	const server = Bun.serve({ port, hostname, fetch });
	const boundPort: number = server.port;
	const boundHost: string = server.hostname ?? hostname;
	return Promise.resolve({
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		stop: (closeActiveConnections = true) => {
			try {
				server.stop(closeActiveConnections);
			} catch {
				// ignore double-stop
			}
		},
	});
}

function startNodeServer(
	port: number,
	hostname: string,
	fetch: FetchHandler,
): Promise<ObservatoryServer> {
	return new Promise((resolve, reject) => {
		// biome-ignore lint/suspicious/noExplicitAny: node:http types are not installed at edit time.
		const server: any = createHttpServer(
			// biome-ignore lint/suspicious/noExplicitAny: node:http types are not installed at edit time.
			(req: any, res: any) => {
				void handleNodeRequest(req, res, hostname, fetch);
			},
		);

		const onError = (error: unknown) => {
			server.removeListener("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.removeListener("error", onError);
			const addr = server.address();
			const boundPort: number =
				addr && typeof addr === "object" ? addr.port : port;
			resolve({
				url: `http://${hostname}:${boundPort}`,
				port: boundPort,
				hostname,
				stop: (closeActiveConnections = true) => {
					try {
						if (closeActiveConnections) {
							server.closeAllConnections?.();
						}
						server.close();
					} catch {
						// ignore double-stop
					}
				},
			});
		};

		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, hostname);
	});
}

async function handleNodeRequest(
	// biome-ignore lint/suspicious/noExplicitAny: node:http types are not installed at edit time.
	req: any,
	// biome-ignore lint/suspicious/noExplicitAny: node:http types are not installed at edit time.
	res: any,
	hostname: string,
	fetch: FetchHandler,
): Promise<void> {
	try {
		const url = `http://${req.headers.host ?? hostname}${req.url ?? "/"}`;
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (Array.isArray(value)) {
				for (const v of value) headers.append(name, String(v));
			} else if (typeof value === "string") {
				headers.set(name, value);
			}
		}
		const request = new Request(url, {
			method: req.method ?? "GET",
			headers,
		});
		const response = await fetch(request);
		res.statusCode = response.status;
		response.headers.forEach((value: string, key: string) => {
			res.setHeader(key, value);
		});
		const buffer = Buffer.from(await response.arrayBuffer());
		res.end(req.method === "HEAD" ? undefined : buffer);
	} catch (error) {
		try {
			res.statusCode = 500;
			res.setHeader("content-type", "application/json; charset=utf-8");
			res.end(JSON.stringify({ error: errorMessage(error) }));
		} catch {
			// best-effort error reporting
		}
	}
}

function isAddressInUse(error: unknown): boolean {
	if (!error) return false;
	const msg = error instanceof Error ? error.message : String(error);
	const codeAttr = (error as { code?: unknown }).code;
	const code = typeof codeAttr === "string" ? codeAttr : "";
	return code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(msg);
}

function makeFetchHandler(opts: StartObservatoryServerOptions) {
	const { lensesRoot, rendererHtml } = opts;

	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const { pathname } = url;
		const method = req.method.toUpperCase();

		if (method !== "GET" && method !== "HEAD") {
			return jsonResponse({ error: "method not allowed" }, 405);
		}

		if (pathname === "/" || pathname === "/index.html") {
			return new Response(rendererHtml, {
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		}

		if (pathname === "/api/lenses" || pathname === "/api/lenses/") {
			const entries = discoverLenses(lensesRoot);
			return jsonResponse({ lenses: entries.map(serializeEntry) }, 200);
		}

		const dataMatch = DATA_ROUTE_PATTERN.exec(pathname);
		if (dataMatch) {
			return handleDataRequest(lensesRoot, dataMatch[1]);
		}

		return jsonResponse({ error: "not found" }, 404);
	};
}

function handleDataRequest(lensesRoot: string, id: string): Response {
	const entries = discoverLenses(lensesRoot);
	const entry = entries.find((e) => e.id === id);
	if (!entry) {
		return jsonResponse({ error: `lens not found: ${id}` }, 404);
	}
	if (entry.status === "invalid") {
		return jsonResponse(
			{ error: `lens is invalid: ${entry.reason}` },
			400,
		);
	}

	let dataPath: string;
	try {
		dataPath = resolveDataFilePath(lensesRoot, id, entry.manifest.source);
	} catch (error) {
		return jsonResponse(
			{ error: errorMessage(error) },
			400,
		);
	}

	if (!existsSync(dataPath)) {
		return jsonResponse(
			{ error: `data file not found: ${path.basename(dataPath)}` },
			404,
		);
	}

	let raw: string;
	try {
		raw = readFileSync(dataPath, "utf-8");
	} catch (error) {
		return jsonResponse(
			{ error: `cannot read data file: ${errorMessage(error)}` },
			500,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return jsonResponse(
			{ error: `data file is not valid JSON: ${errorMessage(error)}` },
			500,
		);
	}

	return jsonResponse({ data: parsed }, 200);
}

function serializeEntry(entry: DiscoveryEntry): Record<string, unknown> {
	if (entry.status === "ok") {
		return {
			id: entry.id,
			status: "ok",
			manifest: entry.manifest,
		};
	}
	return {
		id: entry.id,
		status: "invalid",
		reason: entry.reason,
	};
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
