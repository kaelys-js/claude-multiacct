// Integration tests for the lefthook integrity gate (packages/shared/utils/qa/src/lefthook-check.ts).
//
// This gate closes a real gap the Stage-0 config relocation opened: the root
// `lefthook.yml` is a thin stub that `extends` the moved base in
// `packages/shared/config/`. `lefthook validate` returns "All good" EVEN WHEN
// that extends target is missing, so a moved/renamed base would leave validate
// green while every git hook silently stopped firing. This wrapper asserts the
// MERGED `lefthook dump` still contains every expected hook and fails loud if not.
//
// ROOT is resolved via @foundation/core's repoRoot(), which we mock (stubbed to a
// fixed root, no git call), so the `node:child_process` spawnSync mock drives
// `lefthook dump` deterministically:
//   • dump exits 0, all hooks present   → gate exits 0
//   • dump exits 0, a hook missing      → gate exits 1 (the gap it closes)
//   • dump exits non-zero               → gate exits with dump's code
//
// Rule 9 — the guarantee is that a broken lefthook `extends` (missing hooks) can
// NEVER pass silently; the missing-hook test is the one that would fail if that
// promotion regressed.

import { describe, it, expect, vi, afterEach } from "vitest";

const spawnSyncMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]): unknown => spawnSyncMock(...args),
}));

// Stub the repo root so the module makes no real git call — the `spawnSync` mock
// then sees ONLY the `pnpm exec lefthook dump` invocation under test.
vi.mock("@foundation/core", () => ({
	repoRoot: (): string => "/repo",
}));

const MODULE = "../src/lefthook-check.ts";

type DumpResult = { status: number | null; stdout: string; stderr: string };

// A `lefthook dump` YAML fragment containing exactly the given top-level hooks.
function dumpWith(hooks: readonly string[]): string {
	return `${hooks.map((h) => `${h}:\n  commands:\n    x:\n      run: echo`).join("\n")}\n`;
}

const ALL_HOOKS = ["commit-msg", "pre-commit", "pre-push", "post-checkout", "post-merge"];

// Import the gate fresh with `lefthook dump` mocked to a fixed result; capture its
// exit code and the text it echoed.
async function runGate(
	result: DumpResult,
): Promise<{ code: number | null; out: string; err: string }> {
	spawnSyncMock.mockReturnValue(result);
	let code: number | null = null;
	let out = "";
	let err = "";
	vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
		code = c ?? 0;
		throw new Error("EXIT");
	}) as never);
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err += String(chunk);
		return true;
	});
	try {
		await import(MODULE);
	} catch (error) {
		if ((error as Error).message !== "EXIT") {
			throw error;
		}
	}
	return { code, out, err };
}

describe("lefthook-check", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		spawnSyncMock.mockReset();
	});

	it("invokes `lefthook dump` through pnpm from the repo root", async () => {
		await runGate({ status: 0, stdout: dumpWith(ALL_HOOKS), stderr: "" });
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [call] = spawnSyncMock.mock.calls;
		expect(call?.[0]).toBe("pnpm");
		expect(call?.[1]).toEqual(["exec", "lefthook", "dump"]);
	});

	it("passes (exit 0) when the merged dump contains every expected hook", async () => {
		// WHY: the healthy case — stub `extends` resolved, so all five hooks survive
		// the merge. The gate must not false-positive here or every push fails.
		const { code, out } = await runGate({ status: 0, stdout: dumpWith(ALL_HOOKS), stderr: "" });
		expect(code).toBe(0);
		expect(out).toContain("all 5 expected hooks present");
	});

	it("FAILS (exit 1) naming the missing hook when the extends collapsed the merge", async () => {
		// WHY (the gap this closes): a broken/unresolvable `extends` drops the base's
		// hooks from `dump` while `lefthook validate` still says "All good". Dropping
		// `pre-push` must be caught and named, not sail through.
		const { code, err } = await runGate({
			status: 0,
			stdout: dumpWith(["commit-msg", "pre-commit", "post-checkout", "post-merge"]),
			stderr: "",
		});
		expect(code).toBe(1);
		expect(err).toContain("MISSING hook(s): pre-push");
		expect(err).toContain("extends");
	});

	it("FAILS with dump's own exit code when `lefthook dump` itself errors", async () => {
		// WHY: a dump failure (e.g. malformed config) must surface, not be swallowed.
		const { code, err } = await runGate({ status: 3, stdout: "", stderr: "dump: boom" });
		expect(code).toBe(3);
		expect(err).toContain("dump: boom");
		expect(err).toContain("cannot verify hook integrity");
	});

	it("FAILS with exit 1 when dump reports a null status (killed by signal, no code)", async () => {
		// WHY: a spawn that dies without an exit code (null) must still fail closed, not
		// coerce to 0 — the `status ?? 1` fallback guards that.
		const { code } = await runGate({ status: null, stdout: "", stderr: "" });
		expect(code).toBe(1);
	});
});
