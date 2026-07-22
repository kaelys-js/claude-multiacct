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
import {
	accountTokenShaFrom,
	currentActiveTokenSha,
	tokenShasFromStore,
} from "./src/discovery/active-token.ts";
import { configJsonPath } from "./src/discovery/discover-accounts.ts";
import { makeRealDiscoveryPorts } from "./src/discovery/real-discovery-ports.ts";
import { getPrimary } from "./src/domain/registry.ts";

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

// Ports for the runtime active-account derivation. Reuse the discovery
// bindings (timeout-bounded \`security\` reads + the config.json v10 scanner)
// so /accounts resolves the active account exactly the way discovery reads
// Claude.app's credentials. Only the two read ports are exercised here.
const activeTokenLogger = {
	log: (m) => { try { process.stderr.write("[active-token] " + m + "\\n"); } catch {} },
	warn: (m) => { try { process.stderr.write("[active-token] " + m + "\\n"); } catch {} },
};
const activeTokenPorts = makeRealDiscoveryPorts({ tokenStore, readRegistry, logger: activeTokenLogger });
const claudeConfigJsonPath = configJsonPath(
	(process.env.HOME ?? "") + "/Library/Application Support/Claude",
);

// Resolve the account Claude.app is currently authenticated as. Runs per
// /accounts request (never at boot), so the keychain read stays lazy — under a
// non-GUI launchd context the timeout-bounded read fails closed to undefined
// rather than hanging start(). Any error → undefined (picker hints the first
// account instead of mis-marking one).
const activeAccountUuid = async () => {
	try {
		const reg = await readRegistry();
		if (reg === undefined || reg.accounts.length === 0) return undefined;
		const activeSha = await currentActiveTokenSha({
			readKeychainPassword: activeTokenPorts.readKeychainPassword,
			iterateAppConfigJson: activeTokenPorts.iterateAppConfigJson,
			configJsonPath: claudeConfigJsonPath,
		});
		// Only hash the pool's tokens when there's a live sha to match against.
		// If the active token is unreadable there's nothing to match, and
		// getPrimary falls back to the first account — so skip the token-store
		// reads entirely (they'd otherwise throw on any account missing a
		// keychain entry, collapsing the fallback to undefined).
		const shaByUuid = activeSha === undefined ? new Map() : await tokenShasFromStore(reg, tokenStore);
		const primary = getPrimary(reg, activeSha, accountTokenShaFrom(shaByUuid));
		return primary?.uuid;
	} catch (error) {
		try { process.stderr.write("[active-token] resolve failed: " + String(error) + "\\n"); } catch {}
		return undefined;
	}
};

const flag = flagOn(process.env);

// Auto-detect accounts BEFORE start() so the daemon serves a populated
// registry from request 1. Best-effort: any discovery failure is logged
// + swallowed — the daemon still starts and serves whatever's already
// in the registry.
// Fire-and-forget discovery — do NOT block start(). Under launchd without an
// active GUI session, keychain reads for the \`Claude Safe Storage\` key can
// hang indefinitely waiting on a nowhere-to-render password prompt; blocking
// boot on that means the daemon never serves requests. Run in the background
// with a 30-second timeout; log outcome/timeout to stderr.
(async () => {
	bootLog("discover-run");
	const timeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("discovery timed out after 30s")), 30_000).unref(),
	);
	try {
		const { discoverAccounts } = await import("./src/discovery/discover-accounts.ts");
		const { makeRealDiscoveryPorts } = await import("./src/discovery/real-discovery-ports.ts");
		const ports = makeRealDiscoveryPorts({ tokenStore, readRegistry, logger: {
			log: (m) => { try { process.stderr.write("[discovery] " + m + "\\n"); } catch {} },
			warn: (m) => { try { process.stderr.write("[discovery] " + m + "\\n"); } catch {} },
		}});
		const outcome = await Promise.race([discoverAccounts(ports), timeout]);
		try {
			process.stderr.write("[discovery] scanned mainApp=" + outcome.scanned.mainApp
				+ " cloneApps=" + outcome.scanned.cloneApps
				+ " cliCredentials=" + outcome.scanned.cliCredentials
				+ " registered=" + outcome.registered.length
				+ " skipped=" + outcome.skippedAlreadyRegistered
				+ " failed=" + outcome.failed.length + "\\n");
		} catch {}
		bootLog("discover-done");
	} catch (error) {
		try { process.stderr.write("[discovery] failed: " + String(error) + "\\n"); } catch {}
	}
})();

try {
	bootLog("start-listen");
	const { port } = await start({
		listAccounts,
		activeAccountUuid,
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
