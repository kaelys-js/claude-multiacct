/**
 * `@foundation/claude-multiacct` — loopback HTTP bridge server.
 *
 * Binds `127.0.0.1:0` (kernel-assigned port), mints a fresh shared secret
 * on every start, and writes both to `~/.config/claude-multiacct/bridge.json`
 * (mode `0o600`) so the extension can discover them. Signal handlers
 * (`SIGTERM`, `SIGINT`) close gracefully and remove the handoff file.
 *
 * Single-instance contract: if `bridge.json` exists AND its `pid` is alive,
 * `start()` throws with the existing pid — a second daemon must never
 * clobber the sidecar. If the pid is dead (process crashed without
 * cleanup), the stale sidecar is taken over.
 *
 * Every incoming request goes through:
 *   1. `assertLoopback(remoteAddress)` — bind-drift tripwire.
 *   2. `OPTIONS` preflight → `corsPreflight`.
 *   3. `/health` short-circuit — no auth, so probes work without the secret.
 *   4. `validateAuth` — Origin allowlist + shared-secret header.
 *   5. `dispatch` — route to a pure handler in `./routes.ts`.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "../domain/account.ts";
import type { ChoiceStore } from "../ports.ts";
import { atomicWriteJson } from "./atomic-json.ts";
import { dispatch, type RouteDeps, type RouteResult, type VerifyAccountFn } from "./routes.ts";
import {
	assertLoopback,
	BRIDGE_SECRET_HEADER,
	corsPreflight,
	isAllowedOrigin,
	validateAuth,
} from "./security.ts";

/**
 * Default on-disk location for the port+secret handoff file.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/bridge.json`.
 */
export function defaultBridgeJsonPath(): string {
	return join(homedir(), ".config", "claude-multiacct", "bridge.json");
}

/** Injected deps `start()` takes. */
export type StartOptions = {
	listAccounts: () => Promise<Account[]>;
	verifyAccount: VerifyAccountFn;
	choiceStore: Pick<ChoiceStore, "write">;
	flagOn: boolean;
	version: string;
	/** Override the bridge.json path for tests. */
	bridgeJsonPath?: string;
	/** Override host for tests. */
	host?: string;
	/** Override kill-check (default `process.kill(pid, 0)`). Test injects. */
	isPidAlive?: (pid: number) => boolean;
	/** Override `process.exit` for SIGTERM/SIGINT paths. Test injects. */
	exit?: (code: number) => void;
};

/** `start()` result. `close()` gracefully shuts down. */
export type StartResult = {
	port: number;
	secret: string;
	secretRotatedAt: string;
	close: () => Promise<void>;
};

/** JSON shape written to bridge.json. */
export type BridgeManifest = {
	port: number;
	secret: string;
	pid: number;
	startedAt: string;
	version: string;
};

/**
 * Real `isPidAlive` check via `process.kill(pid, 0)`. Exported so tests
 * can exercise the true/false branches without needing the daemon path.
 *
 * @param {number} pid - Process id to probe.
 * @returns {boolean} True if the pid is alive OR exists but we lack permission
 *   to signal it (EPERM). False on ESRCH or any other error.
 */
export function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		// EPERM means the pid exists but we can't signal it — still alive.
		return err.code === "EPERM";
	}
}

/**
 * Return the parsed prior manifest at `path`, or `undefined` if missing /
 * unreadable / unparsable. A corrupted sidecar is treated as "no prior
 * daemon" so the daemon can start; a stale bearer secret would fail auth
 * on every request anyway.
 *
 * @param {string} path - bridge.json path.
 * @returns {Promise<BridgeManifest | undefined>} Prior manifest or undefined.
 */
async function readPriorManifest(path: string): Promise<BridgeManifest | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as BridgeManifest;
	} catch {
		return undefined;
	}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	return await new Promise<unknown>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve(undefined);
				return;
			}
			const raw = Buffer.concat(chunks).toString("utf8");
			try {
				resolve(JSON.parse(raw));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		req.on("error", reject);
	});
}

function writeJson(
	res: ServerResponse,
	result: RouteResult,
	extraHeaders: Record<string, string> = {},
): void {
	res.writeHead(result.status, {
		"content-type": "application/json; charset=utf-8",
		...extraHeaders,
	});
	res.end(JSON.stringify(result.body));
}

/**
 * Compose the request handler. Extracted so tests can bind it against a
 * synthetic `IncomingMessage`/`ServerResponse` if ever needed; today only
 * the socket wiring uses it.
 *
 * @param {RouteDeps} routeDeps - Injected ports for `dispatch`.
 * @param {string} expectedSecret - Shared secret required on non-health requests.
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>} Node http handler.
 */
