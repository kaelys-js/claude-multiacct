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
import { randomUUID } from "node:crypto";
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
import { FsHostChoiceStore, defaultHostChoiceStoreDir } from "./src/cli-shim/host-choice-store.ts";
import { FileTokenStore } from "./src/oauth/file-token-store.ts";
import { read as readCmaConfig, defaultConfigPath } from "./src/cli/config-store.ts";

if (process.env.CMA_SHIM_SELFTEST === "1") {
	process.stdout.write(\`cma-shim selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const binDir = dirname(fileURLToPath(import.meta.url));
const choiceStore = new FsChoiceStore(defaultChoiceStoreDir());
// Per-conversation choice store keyed on the app's stable host session id. This
// is what lets a chosen account survive a Claude.app restart: the CLI uuid is
// minted fresh on the post-restart spawn (so its choiceStore entry is gone), but
// the host session id is the app's durable conversation handle, so the shim
// re-resolves the account through here.
const hostChoiceStore = new FsHostChoiceStore(defaultHostChoiceStoreDir());
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
	hostChoiceStore,
	// The app's stable conversation id; absent for non-app spawns, which leaves
	// the restart-survival path inert (classic CLI-uuid behaviour).
	hostSessionId: process.env.CLAUDE_CODE_HOST_SESSION_ID,
	readRegistry: () => readRegistry(),
	// Runtime kill-switch: the shim runs without the enable env var, so it reads
	// config.enabled directly. config-store.read soft-fails to undefined on a
	// missing/corrupt sidecar, so this is fail-open — only an explicit false stops
	// the swap. Cheap: one small JSON read per spawn, dwarfed by the claude.real spawn.
	readEnabledFlag: async () => {
		const cfg = await readCmaConfig(defaultConfigPath());
		return cfg?.enabled;
	},
	tokenStore,
	spawnSync,
	spawn,
	onSighup: (handler) => {
		process.on("SIGHUP", handler);
		return () => process.off("SIGHUP", handler);
	},
	writePidFile: (uuid) => writeSessionPid(uuid, process.pid),
	removePidFile: (uuid) => removeSessionPid(uuid),
	// Fresh interactive sessions arrive id-less in argv; mint one so the shim
	// can register a pid file and adopt it via --session-id (see resolveSessionIdentity).
	newSessionUuid: () => randomUUID(),
	// Relay the launcher's std streams through per-child pipes so a
	// SIGHUP-respawned claude.real still receives subsequent stream-json turns
	// (stdin) AND its output reaches the app (stdout/stderr) — an inherited stdio
	// pipe carries the first child's O_NONBLOCK into the respawn and silences it.
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr,
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
