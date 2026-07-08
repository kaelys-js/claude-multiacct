// Tests for the lint entrypoint (scripts/qa/lint.ts).
//
// lint.ts is a thin CLI shim: parse argv → call run("lint", …) → exit 0/1 on the
// result. Rule 9 — the guarantee under test is the exit-code contract (a failed
// lint MUST exit non-zero, or CI/pre-push would go green on a real failure) and
// the "files → staged, none → whole-repo" translation. dispatch.run is mocked so
// the shim's own wiring is what's exercised, not the whole toolchain.

import { describe, it, expect, vi, afterEach } from "vitest";

const runMock = vi.fn<(mode: string, staged: string[] | null, only: string | null) => boolean>();

vi.mock("../../scripts/qa/dispatch.ts", () => ({
	run: (mode: string, staged: string[] | null, only: string | null): boolean =>
		runMock(mode, staged, only),
}));

async function importLint(argv: readonly string[], runReturns: boolean): Promise<number> {
	runMock.mockReturnValue(runReturns);
	process.argv = ["node", "lint.ts", ...argv];
	let exitCode = -1;
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCode = code ?? 0;
		throw new Error("EXIT");
	}) as never);
	await expect(import("../../scripts/qa/lint.ts")).rejects.toThrow("EXIT");
	return exitCode;
}

describe("lint.ts entrypoint", () => {
	const origArgv = process.argv;

	afterEach(() => {
		process.argv = origArgv;
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("exits 0 when the lint run succeeds", async () => {
		const code = await importLint([], true);
		expect(code).toBe(0);
		expect(runMock).toHaveBeenCalledWith("lint", null, null);
	});

	it("exits 1 when the lint run fails (the CI gate)", async () => {
		const code = await importLint([], false);
		expect(code).toBe(1);
	});

	it("passes staged files as the staged list and forwards --only", async () => {
		const code = await importLint(["--only", "oxlint", "a.ts", "b.ts"], true);
		expect(code).toBe(0);
		expect(runMock).toHaveBeenCalledWith("lint", ["a.ts", "b.ts"], "oxlint");
	});
});
