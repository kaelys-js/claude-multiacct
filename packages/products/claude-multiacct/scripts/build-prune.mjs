/**
 * `@foundation/claude-multiacct` — orphan-token prune maintenance bundler.
 *
 * Produces `dist/prune.js`: a single self-contained ESM Node script that
 * deletes keychain token items under this tool's dedicated service
 * (`com.claude-multiacct.tokens`) that no registry account references. Mirrors
 * `build-daemon.mjs` + `build-active-token.mjs`: the entry lives inline
 * (esbuild `stdin`) so the src/ tree stays import-only and vitest coverage —
 * which globs `packages/**\/src/**\/*.ts` — doesn't demand tests for the boot
 * glue (the prune LOGIC in `src/cli-shim/token-prune.ts` is unit-tested).
 *
 * This is the maintenance step that cleans orphans left behind by earlier
 * imports. It reads the keychain via the same `SecurityCliMutableTokenStore`
 * the daemon uses (attributes only, no secret decrypt) and NEVER touches an
 * item outside the tool's own service, so Anthropic's `Claude Safe Storage`
 * key is structurally out of reach. Fail-closed: an unreadable registry aborts
 * with zero deletions.
 *
 * Entry behavior:
 *   - `CMA_PRUNE_SELFTEST=1` → print `cma-prune selftest OK <version>` and exit
 *     0. No keychain read, no disk touch — proves the emitted artifact runs.
 *   - `--dry-run` → list orphans and referenced/listed counts, delete NOTHING.
 *   - otherwise → delete the orphans and print counts (no secrets, no uuids of
 *     referenced items beyond a count).
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/prune.js");

const entryContents = `
import { PACKAGE_VERSION } from "./src/index.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { SecurityCliMutableTokenStore } from "./src/cli-shim/mutable-token-store.ts";
import { pruneOrphanTokens } from "./src/cli-shim/token-prune.ts";

if (process.env.CMA_PRUNE_SELFTEST === "1") {
	process.stdout.write(\`cma-prune selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
const logger = {
	log: (m) => { try { process.stdout.write("[prune] " + m + "\\n"); } catch {} },
	warn: (m) => { try { process.stderr.write("[prune] " + m + "\\n"); } catch {} },
};

const tokenStore = new SecurityCliMutableTokenStore();

// Dry-run wraps the real store so delete() is a no-op but list()/registry read
// still run — proving what WOULD be removed without touching the keychain.
const effectiveStore = dryRun
	? { list: () => tokenStore.list(), delete: async () => {} }
	: tokenStore;

try {
	const result = await pruneOrphanTokens({ readRegistry, tokenStore: effectiveStore, logger });
	const summary = {
		dryRun,
		listed: result.listed.length,
		referenced: result.referenced.length,
		orphans: result.orphans.length,
		deleted: result.deleted.length,
		failures: result.failures.length,
		abortedRegistryUnreadable: result.abortedRegistryUnreadable,
	};
	process.stdout.write(JSON.stringify(summary) + "\\n");
	process.exit(result.failures.length === 0 ? 0 : 1);
} catch (error) {
	const detail = error && error.stack ? error.stack : String(error);
	try { process.stderr.write("[prune] fatal: " + detail + "\\n"); } catch {}
	process.exit(1);
}
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
