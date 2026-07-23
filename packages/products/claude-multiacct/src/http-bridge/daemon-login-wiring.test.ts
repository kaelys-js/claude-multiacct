/**
 * Intent: prove the PRODUCTION daemon build wires the in-app OAuth login end to
 * end, so `POST /accounts/login/start` returns a real authorize URL — NOT the
 * 503 `login_unavailable` it would return if `scripts/build-daemon.mjs` forgot
 * to construct the login manager or forgot to pass `loginStart` to `start()`.
 *
 * This is a regression pin for B2 (and, via the daemon-open log line, B1): it
 * builds the actual `dist/daemon.js` with `scripts/build-daemon.mjs`, boots it,
 * and hits the real HTTP surface. Discovery is disabled (CMA_DISABLE_DISCOVERY)
 * so the boot never blocks on a keychain read, and the browser opener is pointed
 * at a harmless no-op binary (CMA_OPEN_BIN) so no real browser launches — while
 * still proving the daemon FIRES the host-side open (its "[login] opening
 * sign-in page in browser" breadcrumb lands on stderr).
 *
 * Adversarial: delete the `loginStart` (or `openUrl`) wiring in build-daemon.mjs
 * and the `login/start` assertion (or the open-breadcrumb assertion) reddens.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkgRoot = join(import.meta.dirname, "..", "..");
const daemonJs = join(pkgRoot, "dist", "daemon.js");

/**
 * Boot the built daemon under a throwaway HOME; resolve once it prints ready.
 *
 * @param {string} home - Throwaway HOME the daemon writes bridge.json/registry under.
 * @returns {Promise<{child: ChildProcess, port: number, stderr: () => string}>}
 *   The child handle, its bound port, and a getter for accumulated stderr.
 */
async function bootDaemon(home: string): Promise<{
	child: ChildProcess;
	port: number;
	stderr: () => string;
}> {
	const child = spawn(process.execPath, [daemonJs], {
		env: {
			...process.env,
			HOME: home,
			CLAUDE_MULTIACCT_ENABLE_SHIM: "1",
			CMA_DISABLE_DISCOVERY: "1",
			// The daemon opens the authorize URL by spawning this binary. `true`
			// accepts any argv and exits 0 — proves the open fires, launches nothing.
			CMA_OPEN_BIN: "/usr/bin/true",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let err = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		err += chunk.toString("utf8");
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => {
			reject(new Error(`daemon never printed ready; stderr:\n${err}`));
		}, 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8");
			const line = out.split("\n").find((l) => l.includes('"ready":true'));
			if (line !== undefined) {
				clearTimeout(timer);
				resolve((JSON.parse(line) as { port: number }).port);
			}
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			reject(new Error(`daemon exited early (${String(code)}); stderr:\n${err}`));
		});
	});
	return { child, port, stderr: () => err };
}

describe("production daemon build wires in-app OAuth login (not 503)", () => {
	let home: string;
	let daemon: Awaited<ReturnType<typeof bootDaemon>> | undefined;

	beforeAll(async () => {
		// Build the REAL dist/daemon.js exactly as the deploy does.
		const build = spawnSync(process.execPath, [join(pkgRoot, "scripts", "build-daemon.mjs")], {
			cwd: pkgRoot,
			encoding: "utf8",
		});
		if (build.status !== 0) {
			throw new Error(`build-daemon.mjs failed: ${build.stderr}`);
		}
		home = await mkdtemp(join(tmpdir(), "cma-daemon-login-"));
		daemon = await bootDaemon(home);
	}, 40_000);

	afterAll(async () => {
		if (daemon !== undefined) {
			daemon.child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				daemon?.child.once("exit", () => resolve());
			});
		}
	});

	it("POST /accounts/login/start → 200 with a real authorizeUrl, and the daemon fires the host-side browser open", async () => {
		const secretRaw = await readFile(
			join(home, ".config", "claude-multiacct", "bridge.json"),
			"utf8",
		);
		const { secret } = JSON.parse(secretRaw) as { secret: string };
		const res = await fetch(`http://127.0.0.1:${String(daemon!.port)}/accounts/login/start`, {
			method: "POST",
			headers: {
				origin: "https://claude.ai",
				"x-cma-bridge-secret": secret,
				"content-type": "application/json",
			},
			body: "{}",
		});
		// The load-bearing assertion: a wired daemon returns 200, NOT 503.
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; loginId: string; authorizeUrl: string };
		expect(body.ok).toBe(true);
		expect(body.loginId).not.toBe("");
		expect(body.authorizeUrl).toContain("oauth/authorize");

		// B1: the daemon opened the URL host-side — its breadcrumb proves the spawn
		// path ran (the renderer never opens; only this Node process can).
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 200);
		});
		expect(daemon!.stderr()).toContain("opening sign-in page in browser");
	}, 20_000);
});
