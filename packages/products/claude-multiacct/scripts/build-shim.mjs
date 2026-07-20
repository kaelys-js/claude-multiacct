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
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./src/index.ts";

if (process.env.CMA_SHIM_SELFTEST === "1") {
	process.stdout.write(\`cma-shim selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const binDir = dirname(fileURLToPath(import.meta.url));
const realBin = join(binDir, "claude.real");
const result = spawnSync(realBin, process.argv.slice(2), {
	stdio: "inherit",
	env: process.env,
});
process.exit(result.status ?? 0);
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
