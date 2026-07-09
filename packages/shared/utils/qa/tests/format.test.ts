// Tests for the format entrypoint (packages/shared/utils/qa/src/format.ts).
//
// format.ts is the formatter shim: parse argv → pick format-check vs
// format-write from --check → call run(mode, …) → exit on the result. Rule 9 —
// the guarantees under test are (a) --check selects the non-destructive
// format-check mode (a miss would rewrite files in a CI verify pass) and (b) the
// exit code reflects the run. dispatch.run is mocked to isolate the shim.

import { describe, it, expect, vi, afterEach } from "vitest";

const runMock = vi.fn<(mode: string, staged: string[] | null, only: string | null) => boolean>();

vi.mock("../src/dispatch.ts", () => ({
	run: (mode: string, staged: string[] | null, only: string | null): boolean =>
		runMock(mode, staged, only),
}));

async function importFormat(argv: readonly string[], runReturns: boolean): Promise<number> {
	runMock.mockReturnValue(runReturns);
	process.argv = ["node", "format.ts", ...argv];
	let exitCode = -1;
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCode = code ?? 0;
		throw new Error("EXIT");
	}) as never);
	await expect(import("../src/format.ts")).rejects.toThrow("EXIT");
	return exitCode;
}

describe("format.ts entrypoint", () => {
	const origArgv = process.argv;

	afterEach(() => {
		process.argv = origArgv;
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it("defaults to format-write and exits 0 on success", async () => {
		// No --check → the destructive write mode; whole-repo (no files) → null.
		const code = await importFormat([], true);
		expect(code).toBe(0);
		expect(runMock).toHaveBeenCalledWith("format-write", null, null);
	});

	it("selects format-check when --check is present", async () => {
		// --check must map to the non-destructive verify mode.
		const code = await importFormat(["--check"], true);
		expect(code).toBe(0);
		expect(runMock).toHaveBeenCalledWith("format-check", null, null);
	});

	it("exits 1 when the format run reports a failure", async () => {
		const code = await importFormat(["--check"], false);
		expect(code).toBe(1);
	});

	it("forwards --only and staged files", async () => {
		const code = await importFormat(["--only", "oxfmt", "a.ts"], true);
		expect(code).toBe(0);
		expect(runMock).toHaveBeenCalledWith("format-write", ["a.ts"], "oxfmt");
	});
});
