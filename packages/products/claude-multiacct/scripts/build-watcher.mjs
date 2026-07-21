/**
 * `@foundation/claude-multiacct` — watcher bundler.
 *
 * Produces `dist/watcher.js`: a single self-contained ESM Node script that
 * launchd invokes on the watcher agent's WatchPaths fire. Mirrors
 * `build-shim.mjs`: entry lives inline (esbuild `stdin`) so the src/ tree
 * stays import-only and vitest coverage — which globs `packages/**\/src/**\/*.ts`
 * — doesn't demand tests for the file whose whole job is the launchd
 * boot glue.
 *
 * Entry behavior:
 *   - `CMA_WATCHER_SELFTEST=1` → print `cma-watcher selftest OK <version>` and
 *     exit 0. No disk touch. This is what the agent installer invokes
 *     post-copy (and what `build-watcher.test.ts` execs) to prove the packaged
 *     bundle is runnable.
 *   - Otherwise → resolve `parentDir` (env `CMA_WATCHER_PARENT_DIR` for
 *     tests, else the real `~/Library/Application Support/Claude/claude-code/`),
 *     bind `nodeFsPort()` + PR2's real `install()` (with no `shimSourcePath`
 *     so the installer resolves its own default), and forward log lines to
 *     `console.error`.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/watcher.js");

const entryContents = `
import { join } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_VERSION } from "./src/index.ts";
import { runWatcher } from "./src/watcher/watcher.ts";
import { nodeFsPort } from "./src/watcher/fs-port.ts";
import { install as installShim, FLAG_ENV_VAR, FLAG_ENABLED_VALUE } from "./src/cli-shim/installer.ts";

if (process.env.CMA_WATCHER_SELFTEST === "1") {
	process.stdout.write(\`cma-watcher selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const parentDir = process.env.CMA_WATCHER_PARENT_DIR
	?? join(homedir(), "Library/Application Support/Claude/claude-code");
const flag = process.env[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;

const summary = await runWatcher({
	parentDir,
	fs: nodeFsPort(),
	install: async (macosDir) => {
		await installShim(macosDir, {});
	},
	log: (m) => { console.error(m); },
	flag,
});

process.stdout.write(\`cma-watcher: installed=\${summary.installed.length} failed=\${summary.failed.length} skipped=\${summary.skipped.length}\\n\`);
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
