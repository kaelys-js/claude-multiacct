/**
 * Intent: the wrapper's whole reason to exist is (a) the blackhole argv
 * and (b) `REACT_PROFILE=1`. Losing either silently defeats PR5a:
 *
 *  - Missing REACT_PROFILE → Claude Desktop won't call `loadExtension`,
 *    the extension never boots, and the whole extension→daemon RPC
 *    path is dead. Adversarial: drop `REACT_PROFILE` in wrapper.ts →
 *    the "env contains REACT_PROFILE=1" test flips red.
 *  - Missing `--host-resolver-rules` → Chromium hits the CWS ping
 *    endpoints during dev-loaded-extension startup and may surface
 *    update banners or block-list errors. The golden argv assertion
 *    covers this.
 *  - Missing app path must throw loud (Rule 12) — otherwise the daemon
 *    keeps trying to launch a non-existent bundle silently.
 */

import { describe, expect, it, vi } from "vitest";
import { CWS_ENDPOINTS, renderHostResolverRules } from "./host-resolver.ts";
import { launchClaude, type SpawnFn } from "./wrapper.ts";

describe("launchClaude", () => {
	it("spawns `open -a <appPath> --args --host-resolver-rules=<golden>` with REACT_PROFILE=1", async () => {
		const spawnFn = vi.fn<SpawnFn>();
		const statFn = vi.fn<(path: string) => Promise<unknown>>(() => Promise.resolve({}));
		const result = await launchClaude({
			spawnFn,
			env: { PATH: "/usr/bin" },
			appPath: "/fake/Claude.app",
			statFn,
		});
		expect(result.launched).toBe(true);
		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [file, argv, options] = spawnFn.mock.calls[0]!;
		expect(file).toBe("open");
		expect(argv).toEqual([
			"-a",
			"/fake/Claude.app",
			"--args",
			`--host-resolver-rules=${renderHostResolverRules(CWS_ENDPOINTS)}`,
		]);
		// Adversarial: dropping REACT_PROFILE in wrapper.ts trips this line.
		expect(options.env.REACT_PROFILE).toBe("1");
		// Ambient env is preserved (nothing else is silently dropped).
		expect(options.env.PATH).toBe("/usr/bin");
	});

	it("throws a clear message when the appPath does not exist (Rule 12 loud)", async () => {
		const spawnFn = vi.fn<SpawnFn>();
		const statFn = vi.fn<(path: string) => Promise<unknown>>(() => {
			throw new Error("ENOENT");
		});
		await expect(
			launchClaude({
				spawnFn,
				env: {},
				appPath: "/does/not/exist.app",
				statFn,
			}),
		).rejects.toThrow(/appPath does not exist/u);
		expect(spawnFn).not.toHaveBeenCalled();
	});

	it("defaults statFn to node:fs/promises.stat (uses real fs when statFn omitted)", async () => {
		// Point at a real path (tmpdir exists on every platform) so the real
		// `stat` succeeds and we don't need to inject.
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const scratch = await mkdtemp(`${tmpdir()}/cma-wrapper-`);
		const spawnFn = vi.fn<SpawnFn>();
		const r = await launchClaude({ spawnFn, env: {}, appPath: scratch });
		expect(r.launched).toBe(true);
	});

	it("defaults appPath to /Applications/Claude.app when omitted", async () => {
		const spawnFn = vi.fn<SpawnFn>();
		const statFn = vi.fn<(path: string) => Promise<unknown>>(() => Promise.resolve({}));
		await launchClaude({ spawnFn, env: {}, statFn });
		const [, argv] = spawnFn.mock.calls[0]!;
		expect(argv[1]).toBe("/Applications/Claude.app");
	});
});
