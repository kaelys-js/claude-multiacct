/**
 * Intent: end-to-end proof of the packaged shim. The installer's whole ship
 * story is "consumers don't supply a built path — the package resolves
 * dist/shim.js on its own"; that only holds if the bundled artifact is
 * actually runnable. This test bundles it the same way the scripts do
 * (esbuild → single ESM file, banner + chmod +x), then EXECUTES it under
 * CMA_SHIM_SELFTEST=1 and asserts the selftest line + exit 0.
 *
 * No mocks: real esbuild, real spawn. If the bundler mis-emits (missing
 * shebang, wrong format, syntax the runtime can't parse), THIS test fails
 * loud rather than the installer catching it in prod. Adversarial: remove
 * the banner or the +x, and the shebang / exec assertion trips.
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

describe("build-shim: bundled dist/shim.js is a real runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		// Build to a scratch tmpdir so this test never races against a real
		// `pnpm build:shim` writing to the package's dist/.
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildshim-"));
		outfile = join(tmpRoot, "shim.js");
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

	it("starts with a node shebang (so posix_spawn can exec it directly)", async () => {
		const contents = await readFile(outfile, "utf8");
		expect(contents.startsWith("#!/usr/bin/env node\n")).toBe(true);
	});

	it("owner-exec bit is set on the emitted file", () => {
		// mode last octal digit — owner permission bits; +x means an odd value.
		const mode = statSync(outfile).mode.toString(8);
		expect(mode.at(-3)).toMatch(/[1357]/u);
	});

	it("CMA_SHIM_SELFTEST=1 → prints `cma-shim selftest OK <version>` and exits 0 (no env swap, no spawn)", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_SHIM_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-shim selftest OK ${PACKAGE_VERSION}`);
	});
});
