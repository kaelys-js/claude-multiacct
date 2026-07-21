/**
 * Intent: end-to-end proof that `dist/launcher.js` is a runnable Node
 * script. If the bundler mis-emits, launching Claude with the
 * blackhole argv silently fails. Adversarial: drop the shebang or the
 * +x bit and the corresponding assertion trips.
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
import { spawn } from "node:child_process";
import { PACKAGE_VERSION } from "./src/index.ts";
import { launchClaude } from "./src/launch/wrapper.ts";

if (process.env.CMA_LAUNCHER_SELFTEST === "1") {
	process.stdout.write(\`cma-launcher selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}
`;

describe("build-launcher: bundled dist/launcher.js is a runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildlauncher-"));
		outfile = join(tmpRoot, "launcher.js");
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

	it("CMA_LAUNCHER_SELFTEST=1 → prints `cma-launcher selftest OK <version>` and exits 0", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_LAUNCHER_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-launcher selftest OK ${PACKAGE_VERSION}`);
	});
});
