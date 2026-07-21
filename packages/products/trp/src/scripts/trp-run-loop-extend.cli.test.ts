// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// CLI-entry coverage for `trp-run-loop-extend.ts`. The behaviour tests in
// `trp-run-loop-extend.test.ts` drive every exported helper + `main()`
// directly, but they never take the top-level `isDirectRun()` branch that
// wires `main()` to `process.exit`. This file exists to cover exactly
// that block:
//
//   - `isDirectRun()` all forms — argv[1] undefined, URL matches,
//     URL doesn't match but realpath does, both fail.
//   - The happy-path `await main(); process.exit(code)` arm — a mocked
//     `sh` returns cleanly, main() returns a numeric code, exit(code)
//     lands in `exitCodes`.
//   - The outer `catch` — `sh` rejects with an Error / a non-Error,
//     stderr carries the "unexpected error" line, exit(1) fires.
//
// Pattern (borrowed from `env-bootstrap.cli.test.ts`): reset the module
// registry per test, retarget `process.argv[1]` so the URL comparison
// passes (or something else so it fails), mock `process.exit` as a
// recording no-op, then `await import("./trp-run-loop-extend.ts")` —
// the module's top-level `await main()` runs inside the dynamic import's
// evaluation phase, so by the time the await resolves every `exit` call
// has already landed in `exitCodes`.
//
// `@foundation/shell` is hoist-mocked so `sh` is a driveable spy — no
// real subprocess runs, and the outer catch can be exercised by making
// `sh` throw.

/* oxlint-disable typescript/explicit-function-return-type, vitest/require-mock-type-parameters */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<unknown>>(),
	stdioJournal: vi.fn(() => ({ stdout: () => {}, stderr: () => {} })),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "trp-run-loop-extend.ts");
const NODE_BIN = process.argv[0] ?? "node";

// Helper — a canonical clean sh result. Tests override only the fields
// they care about, so the rest stay stable across runs.
function mkShResult(exitCode: number) {
	return {
		command: "node",
		args: ["./scripts/fix-task.ts"],
		exitCode,
		signal: undefined,
		stdout: "",
		stderr: "",
		timedOut: false,
		durationMs: 1,
	} as never;
}

describe("trp-run-loop-extend direct-run entry", () => {
	const originalArgv = process.argv;
	const originalCwd = process.cwd();
	let scratch: string;
	let exitCodes: number[];
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "trp-run-loop-extend-cli-"));
		// Every test runs in scratch so the wrapper's `mkdirSync("discovery")`
		// lands somewhere writable, not in the repo tree.
		mkdirSync(join(scratch, "discovery"), { recursive: true });
		process.chdir(scratch);
		exitCodes = [];
		// Save + clear env vars the wrapper reads. Tests set them per-case.
		for (const key of [
			"TRP_ALLOW_REMOTE_MUTATE",
			"TRP_TASK_MODE",
			"TRP_BUNDLE_FIXTURE_PATH",
		] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.chdir(originalCwd);
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	// ---------- isDirectRun === false paths ----------

	// argv[1] === undefined: the `entry === undefined` guard returns
	// false immediately without touching pathToFileURL or realpathSync.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([]);
	});

	// argv[1] is a real file but not this module. Both the URL check
	// AND the realpath check must return false — module.exports of `main`
	// still work via the earlier direct import, but the top-level block
	// stays quiet.
	it("skips main() when argv[1] resolves to an unrelated file", async () => {
		const otherFile = join(scratch, "some-other-entry.ts");
		writeFileSync(otherFile, "// unrelated\n");
		process.argv = [NODE_BIN, otherFile, "--dry-run"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([]);
	});

	// argv[1] points at a completely nonexistent path. The URL check
	// silently doesn't match (pathToFileURL doesn't throw on plausible
	// path strings — it just returns a URL that isn't ours); the
	// realpathSync fallback throws ENOENT, the catch swallows it, and
	// isDirectRun returns false. Confirms the second-catch arm doesn't
	// let a stray path trigger a spurious run.
	it("skips main() when argv[1] points at a nonexistent file", async () => {
		process.argv = [NODE_BIN, join(scratch, "does-not-exist.ts"), "--dry-run"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([]);
	});

	// ---------- isDirectRun === true: URL-match path ----------

	// argv[1] === real module path → `pathToFileURL(resolve(entry)).href
	// === import.meta.url` → true; the fallback realpath check isn't
	// reached. main() runs, returns 0 for --help.
	it("main() -> 0 for --help via URL match: exit(0) called exactly once", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--help"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// Bare invocation with no argv beyond the module path — main() emits
	// USAGE to stderr and returns 2. The direct-run arm forwards that 2
	// verbatim; a regression that silently maps 2 → 0 would let an
	// operator's typo look like success.
	it("main() -> 2 for bare invocation: exit(2) forwarded verbatim", async () => {
		process.argv = [NODE_BIN, MODULE_PATH];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([2]);
	});

	// Driver exit 66 → main returns 66 → outer arm calls exit(66). This
	// pins the auto-repair loop signal at the CLI entry boundary — the
	// wrapper's HALT trailer + exit code are the only signal SRP-J has
	// to know a revise round is needed.
	it("main() -> 66 when the driver exits 66: exit(66) forwarded verbatim", async () => {
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		mockedSh.mockResolvedValueOnce(mkShResult(66));
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-308"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([66]);
	});

	// Same pattern for the HARD FAIL branch (any non-0/66/67 code).
	// Explicit test because the exit-code arms are conceptually distinct
	// even if the CLI translation is one `process.exit(code)`.
	it("main() -> 5 when the driver exits 5: exit(5) forwarded verbatim (HARD FAIL)", async () => {
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		mockedSh.mockResolvedValueOnce(mkShResult(5));
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-308"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([5]);
	});

	// ---------- isDirectRun === true: realpath-fallback path ----------

	// argv[1] === a symlink to the module. The URL check computes
	// `pathToFileURL(resolve(symlink)).href` which does NOT match
	// `import.meta.url` (different path), so the fallback runs and
	// `realpathSync(link)` resolves to the real module path — match →
	// true. main() runs and returns 0 for --help.
	it("main() runs via realpath fallback when argv[1] is a symlink to this module", async () => {
		const link = join(scratch, "extend-bin-symlink.ts");
		symlinkSync(MODULE_PATH, link);
		process.argv = [NODE_BIN, link, "--help"];
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// ---------- outer catch: sh rejects with a real Error ----------

	// When sh throws, main() propagates the throw (there's no inner
	// catch in main), the outer arm catches it, writes the "unexpected
	// error" line to stderr, and exits 1. WHY: the file-loader failing
	// on a `node ./scripts/fix-task.ts` invocation still needs to fail
	// loud with an exit code the auto-repair loop can key on.
	it("catch arm: real Error propagates through main to exit(1) + stderr line", async () => {
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		mockedSh.mockRejectedValueOnce(new Error("shell blew up"));
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-308"];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([1]);
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("trp-run-loop-extend: unexpected error:");
		expect(written).toContain("shell blew up");
	});

	// A non-Error thrown value (a string) hits the `String(error)`
	// fallback — the outer catch's typed handler doesn't assume Error.
	it("catch arm: non-Error throw is stringified into the stderr line", async () => {
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error to exercise the String() fallback branch
		mockedSh.mockImplementationOnce(() => {
			throw "boom-not-an-error";
		});
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-308"];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./trp-run-loop-extend.ts`);
		expect(exitCodes).toEqual([1]);
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("boom-not-an-error");
	});
});
