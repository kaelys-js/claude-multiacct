/**
 * `@foundation/claude-multiacct` — `bin/cma` end-user CLI bundler.
 *
 * Produces `dist/cma.js`: a self-contained ESM Node script installed as
 * `bin/cma`. Entry lives inline (esbuild `stdin`) so the src/ tree stays
 * import-only and vitest coverage — which globs
 * `packages/**\/src/**\/*.ts` — doesn't demand tests for a wiring
 * bootstrap.
 *
 * Entry behaviour:
 *   - `CMA_CLI_SELFTEST=1` → print `cma-cli selftest OK <version>`, exit 0.
 *   - Otherwise → `dispatchCli(process.argv.slice(2), <real IO>)`.
 *
 * # PR6a wiring vs. PR6b
 *
 * The dispatcher's read-only paths (`--version`, `--help`, `init`,
 * `status`, `doctor`) never touch `makeCliPorts()` — that port bundle
 * only exists for `cma account` subcommands. In PR6a we ship a
 * placeholder that throws when invoked so `account add` on a real
 * machine surfaces a clear "not wired yet" error rather than a cryptic
 * import failure. PR6b will replace the placeholder with the real
 * Keychain-backed token store + verify pipeline.
 *
 * @module
 */

import esbuild from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgRoot = resolve(import.meta.dirname, "..");
const outfile = resolve(pkgRoot, "dist/cma.js");

const entryContents = `
import { PACKAGE_VERSION } from "./src/index.ts";
import { dispatchCli } from "./src/cli/dispatch.ts";
import { makeRealInstallPorts, makeRealUninstallPorts, makeRealLaunchPorts, makeRealMigratePorts, makeRealInstallerStatusPort } from "./src/cli/wiring.ts";

if (process.env.CMA_CLI_SELFTEST === "1") {
	process.stdout.write(\`cma-cli selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const logger = {
	log: (m) => { process.stdout.write(m + "\\n"); },
	warn: (m) => { process.stderr.write(m + "\\n"); },
	error: (m) => { process.stderr.write(m + "\\n"); },
};

const io = {
	logger,
	env: process.env,
	stdinIsTty: process.stdin.isTTY === true,
	makeCliPorts: async () => {
		throw new Error(
			"cma account <sub>: real port wiring (Keychain token store, verifyToken pipeline) lands in a later PR.",
		);
	},
	makeInstallPorts: () => makeRealInstallPorts({ logger, env: process.env }),
	makeUninstallPorts: () => makeRealUninstallPorts({ logger, env: process.env }),
	makeLaunchPorts: () => makeRealLaunchPorts({ logger }),
	makeMigratePorts: () => makeRealMigratePorts({ logger }),
	// Bug 7 (PR6b live retry): real per-subsystem installer status for
	// cma status / cma doctor. Was a placeholder string before this PR
	// landed; wired now so operators see live shim/watcher/daemon/
	// extension state instead of 'see PR6b for installer status wiring'.
	makeInstallerStatusPort: () => makeRealInstallerStatusPort(),
};

const code = await dispatchCli(process.argv.slice(2), io);
process.exit(code);
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
