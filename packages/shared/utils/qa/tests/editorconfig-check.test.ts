// Integration tests for the editorconfig gate (packages/shared/utils/qa/src/editorconfig-check.ts).
//
// This wrapper closes a real `ec` gap: `ec` prints a `.editorconfig` PARSE error
// to stderr but still exits 0, so a malformed `.editorconfig` would sail through
// `qa:lint`. The wrapper promotes that stderr signature (and any non-zero `ec`
// exit) to a hard failure.
//
// editorconfig-check resolves ROOT via @foundation/core's repoRoot() and runs `ec`
// via miseExec, so we mock @foundation/core (repoRoot stubbed, miseExec returning
// controlled `ec` outputs) to drive the three outcomes deterministically:
//   • ec exits 0, clean output              → wrapper exits 0
//   • ec exits non-zero (conformance fail)  → wrapper exits with ec's code
//   • ec exits 0 but emits a parse-error    → wrapper exits 1 (the gap it closes)
//
// Rule 9 — the guarantee is that a broken `.editorconfig` can NEVER pass silently
// on ec's exit-0; the parse-error test is the one that would fail if that
// promotion regressed.

import { describe, it, expect, vi, afterEach } from "vitest";

const miseExecMock = vi.fn<(...args: unknown[]) => unknown>();

// The wrapper resolves the repo root and runs `ec` through @foundation/core, so we
// mock BOTH: `repoRoot` is stubbed (no real git call) and `miseExec` returns a
// fixed `ec` result that drives the three outcomes deterministically.
vi.mock("@foundation/core", () => ({
	repoRoot: (): string => "/repo",
	miseExec: (...args: unknown[]): unknown => miseExecMock(...args),
}));

const MODULE = "../src/editorconfig-check.ts";

type EcResult = { status: number | null; stdout: string; stderr: string };

// Import the wrapper fresh with `ec` mocked to a fixed result; capture its exit
// code and the combined text it echoed to stdout/stderr.
async function runWrapper(
	result: EcResult,
): Promise<{ code: number | null; out: string; err: string }> {
	miseExecMock.mockReturnValue(result);
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

describe("editorconfig-check", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		miseExecMock.mockReset();
	});

	it("runs `ec` through @foundation/core's miseExec with the relocated --config", async () => {
		await runWrapper({ status: 0, stdout: "", stderr: "" });
		expect(miseExecMock).toHaveBeenCalledTimes(1);
		const [call] = miseExecMock.mock.calls;
		const args = call?.[0] as string[];
		// ec has no `extends`, so its config lives in @foundation/config and is reached
		// by `--config`; a bare `ec` would silently use built-in defaults. miseExec
		// prepends `bin/mise exec --`, so we assert on the tool args it receives.
		expect(args).toEqual(["ec", "--config", "packages/shared/config/editorconfig-checker.json"]);
	});

	it("exits 0 and echoes ec's output on a clean pass", async () => {
		// The happy path: ec exits 0 with no parse-error signature → wrapper exits 0
		// and forwards ec's stdout so real conformance output stays visible.
		const { code, out } = await runWrapper({
			status: 0,
			stdout: "0 errors\n",
			stderr: "",
		});
		expect(code).toBe(0);
		expect(out).toContain("0 errors");
	});

	it("propagates ec's non-zero exit (a real conformance failure)", async () => {
		// A genuine conformance failure: ec exits non-zero; the wrapper must exit with
		// the SAME code, not swallow it.
		const { code, err } = await runWrapper({
			status: 2,
			stdout: "x.md: wrong indent\n",
			stderr: "",
		});
		expect(code).toBe(2);
		expect(err).toBe(""); // stderr was empty; only stdout carried findings
	});

	it("defaults a null ec status to 1 (spawn failure)", async () => {
		// spawnSync returns status null when the process couldn't be spawned; the
		// `?? 1` fallback must treat that as a failure, not a pass.
		const { code } = await runWrapper({ status: null, stdout: "", stderr: "" });
		expect(code).toBe(1);
	});

	it("fails (exit 1) when ec exits 0 but reports a .editorconfig parse error", async () => {
		// THE gap this wrapper exists to close: ec prints the parse-error signature to
		// stderr yet exits 0. The wrapper must promote it to exit 1.
		const { code, err } = await runWrapper({
			status: 0,
			stdout: "",
			stderr: 'error: cannot parse the ini file ".editorconfig"\n',
		});
		expect(code).toBe(1);
		expect(err).toContain("parse error but exited 0");
	});

	it("also catches the alternate 'error loading ini file' parse signature", async () => {
		// The second signature the gate recognises — same promotion to exit 1.
		const { code } = await runWrapper({
			status: 0,
			stdout: "",
			stderr: 'error loading ini file ".editorconfig": bad line\n',
		});
		expect(code).toBe(1);
	});

	it("does NOT fail exit-0 output that merely mentions editorconfig without the signature", async () => {
		// A benign line naming .editorconfig must not trip the parse-error gate — the
		// gate keys on the exact signatures, not the filename, so normal runs pass.
		const { code } = await runWrapper({
			status: 0,
			stdout: "Using .editorconfig from repo root\n",
			stderr: "",
		});
		expect(code).toBe(0);
	});
});
