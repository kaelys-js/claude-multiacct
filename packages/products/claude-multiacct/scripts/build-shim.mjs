/**
 * `@foundation/claude-multiacct` — CLI-shim bundler.
 *
 * Produces `dist/shim.js`: a single self-contained ESM Node script the
 * installer copies into `.../Contents/MacOS/claude`. Executed once per CLI
 * invocation by Claude Desktop's `disclaimer` launcher.
 *
 * The bundled entry lives in `./shim-entry.mjs` (as an esbuild `stdin` string)
 * so the src/ tree stays import-only and vitest coverage — which globs
 * `packages/**\/src/**\/*.ts` — doesn't demand tests for launchd boot glue.
 * It sits in its own module (not inline here) so `build-shim.test.ts` bundles
 * and runs the EXACT shipped entry rather than a hand-copied stand-in.
 *
 * Entry behavior:
 *   - `CMA_SHIM_SELFTEST=1` set → print `cma-shim selftest OK <version>` and exit 0.
 *     No env swap, no spawn, no touching disk. This is what the installer
 *     invokes post-copy to prove end-to-end that the packaged shim is runnable.
 *   - Otherwise → run the full swap runtime (`runShim`): resolve the session's
 *     pinned account, swap `CLAUDE_CODE_OAUTH_TOKEN` + a per-account
 *     `CLAUDE_CONFIG_DIR`, and exec the `claude.real` sibling with argv[2..],
 *     forwarding the exit code. Every failure path falls through to a
 *     pass-through exec with the launcher's original env (see `shim.ts`).
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildShimBundle } from "./shim-entry.mjs";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/shim.js");

mkdirSync(dirname(outfile), { recursive: true });
await buildShimBundle({ pkgRoot, outfile });
