/**
 * Intent: end-to-end proof of the SHIPPED shim entry. Two things must hold for
 * the installed `dist/shim.js` to work in prod:
 *
 *   1. It is a runnable node script (shebang + exec bit) that self-tests.
 *   2. When a session has a pinned choice, it actually SWAPS the token and
 *      sets the per-account CLAUDE_CONFIG_DIR before execing `claude.real`.
 *
 * The earlier version of this test bundled a hand-written pass-through-only
 * entry, so it proved (1) but silently never exercised (2) — the swap could
 * have regressed and this test would stay green. Both suites below now bundle
 * the EXACT `shimEntryContents` the bundler ships (imported from
 * `scripts/shim-entry.mjs`), so a break in the shipped glue trips here rather
 * than in prod.
 *
 * No mocks in the swap suite: real esbuild, a real encrypted FileTokenStore, a
 * real on-disk registry + choice sidecar under an isolated HOME, and a real
 * `claude.real` child that records the env it was handed. Adversarial: point
 * the choice at a different account, or drop `--session-id` parsing, and the
 * token / config-dir assertions go red.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildShimBundle, shimEntryContents } from "../../scripts/shim-entry.mjs";
import type { AccountUuid } from "../domain/account.ts";
import { FileTokenStore } from "../oauth/file-token-store.ts";
import { PACKAGE_VERSION } from "../index.ts";

const pkgRoot = resolve(import.meta.dirname, "..", "..");
// Resolved once at module scope so the test body stays free of conditionals.
const CHILD_PATH = process.env.PATH ?? "/usr/bin:/bin";

async function bundleRealShim(): Promise<string> {
	const tmpRoot = await mkdtemp(join(tmpdir(), "cma-buildshim-"));
	const outfile = join(tmpRoot, "shim.js");
	await mkdir(dirname(outfile), { recursive: true });
	await buildShimBundle({ pkgRoot, outfile, logLevel: "silent" });
	return outfile;
}

describe("build-shim: bundled dist/shim.js is a real runnable node script", () => {
	let outfile: string;

	beforeAll(async () => {
		outfile = await bundleRealShim();
	});

	it("starts with a node shebang (so posix_spawn can exec it directly)", async () => {
		const contents = await readFile(outfile, "utf8");
		expect(contents.startsWith("#!/usr/bin/env node\n")).toBe(true);
	});

	it("owner-exec bit is set on the emitted file", () => {
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

	it("the shipped entry actually wires the swap runtime (references runShim + prepareConfigDir)", () => {
		// A cheap guard that the source of truth stayed the swap entry, not a
		// pass-through stub. The behavioural proof is the swap suite below.
		expect(shimEntryContents).toContain("runShim");
		expect(shimEntryContents).toContain("prepareConfigDir");
	});
});

describe("build-shim: the SHIPPED entry swaps the token + sets CLAUDE_CONFIG_DIR", () => {
	const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
	const ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as AccountUuid;
	const POOL_TOKEN = "sk-ant-oat-POOLED-TOKEN-FOR-TEST";

	let outfile: string;
	let home: string;
	let binDir: string;
	let capturePath: string;

	beforeAll(async () => {
		outfile = await bundleRealShim();

		// Isolated HOME — the shipped entry resolves every path off homedir(), so
		// setting HOME in the child env sandboxes registry/token/choice/pid writes.
		home = await mkdtemp(join(tmpdir(), "cma-home-"));
		const cfgRoot = join(home, ".config", "claude-multiacct");
		await mkdir(join(cfgRoot, "session-account"), { recursive: true });

		// Registry with one account the choice will pin to.
		await writeFile(
			join(cfgRoot, "registry.json"),
			JSON.stringify({
				accounts: [
					{
						uuid: ACCOUNT,
						label: "pooled",
						subscriptionType: "claude_max",
						rateLimitTier: "unknown",
						encryptedTokenRef: ACCOUNT,
					},
				],
			}),
		);

		// Real encrypted token, written the same way the daemon does.
		await new FileTokenStore(cfgRoot, join(cfgRoot, "keystore.key")).put(ACCOUNT, POOL_TOKEN);

		// Choice sidecar pinning the session to that account.
		await writeFile(
			join(cfgRoot, "session-account", `${SESSION}.json`),
			JSON.stringify({
				sessionUuid: SESSION,
				accountUuid: ACCOUNT,
				chosenAt: "2026-07-23T00:00:00.000Z",
			}),
		);

		// binDir holds the shim (as `claude`) and a fake `claude.real` that records
		// the token + config dir it was invoked with.
		binDir = await mkdtemp(join(tmpdir(), "cma-bin-"));
		capturePath = join(binDir, "capture.txt");
		const shimSrc = await readFile(outfile, "utf8");
		await writeFile(join(binDir, "claude"), shimSrc, { mode: 0o755 });
		const fakeReal = `#!/bin/sh
{
  echo "TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  echo "CONFIG_DIR=$CLAUDE_CONFIG_DIR"
} > "${capturePath}"
exit 0
`;
		await writeFile(join(binDir, "claude.real"), fakeReal, { mode: 0o755 });
	});

	it("hands claude.real the pooled token and a per-account CLAUDE_CONFIG_DIR (fresh --session-id session)", async () => {
		const result = spawnSync(
			process.execPath,
			[join(binDir, "claude"), "--print", `--session-id=${SESSION}`],
			{
				env: { HOME: home, PATH: CHILD_PATH },
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);

		const captured = await readFile(capturePath, "utf8");
		// The load-bearing assertions: the shipped entry resolved the choice, read
		// the encrypted token, and pointed the CLI at the per-account config dir.
		expect(captured).toContain(`TOKEN=${POOL_TOKEN}`);
		expect(captured).toContain(
			`CONFIG_DIR=${join(home, ".config", "claude-multiacct", "account-config", ACCOUNT)}`,
		);
	});
});
