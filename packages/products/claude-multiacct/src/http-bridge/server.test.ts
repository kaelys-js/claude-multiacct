/**
 * Intent: pin the daemon's whole lifecycle contract with real sockets +
 * real files so the failure modes we care about (world-readable
 * bridge.json, two daemons racing, sidecar left over on shutdown,
 * reused secret across restarts) all trip loud.
 *
 *  - `bridge.json` mode is exactly `0o600`. Adversarial: relax the
 *    `atomicWriteJson` mode arg → this test flips red because a
 *    world-readable secret is a security bug.
 *  - Two starts on the same sidecar → different secrets. Adversarial:
 *    persist the secret across restarts → RED.
 *  - `close()` removes the sidecar. Adversarial: skip the unlink → RED
 *    because a stale sidecar would look like a live daemon.
 *  - Refuses to start when the prior pid is alive. Injected
 *    `isPidAlive: () => true` proves the check runs BEFORE we mint a
 *    new secret.
 *  - Takes over a stale sidecar when the prior pid is dead
 *    (`isPidAlive: () => false`). Otherwise a crash leaves the daemon
 *    permanently un-startable.
 *  - `SIGTERM` path is exercised via a `close()` proxy: the signal
 *    handler is registered on start (assert with process.listenerCount)
 *    and removed on close.
 */

import { readFile, stat, mkdtemp, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultBridgeJsonPath, defaultIsPidAlive, start } from "./server.ts";

function findBridgeLog(spy: { mock: { calls: unknown[][] } }): string | undefined {
	for (const call of spy.mock.calls) {
		const [first] = call;
		if (typeof first === "string" && first.startsWith("[bridge] ")) {
			return first;
		}
	}
	return undefined;
}

function bridgeLogsContain(spy: { mock: { calls: unknown[][] } }, needle: string): boolean {
	return spy.mock.calls.some((call) => {
		const [first] = call;
		return typeof first === "string" && first.startsWith("[bridge] ") && first.includes(needle);
	});
}

async function scratchPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cma-server-"));
	return join(dir, "bridge.json");
}

const noopDeps = {
	listAccounts: (): Promise<never[]> => Promise.resolve([]),
	verifyAccount: (): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
	choiceStore: { write: (): Promise<void> => Promise.resolve() },
	flagOn: true,
	version: "0.0.0",
};

// Track anything we start so we can close it even if a test fails partway.
const alive: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	while (alive.length > 0) {
		const s = alive.pop()!;
		try {
			await s.close();
		} catch {
			// ignore; test cleanup path
		}
	}
});

