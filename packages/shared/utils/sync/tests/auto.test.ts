// In-process coverage for `packages/shared/utils/sync/src/auto.ts` — the self-gating sync trigger
// git hooks (post-checkout / post-merge) call.
//
// WHY these tests matter: git hooks can't tell lefthook which files changed
// across a checkout/merge, so auto.ts gates on CONTENT — it hashes mise.toml and
// compares to a per-clone marker. The two behaviours that matter: (1) when the
// hash matches the marker it must be a FAST no-op (exit 0, no `pnpm sync`
// spawned) — otherwise every checkout pays the full sync cost; (2) when it
// differs (or no marker) it must run the full sync AND record the new hash, so
// the next checkout is a no-op. A regression in either turns the hook into
// either a no-op that never syncs or a sync that runs on every checkout. The
// spawn of `pnpm sync` is mocked so no real sync runs.

import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { runScript, resetHarness, type HarnessResult } from "./harness.ts";

const MODULE = "../src/auto.ts";
const MISE_CONTENT = '[tools]\nnode = "22.1.0"\npnpm = "10.2.0"\n';

// The SHA-256 hex the script computes for the mise.toml content above — the tests
// use it to construct a matching (no-op) or mismatching (run) marker.
const MISE_HASH = createHash("sha256").update(MISE_CONTENT).digest("hex");

// Capture the spawnSync calls so we can assert whether `pnpm sync` was invoked.
type SpawnCall = { cmd: unknown; args: unknown };
function recordingSpawn(status: number): {
	spawnSync: (cmd: unknown, args: unknown) => unknown;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	return {
		calls,
		spawnSync: (cmd: unknown, args: unknown) => {
			calls.push({ cmd, args });
			return { status, stdout: "", stderr: "", signal: null };
		},
	};
}

afterEach(resetHarness);

describe("sync/auto", () => {
	it("no-ops (exit 0, no sync spawned) when the marker hash already matches mise.toml", async () => {
		// WHY: the whole point of the marker is to make an unchanged checkout free. If
		// mise.toml's hash equals the recorded marker, the script must exit 0 WITHOUT
		// spawning `pnpm sync`.
		const files = new Map<string, string>([
			["mise.toml", MISE_CONTENT],
			[".sync-hash", `${MISE_HASH}\n`],
		]);
		const spawn = recordingSpawn(0);
		const res = await runScript(MODULE, { files, argv: [], spawnSync: spawn.spawnSync });
		expect(res.exitCode).toBe(0);
		expect(spawn.calls, "an unchanged mise.toml must NOT trigger a sync").toEqual([]);
		expect(res.stdout).toBe("");
	});

	it("runs `pnpm sync` and records the new hash when the marker is stale", async () => {
		// WHY: a changed mise.toml (marker hash differs) must re-derive everything and
		// update the marker so the NEXT checkout is a no-op. Both halves — the spawn and
		// the marker write — are the behaviour the hook depends on.
		const files = new Map<string, string>([
			["mise.toml", MISE_CONTENT],
			[".sync-hash", "deadbeef-stale-hash\n"],
		]);
		const spawn = recordingSpawn(0);
		const res = await runScript(MODULE, { files, argv: [], spawnSync: spawn.spawnSync });
		expect(res.exitCode).toBeUndefined();
		expect(res.stdout).toContain("mise.toml changed — running sync.");
		// Exactly one spawn, and it must be the `pnpm sync` invocation.
		expect(spawn.calls).toHaveLength(1);
		expect(spawn.calls[0]?.args).toEqual(["exec", "--", "pnpm", "sync"]);
		// The new marker equals the CURRENT mise.toml hash → next run no-ops.
		expect(files.get(".sync-hash")).toBe(`${MISE_HASH}\n`);
	});

	it("runs sync when NO marker exists yet (first checkout after clone)", async () => {
		// WHY: a fresh clone has no `.mise/.sync-hash` marker (it's gitignored). The
		// null-marker path must be treated as 'changed' so the first checkout syncs.
		const files = new Map<string, string>([["mise.toml", MISE_CONTENT]]);
		const spawn = recordingSpawn(0);
		const res = await runScript(MODULE, { files, argv: [], spawnSync: spawn.spawnSync });
		expect(spawn.calls, "missing marker must trigger the initial sync").toHaveLength(1);
		expect(files.get(".sync-hash")).toBe(`${MISE_HASH}\n`);
		expect(res.stdout).toContain("mise.toml changed — running sync.");
	});

	it("throws (fails loud) when `pnpm sync` exits non-zero — the marker is NOT advanced", async () => {
		// WHY: if the sync itself fails, auto.ts must NOT record the new hash (that
		// would mask the failure and make the next checkout skip the still-needed sync).
		// It throws so the hook fails visibly.
		const files = new Map<string, string>([
			["mise.toml", MISE_CONTENT],
			[".sync-hash", "stale\n"],
		]);
		const spawn = recordingSpawn(2); // non-zero exit from pnpm sync
		let result: HarnessResult | undefined;
		let thrown: unknown;
		try {
			result = await runScript(MODULE, { files, argv: [], spawnSync: spawn.spawnSync });
		} catch (error) {
			thrown = error;
		}
		expect(result).toBeUndefined();
		expect(String(thrown)).toContain("pnpm sync failed");
		expect(String(thrown)).toContain("exit 2");
		// The stale marker must remain unchanged (the throw happens before writeMarker).
		expect(files.get(".sync-hash")).toBe("stale\n");
	});

	it("reports 'signal' in the failure message when sync was killed (null status)", async () => {
		// WHY: a `pnpm sync` killed by a signal has status null, not a number. The
		// error message's `status ?? "signal"` must render 'signal' so the hook output
		// distinguishes a crash from a normal non-zero exit.
		const files = new Map<string, string>([
			["mise.toml", MISE_CONTENT],
			[".sync-hash", "stale\n"],
		]);
		let thrown: unknown;
		try {
			await runScript(MODULE, {
				files,
				argv: [],
				spawnSync: () => ({ status: null, stdout: "", stderr: "", signal: "SIGKILL" }),
			});
		} catch (error) {
			thrown = error;
		}
		expect(String(thrown)).toContain("pnpm sync failed (exit signal)");
		expect(files.get(".sync-hash")).toBe("stale\n");
	});
});
