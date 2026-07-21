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

// Bug 5 (PR6b live retry): the daemon hung silently under launchd with
// 6 FDs and 0 network sockets. server.listen() never fired, nothing
// printed. Two guards land here:
//
//   1. Stderr breadcrumbs before each boot step land in
//      ~/.claude-multiacct/logs/daemon.err.log so the next failure has a
//      diagnosable trace instead of a silent hang.
//   2. try/catch wraps the whole boot: any throw is written to stderr +
//      process.exit(1). Without this a rejected top-level await under
//      launchd (KeepAlive=true) just respawns silently.
//
// The keychain-touching code (SecurityCliTokenStore.get) MUST stay lazy —
// only invoked from a /verify request, never at boot. Under a non-GUI
// launchd context the \`security\` CLI can block on an invisible auth
// prompt, which is the leading hypothesis for the observed hang. The
// construction below only stores the exec fn.
function bootLog(step) {
	try { process.stderr.write(\`[daemon-boot] step=\${step}\\n\`); } catch {}
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

bootLog("imports-loaded");
const claudeRealPath = process.env.CMA_CLAUDE_REAL_PATH
	?? "/Applications/Claude.app/Contents/Resources/app.asar.unpacked/claude-code/claude/claude.app/Contents/MacOS/claude.real";

bootLog("construct-stores");
// Neither constructor touches the keychain — see the block comment above.
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

try {
	bootLog("start-listen");
	const { port } = await start({
		listAccounts,
		verifyAccount,
		choiceStore,
		flagOn: flag,
		version: PACKAGE_VERSION,
	});
	bootLog("listening");
	process.stdout.write(JSON.stringify({ ready: true, port, pid: process.pid }) + "\\n");
	bootLog("ready");
} catch (error) {
	// Rule 12: fail loud. Under launchd KeepAlive=true a silent hang or
	// unhandled rejection would just respawn forever; exiting non-zero with
	// a stderr line lands in daemon.err.log and eventually trips launchd's
	// throttling instead.
	const detail = error && error.stack ? error.stack : String(error);
	try { process.stderr.write(\`[daemon-boot] fatal: \${detail}\\n\`); } catch {}
	process.exit(1);
}
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
