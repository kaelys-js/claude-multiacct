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
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_VERSION } from "./src/index.ts";
import { dispatchCli } from "./src/cli/dispatch.ts";
import { makeRealInstallPorts, makeRealUninstallPorts, makeRealLaunchPorts, makeRealMigratePorts, makeRealInstallerStatusPort } from "./src/cli/wiring.ts";
import { AtomicRegistryWriter, nodeRegistryFsPort } from "./src/registry/registry-writer.ts";
import { SecurityCliMutableTokenStore } from "./src/cli-shim/mutable-token-store.ts";
import { readRegistry, defaultRegistryPath } from "./src/cli-shim/registry-store.ts";

const execFileP = promisify(execFile);

if (process.env.CMA_CLI_SELFTEST === "1") {
	process.stdout.write(\`cma-cli selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const logger = {
	log: (m) => { process.stdout.write(m + "\\n"); },
	warn: (m) => { process.stderr.write(m + "\\n"); },
	error: (m) => { process.stderr.write(m + "\\n"); },
};

/**
 * Real verify — proves a token works by spawning the Anthropic \`claude\`
 * CLI with the token in its env and asking it to answer a trivial prompt
 * in --print mode. Exit 0 → token works. Non-zero + auth-failure banner
 * on stderr → unauthorized. Any other non-zero → unexpected.
 *
 * The local \`accountUuid\` is a freshly-minted v4 (via crypto.randomUUID),
 * NOT derived from the token. That's an honest local pool identifier and
 * matches the domain model — the pool is a local concept, Anthropic never
 * needs to see the uuid. Subscription + rate-limit default to "unknown";
 * the daemon's \`/usage\` route replaces them with values from the real
 * Anthropic response on first fetch.
 */
async function realVerify(token) {
	// Fail fast if the CLI isn't on PATH.
	let claudePath;
	try {
		const { stdout } = await execFileP("which", ["claude"]);
		claudePath = stdout.trim();
	} catch {
		return { ok: false, kind: "unexpected", detail: "claude CLI not on PATH — cannot verify token" };
	}
	if (claudePath.length === 0) {
		return { ok: false, kind: "unexpected", detail: "claude CLI not on PATH — cannot verify token" };
	}
	const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token };
	try {
		// -p print mode, --no-session-persistence so we don't create a session
		// file, --model haiku for the cheapest model, minimal prompt.
		await execFileP(
			claudePath,
			["-p", "--no-session-persistence", "--model", "haiku", "hi"],
			{ env, timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		return {
			ok: true,
			accountUuid: randomUUID(),
			subscriptionType: "unknown",
			rateLimitTier: "unknown",
		};
	} catch (error) {
		const stderr = (error && error.stderr) ? String(error.stderr) : "";
		const stdout = (error && error.stdout) ? String(error.stdout) : "";
		const both = stderr + " " + stdout;
		if (/unauthori[sz]ed|not\\s+authenticated|invalid\\s+token|401|403/iu.test(both)) {
			return { ok: false, kind: "unauthorized", detail: stderr.trim() || String(error.message) };
		}
		if (error && (error.code === "ENOENT" || error.code === "ETIMEDOUT")) {
			return { ok: false, kind: "network", detail: String(error.message) };
		}
		return { ok: false, kind: "unexpected", detail: stderr.trim() || String(error.message) };
	}
}

const io = {
	logger,
	env: process.env,
	stdinIsTty: process.stdin.isTTY === true,
	makeCliPorts: async () => {
		const registryPath = defaultRegistryPath();
		return {
			tokenStore: new SecurityCliMutableTokenStore(),
			registryWriter: new AtomicRegistryWriter({
				path: registryPath,
				fs: nodeRegistryFsPort(),
			}),
			readRegistry: () => readRegistry(registryPath, logger),
			verify: realVerify,
		};
	},
	makeInstallPorts: (parsed) => makeRealInstallPorts({ logger, env: process.env }, parsed),
	makeUninstallPorts: () => makeRealUninstallPorts({ logger, env: process.env }),
	makeLaunchPorts: () => makeRealLaunchPorts({ logger }),
	makeMigratePorts: () => makeRealMigratePorts({ logger }),
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
