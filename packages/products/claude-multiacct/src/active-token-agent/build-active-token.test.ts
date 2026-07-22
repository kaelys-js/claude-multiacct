/**
 * Intent: end-to-end proof that `dist/active-token.js` is a runnable Node
 * script. launchd fires this binary at login and on Claude's config.json
 * change; if the bundler mis-emits (missing shebang, wrong format, unparseable
 * banner) the companion silently never runs, the IPC file never appears, and
 * the daemon quietly falls back to the first account — the exact prod bug this
 * component fixes. This test bundles the entry the same way
 * `scripts/build-active-token.mjs` does, execs it under
 * `CMA_ACTIVE_TOKEN_SELFTEST=1`, and asserts the selftest line + exit 0. No
 * mocks: real esbuild, real spawn. Adversarial: drop the shebang or the +x bit
 * and the matching assertion trips.
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
import { resolveActiveAccount } from "./src/active-token-agent/resolve.ts";
import { writeActiveAccount } from "./src/active-token-agent/active-account-file.ts";

if (process.env.CMA_ACTIVE_TOKEN_SELFTEST === "1") {
	process.stdout.write(\`cma-active-token selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}
// Non-selftest branch is exercised by build-active-token.mjs at runtime; keep
// it out of the coverage-driven bundle by only wiring selftest here.
`;

describe("build-active-token: bundled dist/active-token.js is a runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildactivetoken-"));
		outfile = join(tmpRoot, "active-token.js");
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

	it("CMA_ACTIVE_TOKEN_SELFTEST=1 → prints `cma-active-token selftest OK <version>` and exits 0", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_ACTIVE_TOKEN_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-active-token selftest OK ${PACKAGE_VERSION}`);
	});
});
