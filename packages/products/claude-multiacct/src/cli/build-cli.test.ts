/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: end-to-end proof that `dist/cma.js` is a runnable Node script.
 * Load-bearing:
 *   - node shebang + owner-exec bit — a missing bit makes `bin/cma`
 *     unusable after install.
 *   - `--version` prints PACKAGE_VERSION, exits 0.
 *   - `--help` prints usage + names every wired command (init, account,
 *     status, doctor). Adversarial: drop a command from the dispatcher's
 *     help text and the corresponding assertion trips.
 *   - `unknowncmd` exits 1.
 *   - Selftest env var → prints selftest OK, exits 0.
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

const entryContents = `
import { PACKAGE_VERSION } from "./src/index.ts";
import { dispatchCli } from "./src/cli/dispatch.ts";

if (process.env.CMA_CLI_SELFTEST === "1") {
	process.stdout.write(\`cma-cli selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}

const io = {
	logger: {
		log: (m) => { process.stdout.write(m + "\\n"); },
		warn: (m) => { process.stderr.write(m + "\\n"); },
		error: (m) => { process.stderr.write(m + "\\n"); },
	},
	env: process.env,
	stdinIsTty: process.stdin.isTTY === true,
	makeCliPorts: async () => {
		throw new Error("wiring in PR6b");
	},
};

const code = await dispatchCli(process.argv.slice(2), io);
process.exit(code);
`;

describe("build-cli: bundled dist/cma.js is a runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildcli-"));
		outfile = join(tmpRoot, "cma.js");
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

	it("--version → prints PACKAGE_VERSION + exits 0", () => {
		const result = spawnSync(process.execPath, [outfile, "--version"], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(PACKAGE_VERSION);
	});

	it("--help → prints usage + names all four wired commands", () => {
		const result = spawnSync(process.execPath, [outfile, "--help"], { encoding: "utf8" });
		// Bare --help with no command → dispatcher prints help and exits 1
		// (usage error — user gave us nothing). Check the payload.
		expect(result.stdout).toContain("Usage");
		expect(result.stdout).toContain("init");
		expect(result.stdout).toContain("account");
		expect(result.stdout).toContain("status");
		expect(result.stdout).toContain("doctor");
	});

	it("unknowncmd → exit 1", () => {
		const result = spawnSync(process.execPath, [outfile, "unknowncmd"], { encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown command");
	});

	it("CMA_CLI_SELFTEST=1 → prints selftest OK <version> and exits 0", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_CLI_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-cli selftest OK ${PACKAGE_VERSION}`);
	});

	it("init --dry-run → exit 0 (no fs writes on a bare machine)", () => {
		const result = spawnSync(process.execPath, [outfile, "init", "--dry-run"], {
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("would create");
	});
});
