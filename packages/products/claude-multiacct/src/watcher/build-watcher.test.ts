/**
 * Intent: end-to-end proof that `dist/watcher.js` is a runnable Node script.
 * The whole shipped story is "launchd fires this binary and the watcher runs"
 * — if the bundler mis-emits (missing shebang, wrong format, unparseable
 * banner), the launchd agent silently fails on the user's machine. This test
 * bundles the entry the same way `scripts/build-watcher.mjs` does, then
 * exec's it under CMA_WATCHER_SELFTEST=1 and asserts the selftest line +
 * exit 0. No mocks: real esbuild, real spawn. Adversarial: drop the shebang
 * or the +x bit and the corresponding assertion trips.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../index.ts";

const pkgRoot = resolve(import.meta.dirname, "..", "..");

// Kept in lockstep with scripts/build-watcher.mjs. The extra extension imports
// exercise the bundler over the picker self-heal wiring too, so a mis-resolved
// import trips the "runnable bundle" proof.
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

describe("build-watcher: bundled dist/watcher.js is a runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildwatcher-"));
		outfile = join(tmpRoot, "watcher.js");
		await mkdir(dirname(outfile), { recursive: true });
		await esbuild.build({
			stdin: { contents: entryContents, resolveDir: pkgRoot, loader: "ts" },
			outfile,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node26",
			sourcemap: "inline",
			banner: { js: "#!/usr/bin/env node" },
			logLevel: "silent",
		});
		chmodSync(outfile, 0o755);
	});

	it("starts with a node shebang", async () => {
		const contents = await readFile(outfile, "utf8");
		expect(contents.startsWith("#!/usr/bin/env node\n")).toBe(true);
	});

	it("owner-exec bit is set", () => {
		const mode = statSync(outfile).mode.toString(8);
		expect(mode.at(-3)).toMatch(/[1357]/u);
	});

	it("CMA_WATCHER_SELFTEST=1 → prints `cma-watcher selftest OK <version>` and exits 0", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_WATCHER_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-watcher selftest OK ${PACKAGE_VERSION}`);
	});
});
