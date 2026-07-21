// Unit tests for @foundation/core's repoRoot().
//
// WHY it matters: this replaced the fragile `join(import.meta.dirname, "..", "..")`
// arithmetic that silently pointed at the wrong directory once a script moved
// deeper. The guarantee is (1) it returns git's toplevel, trimmed, and (2) it
// falls back to the process CWD when git yields nothing — so a caller never gets
// an empty root.

import { describe, it, expect, vi, afterEach } from "vitest";

const spawnSyncMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]): unknown => spawnSyncMock(...args),
}));

const MODULE = "../src/repo-root.ts";

afterEach(() => {
	vi.resetModules();
	spawnSyncMock.mockReset();
});

describe("repoRoot", () => {
	it("returns git's toplevel path, trimmed, via `git rev-parse --show-toplevel`", async () => {
		spawnSyncMock.mockReturnValue({ stdout: "/repo/root\n" });
		const { repoRoot } = await import(MODULE);
		expect(repoRoot()).toBe("/repo/root");
		const [call] = spawnSyncMock.mock.calls;
		expect(call?.[0]).toBe("git");
		expect(call?.[1]).toEqual(["rev-parse", "--show-toplevel"]);
	});

	it("falls back to process.cwd() when git yields no output (not a git repo)", async () => {
		spawnSyncMock.mockReturnValue({ stdout: "" });
		const { repoRoot } = await import(MODULE);
		expect(repoRoot()).toBe(process.cwd());
	});
});
