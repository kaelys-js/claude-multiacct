/**
 * `@foundation/claude-multiacct` — CLI-shim bundler.
 *
 * Produces `dist/shim.js`: a single self-contained ESM Node script the
 * installer copies into `.../Contents/MacOS/claude`. Executed once per CLI
 * invocation by Claude Desktop's `disclaimer` launcher.
 *
 * The bundled entry lives inline (as esbuild `stdin`) so the src/ tree stays
 * import-only and vitest coverage — which globs `packages/**\/src/**\/*.ts` —
 * doesn't demand tests for a file whose whole job is one top-level `if` that
 * either self-tests or execs the real CLI. The single import into src/ is
 * `PACKAGE_VERSION`, which the selftest line stamps for verification.
 *
 * Entry behavior:
 *   - `CMA_SHIM_SELFTEST=1` set → print `cma-shim selftest OK <version>` and exit 0.
 *     No env swap, no spawn, no touching disk. This is what the installer
 *     invokes post-copy to prove end-to-end that the packaged shim is runnable.
 *   - Otherwise → spawn `claude.real` sibling with argv[2..] + inherited env,
 *     forwarding exit code. Pass-through only in this PR; full swap runtime
 *     wires in later.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/shim.js");

const entryContents = `
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./src/index.ts";
import { runShim } from "./src/cli-shim/shim.ts";
import { removeSessionPid, writeSessionPid } from "./src/cli-shim/session-pid.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { FsChoiceStore, defaultChoiceStoreDir } from "./src/cli-shim/choice-store.ts";
import { SecurityCliTokenStore } from "./src/cli-shim/token-store.ts";

if (process.env.CMA_SHIM_SELFTEST === "1") {
	process.stdout.write(\`cma-shim selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const binDir = dirname(fileURLToPath(import.meta.url));
const choiceStore = new FsChoiceStore(defaultChoiceStoreDir());
const tokenStore = new SecurityCliTokenStore();

const result = await runShim({
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

mkdirSync(dirname(outfile), { recursive: true });

await esbuild.build({
	stdin: { contents: entryContents, resolveDir: pkgRoot, loader: "ts" },
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	// Node target pinned to the mise.toml / .nvmrc runtime (26.5.0).
	target: "node26",
	sourcemap: "inline",
	banner: { js: "#!/usr/bin/env node" },
	logLevel: "warning",
});

chmodSync(outfile, 0o755);