function makeRequestHandler(
	routeDeps: RouteDeps,
	expectedSecret: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		/* c8 ignore start -- assertLoopback catch is unreachable while
		   `start()` binds loopback; defensive tripwire against a future
		   mis-bind refactor. */
		try {
			assertLoopback(req.socket.remoteAddress);
		} catch (error) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end((error as Error).message);
			return;
		}
		/* c8 ignore stop */
		const originRaw = req.headers.origin;
		/* c8 ignore next -- Node normalizes Origin to a single string in
		   practice; the array branch is defensive for the type signature. */
		const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
		/* c8 ignore next -- req.method is always set by node:http for a
		   real incoming request. */
		const { method = "GET" } = req;
		/* c8 ignore next -- req.url is always set by node:http for a real request. */
		const { pathname } = new URL(req.url ?? "/", "http://loopback");

		if (method === "OPTIONS") {
			if (origin === undefined || !isAllowedOrigin(origin)) {
				res.writeHead(403, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: false, reason: "origin not allowed" }));
				return;
			}
			const pf = corsPreflight(origin);
			res.writeHead(pf.status, pf.headers);
			res.end();
			return;
		}

		// /health is deliberately no-auth: launchd readiness probes and
		// the extension's boot-time check both need it before they have
		// the secret in hand.
		if (method === "GET" && pathname === "/health") {
			const result = await dispatch({ method, pathname }, routeDeps);
			writeJson(
				res,
				result,
				isAllowedOrigin(origin) ? { "access-control-allow-origin": origin as string } : {},
			);
			return;
		}

		const authResult = validateAuth({
			origin,
			secretHeader: req.headers[BRIDGE_SECRET_HEADER] as string | undefined,
			expectedSecret,
		});
		if (!authResult.ok) {
			res.writeHead(authResult.status, { "content-type": "application/json" });
			res.end(JSON.stringify(authResult.body));
			return;
		}

		let body: unknown;
		if (method === "POST" || method === "PUT" || method === "PATCH") {
			try {
				body = await readBody(req);
			} catch (error) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ ok: false, reason: `invalid JSON body: ${(error as Error).message}` }),
				);
				return;
			}
		}

		const result = await dispatch({ method, pathname, body }, routeDeps);
		writeJson(res, result, { "access-control-allow-origin": origin as string });
	};
}

/**
 * Start the bridge daemon. Refuses to start if `bridge.json` names a live
 * pid; takes over a stale sidecar. Registers `SIGTERM`/`SIGINT` handlers
 * for graceful shutdown.
 *
 * @param {StartOptions} opts - Injected ports + overrides.
 * @returns {Promise<StartResult>} Bound port, minted secret, and `close()`.
 */
export async function start(opts: StartOptions): Promise<StartResult> {
	/* c8 ignore next 2 -- defaults exercised through the exported
	   defaultBridgeJsonPath test + a real-daemon path we don't spin up in unit tests. */
	const bridgeJsonPath = opts.bridgeJsonPath ?? defaultBridgeJsonPath();
	const host = opts.host ?? "127.0.0.1";
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

	const prior = await readPriorManifest(bridgeJsonPath);
	if (prior !== undefined && typeof prior.pid === "number" && isPidAlive(prior.pid)) {
		throw new Error(
			`bridge daemon already running with pid ${String(prior.pid)} (sidecar: ${bridgeJsonPath})`,
		);
	}

	const secret = randomBytes(32).toString("base64url");
	const secretRotatedAt = new Date().toISOString();

	const routeDeps: RouteDeps = {
		listAccounts: opts.listAccounts,
		verifyAccount: opts.verifyAccount,
		choiceStore: opts.choiceStore,
		flagOn: opts.flagOn,
		version: opts.version,
		port: 0, // filled after listen
		secretRotatedAt,
	};

	const handler = makeRequestHandler(routeDeps, secret);
	const server: Server = createServer((req, res) => {
		(async (): Promise<void> => {
			try {
				await handler(req, res);
			} catch (error: unknown) {
				res.writeHead(500, { "content-type": "text/plain" });
				res.end((error as Error).message);
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	/* c8 ignore next 4 -- AddressInfo is always an object for tcp `listen`; the
	   string/null branch is only reachable for unix-socket binds we never use. */
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("bridge server: expected AddressInfo, got string/null");
	}
	const { port } = address;
	routeDeps.port = port;

	const manifest: BridgeManifest = {
		port,
		secret,
		pid: process.pid,
		startedAt: secretRotatedAt,
		version: opts.version,
	};
	await atomicWriteJson(bridgeJsonPath, manifest, 0o600);

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) {
			return;
		}
		closed = true;
		process.removeListener("SIGTERM", sigHandler);
		process.removeListener("SIGINT", sigHandler);
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		try {
			await unlink(bridgeJsonPath);
		} catch {
			// Sidecar already gone — fine.
		}
	};
	/* c8 ignore next 2 -- default exit is process.exit; tests inject a spy. */
	// eslint-disable-next-line unicorn/no-process-exit -- launchd graceful shutdown requires immediate process termination
	const exit = opts.exit ?? ((code: number): void => process.exit(code));
	const sigHandler = (): void => {
		(async (): Promise<void> => {
			await close();
			exit(0);
		})();
	};
	process.on("SIGTERM", sigHandler);
	process.on("SIGINT", sigHandler);

	return { port, secret, secretRotatedAt, close };
}
