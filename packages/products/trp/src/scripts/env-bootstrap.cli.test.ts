// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// CLI-entry coverage for `env-bootstrap.ts`. The behaviour tests in
// `env-bootstrap.test.ts` drive `parseArgs`, `detectPm`, `findComposeFile`,
// and `main()` directly — they never take the top-level `invokedDirectly`
// branch that wires `main()` to `process.exit`. This file exists to cover
// exactly that block: the `import.meta.url === pathToFileURL(...)` guard,
// the happy-path `.then` arm that translates `main()`'s return code into an
// exit code, and the outer `catch` that stringifies real Errors (with and
// without `.stack`) versus a thrown non-Error value.
//
// Pattern: reset the module registry per test, retarget `process.argv[1]`
// to the module's real path so the URL comparison passes (or something
// else so it fails), mock `process.exit` as a recording no-op, then
// `await import("./env-bootstrap.ts")` — the module's top-level `await
// main()` runs inside the dynamic import's evaluation phase, so by the
// time the awaited import resolves every `process.exit` call the CLI
// block was going to make has already landed in `exitCodes`.
//
// `@foundation/shell` is hoist-mocked so `sh` can be steered per test —
// no real `pnpm` / `docker` child runs. `stdioJournal` is stubbed too;
// the impl calls it unconditionally on the non-dry-run path and a bare
// `sh`-only mock would leave it undefined at load time.

/* oxlint-disable typescript/explicit-function-return-type, vitest/require-mock-type-parameters */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<unknown>>(),
	stdioJournal: vi.fn(() => ({ stdout: () => {}, stderr: () => {} })),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = resolve(HERE, "env-bootstrap.ts");
const NODE_BIN = process.argv[0] ?? "node";

describe("env-bootstrap direct-run entry", () => {
	const originalArgv = process.argv;
	let scratch: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "eb-cli-"));
		exitCodes = [];
		// Recording no-op — the real process.exit would tear the vitest worker
		// down before the test can assert. `as never` because the type says
		// `exit` never returns.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
	});

	// ---- invokedDirectly === false: guard short-circuits ------------------

	// argv[1] === undefined: the `process.argv[1] !== undefined` half of the
	// AND fails before pathToFileURL is called. Nothing runs.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([]);
	});

	// argv[1] is a plausible path but not this module — URL comparison fails.
	// This is the state the module is in when imported by another test file
	// or by a wrapper script; must not invoke main() or exit.
	it("skips main() when argv[1] resolves to a different module URL", async () => {
		process.argv = [NODE_BIN, join(scratch, "some-other-entry.ts"), "--dry-run"];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([]);
	});

	// ---- invokedDirectly === true, main resolves cleanly ------------------

	// `--help` returns 0 from main without touching the fs or sh. Verifies
	// the `.then` arm converts main()'s 0 into `process.exit(0)` exactly
	// once, and that no error handling ran.
	it("main() -> 0 for --help: exit(0) is called exactly once", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--help"];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([0]);
	});

	// Empty scratch dir + --dry-run: install stage prints SKIP, compose
	// stage finds nothing, main returns 0. No sh call means the test is
	// insulated from any mock leakage between beforeEach and here.
	it("main() -> 0 on a dry-run empty fix-src: exit(0), sh never called", async () => {
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		process.argv = [NODE_BIN, MODULE_PATH, scratch, "--dry-run"];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([0]);
		expect(mockedSh).not.toHaveBeenCalled();
	});

	// parseArgs returns err(2) for an unknown flag; main() propagates that
	// as its return code. The `.then` arm must forward the 2 verbatim — a
	// silent 0 here would tell the auto-repair loop the fix-src is fine
	// when in fact the operator typoed a flag.
	it("main() -> 2 for an unknown flag: exit(2) is forwarded verbatim", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--bogus", scratch];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([2]);
	});

	// RunError translation: sh returns non-zero, run() throws RunError with
	// that code, main's inner try/catch maps it to a return value. The
	// direct-run block sees the numeric return and calls exit(N). This
	// specifically covers `const code = await main(); process.exit(code)`
	// with a non-zero, non-error path — the only wire that keeps the
	// install-failed exit code visible to the driver.
	it("main() -> N for a non-zero install exit: exit(N) is forwarded", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		mockedSh.mockResolvedValueOnce({
			command: "pnpm",
			args: ["install"],
			exitCode: 7,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
		} as never);
		process.argv = [NODE_BIN, MODULE_PATH, scratch];
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([7]);
	});

	// ---- invokedDirectly === true, main throws → outer catch --------------

	// A non-RunError exception from sh propagates out of main() because
	// main's inner catch only handles RunError. The outer catch writes
	// error.stack (present on real Error instances) to stderr and exits 1.
	it("catch arm: real Error with .stack — writes stack to stderr and exit(1)", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		const err = new Error("shell blew up");
		// Force a deterministic stack so the assertion below is not brittle
		// against V8's exact formatting.
		err.stack = "Error: shell blew up\n    at test-forced-stack";
		mockedSh.mockRejectedValueOnce(err);
		process.argv = [NODE_BIN, MODULE_PATH, scratch];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([1]);
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("Error: shell blew up");
		expect(written).toContain("test-forced-stack");
	});

	// The `error.stack ?? error.message` nullish arm: an Error with stack
	// deleted must fall back to `.message`, not to `String(error)` (which
	// would render as "Error: <msg>" and duplicate the "Error: " prefix).
	it("catch arm: Error with no .stack — falls back to .message and exit(1)", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		const err = new Error("stackless-boom");
		err.stack = undefined;
		mockedSh.mockRejectedValueOnce(err);
		process.argv = [NODE_BIN, MODULE_PATH, scratch];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([1]);
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("stackless-boom");
		// String(new Error("x")) → "Error: x"; if the fallback wrongly went
		// through the `String(error)` arm we'd see that prefix.
		expect(written).not.toContain("Error: stackless-boom");
	});

	// The `error instanceof Error ? ... : String(error)` false arm: only
	// hit when something that isn't an Error propagates out of main(). Any
	// primitive works — a string is the least ambiguous.
	it("catch arm: thrown non-Error — falls through to String(error) and exit(1)", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		const { sh } = await import("@foundation/shell");
		const mockedSh = vi.mocked(sh);
		// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error to exercise the fallback branch
		mockedSh.mockImplementationOnce(() => {
			throw "boom-not-an-error";
		});
		process.argv = [NODE_BIN, MODULE_PATH, scratch];
		const stderrSpy = vi.spyOn(process.stderr, "write");
		await import(`./env-bootstrap.ts`);
		expect(exitCodes).toEqual([1]);
		const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(written).toContain("boom-not-an-error");
	});
});
