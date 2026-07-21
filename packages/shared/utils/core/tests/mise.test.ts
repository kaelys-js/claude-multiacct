// Unit tests for @foundation/core's miseExec().
//
// WHY it matters: every QA/sync tool runs through `bin/mise exec -- <args>` so
// versions come from mise.toml. The guarantee is (1) it invokes the repo-root
// `bin/mise` with `exec --` prepended and cwd = repo root + utf8 capture, and
// (2) caller opts override those defaults (e.g. `stdio: "inherit"` for the live
// dispatch output).

import { describe, it, expect, vi, afterEach } from "vitest";

const spawnSyncMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]): unknown => spawnSyncMock(...args),
}));

// Stub the root so the mise binary path is deterministic and no git call is made.
vi.mock("../src/repo-root.ts", () => ({ repoRoot: (): string => "/repo" }));

const MODULE = "../src/mise.ts";

afterEach(() => {
	vi.resetModules();
	spawnSyncMock.mockReset();
});

describe("miseExec", () => {
	it("runs `bin/mise exec -- <args>` from the repo root with utf8 capture", async () => {
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "ok" });
		const { miseExec } = await import(MODULE);
		const result = miseExec(["oxlint", "."]);
		expect(result).toEqual({ status: 0, stdout: "ok" });
		const [call] = spawnSyncMock.mock.calls;
		expect(String(call?.[0])).toBe("/repo/bin/mise");
		expect(call?.[1]).toEqual(["exec", "--", "oxlint", "."]);
		expect(call?.[2]).toMatchObject({ cwd: "/repo", encoding: "utf8" });
	});

	it("lets caller opts override the defaults (e.g. stdio inherit)", async () => {
		spawnSyncMock.mockReturnValue({ status: 0 });
		const { miseExec } = await import(MODULE);
		miseExec(["ec"], { stdio: "inherit" });
		const [call] = spawnSyncMock.mock.calls;
		expect(call?.[2]).toMatchObject({ cwd: "/repo", stdio: "inherit" });
	});
});
