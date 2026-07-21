/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, typescript/explicit-function-return-type, eslint/require-await, unicorn/prefer-event-target, promise/param-names, promise/no-multiple-resolved */
/**
 * Intent: prove `dist/daemon.js` boots under a launchd-shaped minimal
 * environment. Under launchd the daemon runs with an all-but-empty env
 * (PATH=/usr/bin:/bin, HOME=<user>, closed stdin, no TTY). Bug 5 in the
 * PR6b live retry was exactly this: manual run worked, launchd run hung
 * at 6 FDs with server.listen() never firing.
 *
 * This test spawns the bundled daemon with that minimal env and asserts
 * the ready line lands on stdout within 3 seconds. It also asserts that
 * on a boot-time throw, the try/catch guard prints `[daemon-boot] fatal:`
 * on stderr and exits non-zero — otherwise launchd's KeepAlive=true just
 * respawns silently forever.
 *
 * Adversarial:
 *   - Remove the try/catch → the fail-loud subtest observes a hang or a
 *     non-1 exit code and trips.
 *   - Add a keychain touch (SecurityCliTokenStore.get) to the boot path →
 *     `security` will hang under a non-GUI launchd context; even in this
 *     unit test (interactive shell, keychain unlocked) an extra keychain
 *     round-trip lengthens boot and trips a tightened timeout.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const pkgRoot = resolve(import.meta.dirname, "..", "..");

// Match the real entry from scripts/build-daemon.mjs — the module-scope
// wiring the bundler ships. Kept in sync manually; the parallel test in
// build-daemon.test.ts already pins that the emitted artifact is a
// runnable Node script (shebang + +x). This test proves the RUNTIME
// behaviour of the same wiring.
const realEntry = `
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_VERSION } from "./src/index.ts";
import { start } from "./src/http-bridge/server.ts";
import { FsChoiceStore } from "./src/cli-shim/choice-store.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { SecurityCliTokenStore } from "./src/cli-shim/token-store.ts";
import { verifyToken } from "./src/oauth/verify.ts";
import { flagOn } from "./src/oauth/provisioning.ts";

function bootLog(step) {
	try { process.stderr.write(\`[daemon-boot] step=\${step}\\n\`); } catch {}
}

const execFileAsync = promisify(execFile);
const verifyExec = async (file, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(file, args, {
			env: options.env,
			timeout: options.timeoutMs,
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (error) {
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			exitCode: error.code ?? 1,
			error,
		};
	}
};

bootLog("imports-loaded");
const claudeRealPath = process.env.CMA_CLAUDE_REAL_PATH ?? "/nowhere/claude.real";
bootLog("construct-stores");
const tokenStore = new SecurityCliTokenStore();
const choiceStore = new FsChoiceStore();

const verifyAccount = async (uuid) => {
	const reg = await readRegistry();
	if (reg === undefined) return { ok: false, reason: "not_found", detail: "no registry" };
	const account = reg.accounts.find((a) => a.uuid === uuid);
	if (account === undefined) return { ok: false, reason: "not_found", detail: "no such account" };
	let stored;
	try { stored = await tokenStore.get(account.uuid); }
	catch (error) {
		return { ok: true, verify: { ok: false, kind: "unauthorized", detail: String(error) }, needsRefresh: true };
	}
	const verify = await verifyToken({ token: stored, claudeRealPath, exec: verifyExec });
	return { ok: true, verify, needsRefresh: !verify.ok && verify.kind === "unauthorized" };
};
const listAccounts = async () => (await readRegistry())?.accounts ?? [];
const flag = flagOn(process.env);

try {
	bootLog("start-listen");
	const { port } = await start({ listAccounts, verifyAccount, choiceStore, flagOn: flag, version: PACKAGE_VERSION });
	bootLog("listening");
	process.stdout.write(JSON.stringify({ ready: true, port, pid: process.pid }) + "\\n");
	bootLog("ready");
} catch (error) {
	const detail = error && error.stack ? error.stack : String(error);
	try { process.stderr.write(\`[daemon-boot] fatal: \${detail}\\n\`); } catch {}
	process.exit(1);
}
`;

async function bundle(entry: string): Promise<string> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "cma-daemonboot-"));
	const outfile = join(tmpRoot, "daemon.js");
	await mkdir(dirname(outfile), { recursive: true });
	await esbuild.build({
		stdin: { contents: entry, resolveDir: pkgRoot, loader: "ts" },
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node26",
		sourcemap: "inline",
		banner: { js: "#!/usr/bin/env node" },
		logLevel: "silent",
	});
	chmodSync(outfile, 0o755);
	return outfile;
}

describe("daemon boot under launchd-shaped minimal env", () => {
	let realDaemon: string;

	beforeAll(async () => {
		realDaemon = await bundle(realEntry);
	}, 30_000);

	it("prints {ready:true,...} to stdout within 3s under PATH=/usr/bin:/bin, HOME=<tmp>, no ENABLE_SHIM, stdin closed", async () => {
		const home = await mkdtemp(join(tmpdir(), "cma-daemonboot-home-"));
		const child = spawn(process.execPath, [realDaemon], {
			env: { PATH: "/usr/bin:/bin", HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const gotReady = await new Promise<boolean>((resolveReady) => {
			const onStdout = (b: Buffer): void => {
				stdout += b.toString("utf8");
				if (stdout.includes(`"ready":true`)) {
					child.stdout.off("data", onStdout);
					clearTimeout(to);
					resolveReady(true);
				}
			};
			const to = setTimeout(() => {
				child.stdout.off("data", onStdout);
				resolveReady(false);
			}, 3000);
			child.stdout.on("data", onStdout);
			child.stderr.on("data", (b: Buffer) => {
				stderr += b.toString("utf8");
			});
		});
		child.kill("SIGTERM");
		if (!gotReady) {
			throw new Error(
				`daemon did not print ready line within 3s. stderr=${stderr} stdout=${stdout}`,
			);
		}
		expect(stdout).toMatch(/"ready":true/u);
		// Boot breadcrumbs prove the diagnostic trail future launchd runs need.
		expect(stderr).toContain("[daemon-boot] step=listening");
	}, 10_000);

	it("boot-time throw → try/catch prints `[daemon-boot] fatal:` on stderr + exits 1 (fail loud, not silent hang)", async () => {
		// Same shape as realEntry but replaces the start() call with a throw.
		const throwEntry = realEntry.replace(
			`const { port } = await start({ listAccounts, verifyAccount, choiceStore, flagOn: flag, version: PACKAGE_VERSION });`,
			`throw new Error("simulated boot fault");`,
		);
		const throwDaemon = await bundle(throwEntry);
		const result = spawnSync(process.execPath, [throwDaemon], {
			env: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("[daemon-boot] fatal:");
		expect(result.stderr).toContain("simulated boot fault");
	}, 30_000);
});
