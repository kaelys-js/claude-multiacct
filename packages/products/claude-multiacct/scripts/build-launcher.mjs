/**
 * `@foundation/claude-multiacct` — Claude launcher bundler.
 *
 * Produces `dist/launcher.js`: a self-contained ESM Node script that
 * spawns `open -a /Applications/Claude.app --args --host-resolver-rules=…`
 * with `REACT_PROFILE=1` set. Mirrors the shim + watcher + daemon build
 * scripts: the entry lives inline (esbuild `stdin`) so the src/ tree
 * stays import-only and vitest coverage — which globs
 * `packages/**\/src/**\/*.ts` — doesn't demand tests for a wiring
 * bootstrap.
 *
 * Entry behavior:
 *   - `CMA_LAUNCHER_SELFTEST=1` → print `cma-launcher selftest OK
 *     <version>` and exit 0. No spawn, no stat.
 *   - Otherwise → `launchClaude({spawnFn:spawn, env:process.env})`.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/launcher.js");

const entryContents = `
import { spawn } from "node:child_process";
import { PACKAGE_VERSION } from "./src/index.ts";
import { launchClaude } from "./src/launch/wrapper.ts";

if (process.env.CMA_LAUNCHER_SELFTEST === "1") {
	process.stdout.write(\`cma-launcher selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

await launchClaude({
	spawnFn: (file, args, opts) => {
		const child = spawn(file, args, { env: opts.env, detached: true, stdio: "ignore" });
		child.unref();
	},
	env: process.env,
});
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
