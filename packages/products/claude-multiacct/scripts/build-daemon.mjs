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
 *   - Otherwise → build real ports (readRegistry, FsChoiceStore, the encrypted
 *     FileTokenStore, verifyToken bound with a spawn-shaped exec), call
 *     `start()`, print `{ready:true,port,pid}` on stdout, and wait.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/daemon.js");

const entryContents = `
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_VERSION } from "./src/index.ts";
import { start } from "./src/http-bridge/server.ts";
import { makeAddAccount, makeRemoveAccount } from "./src/http-bridge/account-admin.ts";
import { FsChoiceStore } from "./src/cli-shim/choice-store.ts";
import { readRegistry, defaultRegistryPath } from "./src/cli-shim/registry-store.ts";
import { FileTokenStore } from "./src/oauth/file-token-store.ts";
import { signalSwap } from "./src/cli-shim/session-pid.ts";
import { AtomicRegistryWriter, nodeRegistryFsPort } from "./src/registry/registry-writer.ts";
import { verifyToken } from "./src/oauth/verify.ts";
import { flagOn } from "./src/oauth/provisioning.ts";
import { createLoginManager } from "./src/oauth/login-manager.ts";
import { exchangeAuthorizationCode } from "./src/oauth/login.ts";
import { fetchAccountProfile } from "./src/discovery/identity.ts";
import { registerOrUpdateAccount } from "./src/oauth/register-account.ts";
import { readFile } from "node:fs/promises";
import {
	defaultActiveAccountPath,
	readActiveUuid,
} from "./src/active-token-agent/active-account-file.ts";
import {
	defaultClaudeConfigJsonPath,
	readLastKnownAccountUuid,
} from "./src/discovery/claude-config.ts";
import { resolveActiveByLastKnown } from "./src/domain/registry.ts";

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
// Per-account tokens no longer live in the login keychain: they live in the
// encrypted FileTokenStore (see construct-stores below), which needs no
// \`security\` call, so the daemon adds/reads/deletes tokens directly despite
// being keychain-blind under SessionCreate=true. The only remaining keychain
// reads are the discovery path's \`Claude Safe Storage\` decrypt-key + config
// probes; those are already timeout-bounded and fire-and-forget, never on the
// boot-blocking path.
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
// Per-account OAuth tokens live in the ENCRYPTED FILE store, not the login
// keychain. The daemon runs under launchd \`SessionCreate=true\` and is
// therefore keychain-blind — a \`security\` read/write/delete either fails
// ("User interaction is not allowed") or hangs on an invisible ACL prompt.
// FileTokenStore (AES-256-GCM, 0600, under ~/.config/claude-multiacct/tokens/)
// needs no keychain call, so the daemon can add, read, and delete tokens
// directly. The GUI-session shim reads the SAME store. Construction only
// touches disk lazily (first get/put), so it does not lengthen boot.
const tokenStore = new FileTokenStore();
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

// Resolve the account Claude.app is currently authenticated as. The PREFERRED
// signal is Claude.app's own plaintext \`lastKnownAccountUuid\` in config.json —
// the real account uuid of the account it is signed into RIGHT NOW. It is
// cleartext, so even this keychain-blind daemon (SessionCreate=true) reads it
// directly, and it is matched against each pooled account's stored
// \`accountUuid\`. That is strictly better than the old legacy-cache-token-sha
// guess, which needed the keychain and broke when the cache held several tokens
// for one account.
//
// Fallback order (each fails closed):
//   1. lastKnownAccountUuid → matching account.accountUuid.
//   2. the gui-session companion's published active-account.json (token-sha
//      match), when it still names a pooled account.
//   3. first account in registry order.
const activeAccountFilePath = defaultActiveAccountPath();
const claudeConfigPath = defaultClaudeConfigJsonPath();
const activeAccountUuid = async () => {
	try {
		const reg = await readRegistry();
		if (reg === undefined || reg.accounts.length === 0) return undefined;
		const lastKnown = await readLastKnownAccountUuid(claudeConfigPath);
		const byLastKnown = resolveActiveByLastKnown(reg, lastKnown);
		if (byLastKnown !== undefined) return byLastKnown.uuid;
		const published = await readActiveUuid(activeAccountFilePath, { readFile: (p) => readFile(p, "utf8") });
		if (published !== undefined && reg.accounts.some((a) => a.uuid === published)) {
			return published;
		}
		return reg.accounts[0]?.uuid;
	} catch (error) {
		try { process.stderr.write("[active-token] resolve failed: " + String(error) + "\\n"); } catch {}
		return undefined;
	}
};

// Pool-mutation ports for POST /accounts + DELETE /accounts/:uuid. Same
// adapters the CLI's makeCliPorts uses (encrypted FileTokenStore + atomic
// registry writer + the real verify subprocess), so the bridge provisions and
// removes accounts exactly the way the cma account add/remove CLI does. Token
// store/read/delete go through the FILE store, never the keychain, so a
// keychain-blind daemon completes both add and remove.
bootLog("construct-cliports");
const registryPath = defaultRegistryPath();
const cliPorts = {
	// Same keychain-blind-safe FileTokenStore instance the verify/discovery
	// path uses, so add/remove/read all agree on one AES-256-GCM key + token
	// tree. POST /accounts + DELETE /accounts/:uuid now store, read, and delete
	// tokens WITHOUT any keychain call.
	tokenStore,
	registryWriter: new AtomicRegistryWriter({ path: registryPath, fs: nodeRegistryFsPort() }),
	readRegistry: () => readRegistry(registryPath),
	verify: (token) => verifyToken({ token, claudeRealPath, exec: verifyExec }),
	// Reassignment ports: on a successful remove, removeAccount repoints every
	// session pinned to the removed account onto the primary (native) account
	// via this choiceStore and SIGHUPs any live shim so it hot-swaps.
	choiceStore,
	signalSwap: (sessionUuid) => signalSwap(sessionUuid),
};
const addAccount = makeAddAccount({ cliPorts, env: process.env });
const removeAccount = makeRemoveAccount({ cliPorts, env: process.env });

// In-app OAuth login manager. Construction binds NO socket and touches NO
// keychain — a loopback listener is bound lazily, only when a /accounts/login/
// start request arrives. The exchange + profile calls use the global fetch;
// register-or-update runs through the same cliPorts add/remove uses (dedup by
// accountUuid, source=explicit). Tokens/codes are never written to stderr.
bootLog("construct-loginmanager");
const loginFetch = (url, init) => fetch(url, init);
// Open the authorize URL in the user's REAL browser from here (a Node process).
// The picker runs in Claude's Electron renderer, where an external window.open
// is a no-op — only a host-side spawn reaches the system browser. Mirrors the
// launch/wrapper.ts pattern: spawn macOS \`open "<url>"\`, detached, never awaited.
// CMA_OPEN_BIN overrides the binary (tests point it at a harmless no-op so no
// browser launches). The URL carries only a short-lived state/PKCE challenge,
// so it is NOT logged; only a generic breadcrumb is.
const openBin = process.env.CMA_OPEN_BIN ?? "open";
const openAuthorizeUrl = (url) => {
	const child = spawn(openBin, [url], { stdio: "ignore", detached: true });
	child.on("error", (error) => {
		try { process.stderr.write("[login] open failed: " + String(error) + "\\n"); } catch {}
	});
	child.unref();
};
// The Claude account OAuth client rejects loopback redirects, so this flow uses
// the shipping app's MANUAL redirect (platform.claude.com/oauth/code/callback):
// no 127.0.0.1 listener is bound. start() builds the authorize URL and the
// daemon opens it host-side; the user pastes the code#state back and the picker
// POSTs it to /accounts/login/complete, which drives exchange→profile→register.
const loginManager = createLoginManager({
	exchangeCode: (args) => exchangeAuthorizationCode({ ...args, fetchImpl: loginFetch }),
	fetchProfile: (token) => fetchAccountProfile(token, loginFetch),
	register: ({ profile, token }) => registerOrUpdateAccount({ profile, token, ports: cliPorts }),
	openUrl: openAuthorizeUrl,
	logger: {
		log: (m) => { try { process.stderr.write("[login] " + m + "\\n"); } catch {} },
		warn: (m) => { try { process.stderr.write("[login] " + m + "\\n"); } catch {} },
	},
});
const loginStart = async () => {
	try {
		const { loginId, authorizeUrl } = await loginManager.start();
		return { ok: true, loginId, authorizeUrl };
	} catch (error) {
		return { ok: false, status: 500, reason: "login_start_failed", detail: String(error) };
	}
};
const loginStatus = (loginId) => loginManager.getStatus(loginId);
const loginComplete = (loginId, code) => loginManager.complete(loginId, code);
const loginCancel = (loginId) => loginManager.cancel(loginId);
const loginOpen = (loginId) => loginManager.open(loginId);

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
// CMA_DISABLE_DISCOVERY=1 skips the keychain-touching auto-detect entirely.
// Set by the daemon-boot integration test (and any headless/CI probe) so booting
// the real daemon to exercise the HTTP surface never blocks on, or prompts for,
// a \`Claude Safe Storage\` keychain read. Production leaves it unset.
if (process.env.CMA_DISABLE_DISCOVERY === "1") {
	try { process.stderr.write("[discovery] skipped (CMA_DISABLE_DISCOVERY=1)\\n"); } catch {}
} else (async () => {
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
			process.stderr.write("[discovery] detected=" + (outcome.detected ? outcome.detected.accountUuid : "none")
				+ " registered=" + (outcome.registered ? outcome.registered.label : "no")
				+ " alreadyRegistered=" + outcome.alreadyRegistered
				+ " failed=" + (outcome.failed ? outcome.failed.kind : "no") + "\\n");
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
		addAccount,
		removeAccount,
		loginStart,
		loginStatus,
		loginComplete,
		loginCancel,
		loginOpen,
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
