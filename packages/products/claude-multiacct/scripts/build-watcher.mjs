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
 *     so the installer resolves its own default) + the picker extension
 *     self-heal (`ensureExtension`, bound to the real `extension/installer.ts`
 *     `install()` against the deployed `dist/extension/` and the daemon's
 *     `bridge.json` from config), and forward log lines to `console.error`.
 *     It then hands those deps to `watchResident`, which runs a boot catch-up
 *     pass and holds a recursive `fs.watch` on `parentDir`, re-planting the
 *     shim sub-second on each change. The process stays resident under launchd
 *     `KeepAlive`; it does not exit after the first pass.
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
import { watch as fsWatch } from "node:fs";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { PACKAGE_VERSION } from "./src/index.ts";
import { watchResident } from "./src/watcher/watcher.ts";
import { nodeFsPort } from "./src/watcher/fs-port.ts";
import { install as installShim, FLAG_ENV_VAR, FLAG_ENABLED_VALUE } from "./src/cli-shim/installer.ts";
import {
	install as installExtension,
	defaultClaudeCacheDir,
	defaultClaudeCacheCrxPath,
} from "./src/extension/installer.ts";
import { read as readConfig, defaultConfigPath } from "./src/cli/config-store.ts";
import { resolveExtensionDistDir } from "./src/cli/dist-paths.ts";

if (process.env.CMA_WATCHER_SELFTEST === "1") {
	process.stdout.write(\`cma-watcher selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const parentDir = process.env.CMA_WATCHER_PARENT_DIR
	?? join(homedir(), "Library/Application Support/Claude/claude-code");
const flag = process.env[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;

// Real fs port for the extension installer (Buffer-based), mirroring
// wiring.ts::realExtensionFs. The extension dist lives beside this bundle in
// dist/; import.meta.url resolves to the real dist/watcher.js even via the
// ~/.claude-multiacct/watcher.js symlink, so resolveExtensionDistDir lands on
// dist/extension.
const extensionFs = {
	mkdir: async (p) => { await mkdir(p, { recursive: true }); },
	readFile: (p) => readFile(p),
	writeFile: async (p, d) => { await writeFile(p, d); },
	rm: async (p, opts) => { await rm(p, opts ?? {}); },
	symlink: async (target, p) => { await symlink(target, p); },
	readlink: (p) => readlink(p),
	lstat: (p) => lstat(p),
	access: (p) => access(p),
	cp: (src, dest) => copyFile(src, dest),
};

const ensureExtension = async () => {
	const cfg = await readConfig(defaultConfigPath());
	if (cfg === undefined) {
		// No config yet → the daemon/extension were never installed; nothing to
		// heal. Left to the next \`cma install\`.
		return;
	}
	await installExtension({
		distDir: resolveExtensionDistDir(import.meta.url),
		bridgeJsonPath: cfg.bridgeJsonPath,
		fs: extensionFs,
		flag,
		claudeCacheDir: defaultClaudeCacheDir(),
		claudeCacheCrxPath: defaultClaudeCacheCrxPath(),
		log: (m) => { console.error(m); },
	});
};

// Resident loop: hold a recursive watch on parentDir and re-plant on every
// change. Stays alive under launchd KeepAlive; no process.exit after the first
// pass. The initial catch-up pass runs inside watchResident.
watchResident({
	parentDir,
	fs: nodeFsPort(),
	install: async (macosDir) => {
		await installShim(macosDir, {});
	},
	ensureExtension,
	log: (m) => { console.error(m); },
	flag,
	watch: (path, onEvent) => {
		const w = fsWatch(path, { recursive: true }, () => onEvent());
		return { close: () => { w.close(); } };
	},
});
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