describe("start", () => {
	it("defaultBridgeJsonPath resolves under ~/.config/claude-multiacct", () => {
		expect(defaultBridgeJsonPath()).toMatch(/\.config\/claude-multiacct\/bridge\.json$/u);
	});

	it("defaultIsPidAlive → true for the current pid, false for a made-up dead pid", () => {
		expect(defaultIsPidAlive(process.pid)).toBe(true);
		// PID 2^30 is well outside any realistic pid range → ESRCH.
		expect(defaultIsPidAlive(1_073_741_823)).toBe(false);
	});

	it("binds a random loopback port and writes bridge.json mode 0o600", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		expect(s.port).toBeGreaterThan(0);
		const st = await stat(path);
		// eslint-disable-next-line no-bitwise -- extracting POSIX mode bits requires bitmask
		const mode = st.mode & 0o777;
		expect(mode).toBe(0o600);
		const parsed = JSON.parse(await readFile(path, "utf8")) as {
			port: number;
			secret: string;
			pid: number;
			version: string;
		};
		expect(parsed.port).toBe(s.port);
		expect(parsed.secret).toBe(s.secret);
		expect(parsed.pid).toBe(process.pid);
		expect(parsed.version).toBe("0.0.0");
		expect(parsed.secret.length).toBeGreaterThan(20);
	});

	it("rotates secret across restarts (adversarial: persist secret → RED)", async () => {
		const path = await scratchPath();
		const s1 = await start({ ...noopDeps, bridgeJsonPath: path });
		const secret1 = s1.secret;
		await s1.close();
		const s2 = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s2);
		expect(s2.secret).not.toBe(secret1);
	});

	it("close() removes bridge.json (adversarial: skip unlink → RED)", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		await s.close();
		await expect(stat(path)).rejects.toThrow(/ENOENT/u);
	});

	it("refuses second start when prior pid is alive (double-check via isPidAlive)", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		await expect(
			start({ ...noopDeps, bridgeJsonPath: path, isPidAlive: () => true }),
		).rejects.toThrow(/already running/u);
	});

	it("takes over a stale sidecar (prior pid dead)", async () => {
		const path = await scratchPath();
		// Seed a stale sidecar directly on disk.
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				port: 1,
				secret: "old",
				pid: 999_999,
				startedAt: "2020-01-01T00:00:00Z",
				version: "0.0.0",
			}),
		);
		const s = await start({
			...noopDeps,
			bridgeJsonPath: path,
			isPidAlive: () => false,
		});
		alive.push(s);
		expect(s.secret).not.toBe("old");
	});

	it("close() removes SIGTERM/SIGINT listeners (leak → RED under repeated start/close)", async () => {
		const before = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") };
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		expect(process.listenerCount("SIGTERM")).toBe(before.term + 1);
		expect(process.listenerCount("SIGINT")).toBe(before.int + 1);
		await s.close();
		expect(process.listenerCount("SIGTERM")).toBe(before.term);
		expect(process.listenerCount("SIGINT")).toBe(before.int);
	});

	it("close() is idempotent (second call is a no-op)", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		await s.close();
		await expect(s.close()).resolves.toBeUndefined();
	});

	it("GET /health returns 200 with version/port/secretRotatedAt WITHOUT the secret header", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path, version: "1.2.3" });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/health`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			version: string;
			port: number;
			secretRotatedAt: string;
		};
		expect(body.ok).toBe(true);
		expect(body.version).toBe("1.2.3");
		expect(body.port).toBe(s.port);
		expect(body.secretRotatedAt).toBe(s.secretRotatedAt);
	});

	it("GET /health with no Origin still returns 200 (health is unauthenticated)", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		// undici includes a default Origin for cross-origin; use a raw
		// HTTP request to omit it.
		const raw = await new Promise<string>((resolve, reject) => {
			const req = http.request(
				{ host: "127.0.0.1", port: s.port, path: "/health", method: "GET" },
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () =>
						resolve(`${String(res.statusCode)}:${Buffer.concat(chunks).toString("utf8")}`),
					);
				},
			);
			req.on("error", reject);
			req.end();
		});
		expect(raw.startsWith("200:")).toBe(true);
	});

	it("GET /accounts requires the secret header — missing → 401", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			headers: { origin: "https://claude.ai" },
		});
		expect(res.status).toBe(401);
	});

	it("GET /accounts foreign Origin → 403", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			headers: { origin: "https://evil.example.com", "x-cma-bridge-secret": s.secret },
		});
		expect(res.status).toBe(403);
	});

	it("GET /accounts with allowed Origin + secret → 200 and echoes accounts", async () => {
		const path = await scratchPath();
		const s = await start({
			...noopDeps,
			bridgeJsonPath: path,
			listAccounts: () =>
				Promise.resolve([
					{
						uuid: "11111111-1111-4111-8111-111111111111",
						label: "a",
						isPrimary: true,
						encryptedTokenRef: "kc:ref",
						subscriptionType: "pro",
						rateLimitTier: "tier1",
					},
				] as never),
		});
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			headers: { origin: "https://claude.ai", "x-cma-bridge-secret": s.secret },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { accounts: unknown[] };
		expect(body.accounts).toHaveLength(1);
	});

	it("OPTIONS preflight from an allowed Origin → 204 with cors headers", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			method: "OPTIONS",
			headers: { origin: "https://claude.ai" },
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
	});

	it("OPTIONS preflight from a foreign Origin → 403", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			method: "OPTIONS",
			headers: { origin: "https://evil.example.com" },
		});
		expect(res.status).toBe(403);
	});

	it("POST /choice/:uuid with flag-off → 403 skipped:true", async () => {
		const path = await scratchPath();
		const write = vi.fn<() => Promise<void>>(() => Promise.resolve());
		const s = await start({
			...noopDeps,
			bridgeJsonPath: path,
			flagOn: false,
			choiceStore: { write },
		});
		alive.push(s);
		const res = await fetch(
			`http://127.0.0.1:${String(s.port)}/choice/22222222-2222-4222-8222-222222222222`,
			{
				method: "POST",
				headers: {
					origin: "https://claude.ai",
					"x-cma-bridge-secret": s.secret,
					"content-type": "application/json",
				},
				body: JSON.stringify({ accountUuid: "11111111-1111-4111-8111-111111111111" }),
			},
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { skipped: boolean; reason: string };
		expect(body.skipped).toBe(true);
		expect(body.reason).toBe("flag-off");
		expect(write).not.toHaveBeenCalled();
	});

	it("POST with empty body → dispatch sees body=undefined (400 for /choice)", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(
			`http://127.0.0.1:${String(s.port)}/choice/22222222-2222-4222-8222-222222222222`,
			{
				method: "POST",
				headers: {
					origin: "https://claude.ai",
					"x-cma-bridge-secret": s.secret,
					"content-length": "0",
				},
			},
		);
		// Body missing → valibot rejects it as invalid body shape → 400.
		expect(res.status).toBe(400);
	});

	it("POST /choice/:uuid with malformed JSON body → 400", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(
			`http://127.0.0.1:${String(s.port)}/choice/22222222-2222-4222-8222-222222222222`,
			{
				method: "POST",
				headers: {
					origin: "https://claude.ai",
					"x-cma-bridge-secret": s.secret,
					"content-type": "application/json",
				},
				body: "not json",
			},
		);
		expect(res.status).toBe(400);
	});

	it("SIGTERM handler triggers close() and calls injected exit(0)", async () => {
		const path = await scratchPath();
		const exit = vi.fn<(code: number) => void>();
		const s = await start({ ...noopDeps, bridgeJsonPath: path, exit });
		process.emit("SIGTERM");
		// SIGTERM handler is async; wait a tick for close() + exit()
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		expect(exit).toHaveBeenCalledWith(0);
		// close() already ran inside sigHandler — pushing to alive so afterEach
		// doesn't error; s.close() is idempotent.
		alive.push(s);
	});

	it("dispatch throwing hits the handler .catch → 500 text response", async () => {
		const path = await scratchPath();
		const s = await start({
			...noopDeps,
			bridgeJsonPath: path,
			listAccounts: () => {
				throw new Error("boom");
			},
		});
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
			headers: { origin: "https://claude.ai", "x-cma-bridge-secret": s.secret },
		});
		expect(res.status).toBe(500);
		expect(await res.text()).toBe("boom");
	});

	it("unknown route → 404", async () => {
		const path = await scratchPath();
		const s = await start({ ...noopDeps, bridgeJsonPath: path });
		alive.push(s);
		const res = await fetch(`http://127.0.0.1:${String(s.port)}/nope`, {
			headers: { origin: "https://claude.ai", "x-cma-bridge-secret": s.secret },
		});
		expect(res.status).toBe(404);
	});

	// Intent: without a per-request log line, PR6b's daemon has zero
	// observability into whether the content_script is actually hitting
	// /accounts. These tests pin that every request emits a single
	// greppable `[bridge] <METHOD> <path> origin=<...> → <status>` line
	// so `tail -f daemon.out.log | grep '\[bridge\]'` shows flow.
	// Adversarial: remove the `res.on("finish", ...)` block in server.ts →
	// all three assertions RED because no such console.log call is ever made.
	describe("per-request access log (observability)", () => {
		it("GET /health → logs `[bridge] GET /health ... → 200`", async () => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			try {
				const path = await scratchPath();
				const s = await start({ ...noopDeps, bridgeJsonPath: path });
				alive.push(s);
				const res = await fetch(`http://127.0.0.1:${String(s.port)}/health`);
				expect(res.status).toBe(200);
				// `res.on("finish")` fires from `res.end()` synchronously in
				// practice, but yield a tick for slow CI.
				await new Promise((resolve) => {
					setImmediate(resolve);
				});
				const line = findBridgeLog(spy);
				expect(line).toBeDefined();
				expect(line).toMatch(/\[bridge\] GET \/health .*→ 200/u);
			} finally {
				spy.mockRestore();
			}
		});

		it("GET /accounts with foreign Origin → logs `→ 403`", async () => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			try {
				const path = await scratchPath();
				const s = await start({ ...noopDeps, bridgeJsonPath: path });
				alive.push(s);
				const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
					headers: { origin: "https://evil.example.com", "x-cma-bridge-secret": s.secret },
				});
				expect(res.status).toBe(403);
				await new Promise((resolve) => {
					setImmediate(resolve);
				});
				const line = findBridgeLog(spy);
				expect(line).toBeDefined();
				expect(line).toMatch(
					/\[bridge\] GET \/accounts .*origin=https:\/\/evil\.example\.com.*→ 403/u,
				);
			} finally {
				spy.mockRestore();
			}
		});

		it("GET /accounts with allowed Origin + secret → logs `→ 200` and never leaks the secret", async () => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			try {
				const path = await scratchPath();
				const s = await start({ ...noopDeps, bridgeJsonPath: path });
				alive.push(s);
				const res = await fetch(`http://127.0.0.1:${String(s.port)}/accounts`, {
					headers: { origin: "https://claude.ai", "x-cma-bridge-secret": s.secret },
				});
				expect(res.status).toBe(200);
				await new Promise((resolve) => {
					setImmediate(resolve);
				});
				const line = findBridgeLog(spy);
				expect(line).toBeDefined();
				expect(line).toMatch(/\[bridge\] GET \/accounts .*origin=https:\/\/claude\.ai.*→ 200/u);
				// Privacy: never log the secret header value.
				expect(bridgeLogsContain(spy, s.secret)).toBe(false);
			} finally {
				spy.mockRestore();
			}
		});
	});
});
