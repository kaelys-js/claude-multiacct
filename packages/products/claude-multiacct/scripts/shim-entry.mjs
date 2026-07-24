/**
 * `@foundation/claude-multiacct` — the SHIPPED CLI-shim entry, extracted.
 *
 * `build-shim.mjs` bundles `shimEntryContents` into `dist/shim.js`; the
 * `build-shim.test.ts` integration test bundles the SAME string and runs it
 * against a fake `claude.real`. Sharing one literal is the point: the earlier
 * test hand-wrote a pass-through-only entry, so it proved the artifact was a
 * runnable node script but NEVER that the shipped glue performs the swap. With
 * the entry defined here, the test exercises the exact code that ships.
 *
 * `buildShimBundle` is the single esbuild invocation both callers use, so the
 * bundler options (target, format, banner) can never drift between prod and
 * the test.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync } from "node:fs";

/** The exact entry `dist/shim.js` is built from. */
export const shimEntryContents = `
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./src/index.ts";
import { runShim } from "./src/cli-shim/shim.ts";
import { buildSessionConfigDir } from "./src/cli-shim/session-config-dir.ts";
import { removeSessionPid, writeSessionPid } from "./src/cli-shim/session-pid.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { FsChoiceStore, defaultChoiceStoreDir } from "./src/cli-shim/choice-store.ts";
import { FileTokenStore } from "./src/oauth/file-token-store.ts";

if (process.env.CMA_SHIM_SELFTEST === "1") {
	process.stdout.write(\`cma-shim selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const binDir = dirname(fileURLToPath(import.meta.url));
const choiceStore = new FsChoiceStore(defaultChoiceStoreDir());
// Read tokens from the SAME encrypted file store the daemon writes. The shim
// runs in the GUI session, but the daemon (keychain-blind under
// SessionCreate=true) can only write the file store — so the shim must read it
// there too, or a daemon-added account's token would be invisible here and the
// shim would silently fall back to the primary account.
const tokenStore = new FileTokenStore();

const result = await runShim({
	// Per-session identity view: a config dir whose .claude.json copies the shared
	// one with oauthAccount overridden to the swapped account, and whose
	// transcript/session stores symlink back to the shared ~/.claude. The model
	// self-reports the swapped account while its transcript stays in the one
	// shared tree. Native returns undefined (reads the shared config directly).
	prepareConfigDir: (account) => buildSessionConfigDir(account),
	argv: process.argv,
	env: process.env,
	binDir,
	choiceStore,
	readRegistry: () => readRegistry(),
	tokenStore,
	spawnSync,
	spawn,
	onSighup: (handler) => {
		process.on("SIGHUP", handler);
		return () => process.off("SIGHUP", handler);
	},
	writePidFile: (uuid) => writeSessionPid(uuid, process.pid),
	removePidFile: (uuid) => removeSessionPid(uuid),
	warn: (m) => { process.stderr.write("[cma-shim] " + m + "\\n"); },
	logSpawn: (sessionUuid, tokenHash) => {
		try {
			const logDir = join(homedir(), ".claude-multiacct", "logs");
			mkdirSync(logDir, { recursive: true, mode: 0o700 });
			const logPath = join(logDir, "shim-spawns.log");
			// Touch with 0600 if new; append-only append after.
			try { closeSync(openSync(logPath, "a", 0o600)); } catch {}
			const line = new Date().toISOString() + " session=" + (sessionUuid ?? "-") + " token-sha256=" + tokenHash + "\\n";
			appendFileSync(logPath, line, { mode: 0o600 });
		} catch {
			// audit-only; never block a spawn
		}
	},
});
process.exit(result.exitCode);
`;

/**
 * Bundle `shimEntryContents` to `outfile` with the shipped options, then set
 * the owner-exec bit (launchd/posix_spawn execs the file directly).
 *
 * @param {object} opts - Bundle options.
 * @param {string} opts.pkgRoot - Package root; esbuild resolves `./src/...` here.
 * @param {string} opts.outfile - Absolute path to write the bundle to.
 * @param {"warning" | "silent"} [opts.logLevel] - esbuild log level.
 * @returns {Promise<void>} Resolves once the file is written + chmod'd.
 */
export async function buildShimBundle({ pkgRoot, outfile, logLevel = "warning" }) {
	await esbuild.build({
		stdin: { contents: shimEntryContents, resolveDir: pkgRoot, loader: "ts" },
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		// Node target pinned to the mise.toml / .nvmrc runtime (26.5.0).
		target: "node26",
		sourcemap: "inline",
		banner: { js: "#!/usr/bin/env node" },
		logLevel,
	});
	chmodSync(outfile, 0o755);
}
