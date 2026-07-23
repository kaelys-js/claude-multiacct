/**
 * `@foundation/claude-multiacct` — active-token companion bundler.
 *
 * Produces `dist/active-token.js`: a single self-contained ESM Node script that
 * launchd invokes for the gui-session active-token agent (RunAtLoad + a
 * WatchPaths fire on Claude's config.json). Mirrors `build-watcher.mjs` +
 * `build-daemon.mjs`: the entry lives inline (esbuild `stdin`) so the src/ tree
 * stays import-only and vitest coverage — which globs `packages/**\/src/**\/*.ts`
 * — doesn't demand tests for launchd boot glue.
 *
 * Why this agent exists: the bridge daemon runs `SessionCreate=true` and so
 * cannot read the login keychain (`Claude Safe Storage` key + the
 * `com.claude-multiacct.tokens` pool items). This companion runs in the user's
 * gui Security session, WHERE THOSE READS SUCCEED, resolves which pooled account
 * Claude.app is authenticated as, and writes the answer to
 * `~/.claude-multiacct/active-account.json`. The daemon reads that file for
 * `/accounts`'s `activeUuid` instead of touching the keychain itself.
 *
 * Entry behavior:
 *   - `CMA_ACTIVE_TOKEN_SELFTEST=1` → print `cma-active-token selftest OK
 *     <version>` and exit 0. No disk touch, no keychain read. This is what the
 *     agent installer / `build-active-token.test.ts` execs post-bundle to prove
 *     the emitted artifact is runnable.
 *   - Otherwise → build the real discovery ports (timeout-bounded `security`
 *     reads + the config.json v10 scanner) and the keychain token store,
 *     resolve the active account, and publish the record. Any failure is logged
 *     to stderr and written as the fail-closed `activeUuid: null` record, so the
 *     daemon falls back to its first-account default rather than a stale value.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/active-token.js");

const entryContents = `
import { PACKAGE_VERSION } from "./src/index.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { SecurityCliTokenStore } from "./src/cli-shim/token-store.ts";
import { FileTokenStore } from "./src/oauth/file-token-store.ts";
import { makeActiveTokenPorts } from "./src/discovery/real-discovery-ports.ts";
import { poolActiveToken, resolveActiveAccount } from "./src/active-token-agent/resolve.ts";
import {
	defaultActiveAccountPath,
	writeActiveAccount,
} from "./src/active-token-agent/active-account-file.ts";

if (process.env.CMA_ACTIVE_TOKEN_SELFTEST === "1") {
	process.stdout.write(\`cma-active-token selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

function logLine(m) {
	try { process.stderr.write("[active-token] " + m + "\\n"); } catch {}
}

const outPath = defaultActiveAccountPath();

// Resolve the active account in this gui session (keychain-capable) and
// publish it. Every failure path collapses to the fail-closed record so the
// daemon reads a definite "no confident match" rather than a torn or stale
// file. Never leaves the process hanging: the security reads are already
// timeout-bounded inside makeRealDiscoveryPorts.
async function main() {
	// Tokens can be split across two stores: the keychain pool (discovery/native
	// accounts) and the encrypted FileTokenStore (accounts added via cma add).
	// This companion runs in the gui session, so it can read the keychain; the
	// shim reads only the FileTokenStore. So we RESOLVE against the keychain
	// (where the native/live token lives) and MIRROR the live account's token
	// into the FileTokenStore so the shim can swap a session TO it.
	const keychainStore = new SecurityCliTokenStore();
	const fileStore = new FileTokenStore();
	const logger = { log: logLine, warn: logLine };
	const activeTokenPorts = makeActiveTokenPorts(logger);

	let record = { activeUuid: null, activeTokenSha: null, computedAt: new Date().toISOString() };
	try {
		const registry = await readRegistry();
		if (registry === undefined || registry.accounts.length === 0) {
			logLine("no registry / empty pool — publishing null");
		} else {
			// Mirror the live account's token into the store the shim reads.
			try {
				const pooled = await poolActiveToken({
					registry,
					activeTokenPorts,
					readStore: keychainStore,
					writeStore: fileStore,
				});
				logLine("mirrored active token into file store for uuid=" + String(pooled.pooledUuid));
			} catch (error) {
				logLine("mirror active token failed (non-fatal): " + String(error));
			}
			const resolved = await resolveActiveAccount({
				registry,
				activeTokenPorts,
				tokenStore: keychainStore,
			});
			record = { ...resolved, computedAt: new Date().toISOString() };
			logLine("resolved activeUuid=" + String(resolved.activeUuid));
		}
	} catch (error) {
		logLine("resolve failed, publishing null: " + String(error));
	}

	await writeActiveAccount(outPath, record);
	process.stdout.write(\`cma-active-token: activeUuid=\${String(record.activeUuid)}\\n\`);
}

await main();
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
