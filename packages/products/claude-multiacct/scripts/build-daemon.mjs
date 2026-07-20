/**
 * `@foundation/claude-multiacct` — bridge daemon bundler.
 *
 * Produces `dist/daemon.js`: a single self-contained ESM Node script that
 * launchd invokes as the long-lived bridge daemon. Mirrors `build-shim.mjs`
 * + `build-watcher.mjs`: the entry lives inline (esbuild `stdin`) so the
 * src/ tree stays import-only and vitest coverage — which globs
 * `packages/**\/src/**\/*.ts` — doesn't demand tests for a wiring-only
 * bootstrap.
 *
 * Entry behavior:
 *   - `CMA_DAEMON_SELFTEST=1` → print `cma-daemon selftest OK <version>`
 *     and exit 0. Zero disk touch, no socket bind. This is what the build
 *     test execs post-bundle to prove the emitted artifact is runnable.
 *   - Otherwise → build real ports (readRegistry, FsChoiceStore,
 *     SecurityCliTokenStore, verifyToken bound with a spawn-shaped exec),
 *     call `start()`, print `{ready:true,port,pid}` on stdout, and wait.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/daemon.js");

const entryContents = `
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_VERSION } from "./src/index.ts";
import { start } from "./src/http-bridge/server.ts";
import { FsChoiceStore } from "./src/cli-shim/choice-store.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { SecurityCliTokenStore } from "./src/cli-shim/token-store.ts";
import { verifyToken } from "./src/oauth/verify.ts";
import { flagOn } from "./src/oauth/provisioning.ts";

if (process.env.CMA_DAEMON_SELFTEST === "1") {
	process.stdout.write(\`cma-daemon selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const execFileAsync = promisify(execFile);

// Bind a verify-shaped exec around child_process.execFile. Same shape as
// the injected surface in src/oauth/verify.ts's tests, so daemon runs
// against the real subprocess without patched globals.
const verifyExec = async (file, args, options) => {
	try {
		const { stdout, stderr } = await execFileAsync(file, args, {
			env: options.env,
			timeout: options.timeoutMs,
		});
		return { stdout, stderr, exitCode: 0 };
	} catch (error) {
		const err = error;
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			exitCode: err.code ?? 1,
			error: err,
		};
	}
};

const claudeRealPath = process.env.CMA_CLAUDE_REAL_PATH
	?? "/Applications/Claude.app/Contents/Resources/app.asar.unpacked/claude-code/claude/claude.app/Contents/MacOS/claude.real";

const tokenStore = new SecurityCliTokenStore();
const choiceStore = new FsChoiceStore();

const verifyAccount = async (uuid) => {
	const reg = await readRegistry();
	if (reg === undefined) return { ok: false, reason: "not_found", detail: "no registry" };
	const account = reg.accounts.find((a) => a.uuid === uuid);
	if (account === undefined) return { ok: false, reason: "not_found", detail: "no such account" };
	let stored;
	try {
		stored = await tokenStore.get(account.uuid);
	} catch (error) {
		return { ok: true, verify: { ok: false, kind: "unauthorized", detail: String(error) }, needsRefresh: true };
	}
	const verify = await verifyToken({ token: stored, claudeRealPath, exec: verifyExec });
	const needsRefresh = !verify.ok && verify.kind === "unauthorized";
	return { ok: true, verify, needsRefresh };
};

const listAccounts = async () => {
	const reg = await readRegistry();
	return reg?.accounts ?? [];
};

const flag = flagOn(process.env);

const { port } = await start({
	listAccounts,
	verifyAccount,
	choiceStore,
	flagOn: flag,
	version: PACKAGE_VERSION,
});

process.stdout.write(JSON.stringify({ ready: true, port, pid: process.pid }) + "\\n");
`;

mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
	stdin: { contents: entryContents, resolveDir: pkgRoot, loader: "ts" },
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node26",
	sourcemap: "inline",
	banner: { js: "#!/usr/bin/env node" },
	logLevel: "warning",
});

chmodSync(outfile, 0o755);
