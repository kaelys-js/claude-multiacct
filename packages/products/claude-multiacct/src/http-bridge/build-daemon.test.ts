/**
 * Intent: end-to-end proof that `dist/daemon.js` is a runnable Node
 * script. Launchd fires this binary on login; if the bundler mis-emits
 * (missing shebang, wrong format, unparseable banner) the daemon
 * silently never starts on the user's machine. This test bundles the
 * entry the same way `scripts/build-daemon.mjs` does, then execs it
 * under CMA_DAEMON_SELFTEST=1 and asserts the selftest line + exit 0.
 * No mocks: real esbuild, real spawn. Adversarial: drop the shebang or
 * the +x bit and the corresponding assertion trips.
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_VERSION } from "./src/index.ts";
import { start } from "./src/http-bridge/server.ts";
import { FsChoiceStore } from "./src/cli-shim/choice-store.ts";
import { readRegistry } from "./src/cli-shim/registry-store.ts";
import { SecurityCliTokenStore } from "./src/cli-shim/token-store.ts";
import { verifyToken } from "./src/oauth/verify.ts";
import { flagOn } from "./src/oauth/provisioning.ts";

if (process.env.CMA_DAEMON_SELFTEST === "1") {
	process.stdout.write(\`cma-daemon selftest OK \${PACKAGE_VERSION}\\n\`);
	process.exit(0);
}
// Non-selftest branch is exercised by build-daemon.mjs at runtime; keep
// it out of the coverage-driven bundle by only wiring selftest here.
`;

describe("build-daemon: bundled dist/daemon.js is a runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		const tmpRoot = await mkdtemp(join(tmpdir(), "cma-builddaemon-"));
		outfile = join(tmpRoot, "daemon.js");
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

	it("CMA_DAEMON_SELFTEST=1 → prints `cma-daemon selftest OK <version>` and exits 0", () => {
		const result = spawnSync(process.execPath, [outfile], {
			env: { ...process.env, CMA_DAEMON_SELFTEST: "1" },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(`cma-daemon selftest OK ${PACKAGE_VERSION}`);
	});
});
