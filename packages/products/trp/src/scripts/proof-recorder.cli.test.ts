// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// CLI-entry coverage for `proof-recorder.ts`. The programmatic
// `import { main }` path skips the top-level `if (import.meta.url === ...)`
// direct-run block, so the `.then(exit)` / `.catch(...stack.../exit(1))`
// arms are otherwise uncovered. These tests reset the module registry,
// retarget `process.argv[1]` per case, mock `process.exit` as a no-op
// recorder, then dynamically re-import so v8 attributes the top-level
// branches to a running test.
//
// `@foundation/shell` is mocked so `sh()` cannot spawn a real subprocess —
// help + missing-arg paths never reach sh(), but the mock is here so if
// main() ever slips into a modality dispatch the test fails deterministic-
// ally rather than flakily calling out to the host toolchain.

/* oxlint-disable eslint/require-await, unicorn/param-names */

import { mkdtempSync, rmSync } from "node:fs";
import type * as NodeFsTypes from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<unknown>>(async () => ({
		stdout: "",
		stderr: "",
		exitCode: 0,
	})),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = resolvePath(HERE, "proof-recorder.ts");
const NODE_BIN = process.argv[0] ?? "node";
const ENV_KEYS = ["PROOF_MODALITY", "PROOF_SCRIPT", "TEST_CMD"] as const;

function restoreEnv(
	keys: readonly string[],
	orig: Readonly<Record<string, string | undefined>>,
): void {
	for (const k of keys) {
		const v = orig[k];
		if (v === undefined) {
			Reflect.deleteProperty(process.env, k);
		} else {
			process.env[k] = v;
		}
	}
}

function clearEnv(keys: readonly string[]): void {
	for (const k of keys) {
		Reflect.deleteProperty(process.env, k);
	}
}

// Yield twice on the microtask queue — the module's top-level
// `main().then(...).catch(...)` chain schedules its handler after the
// dynamic import resolves, so a single flush is not enough.
async function flushImmediate(): Promise<void> {
	await new Promise<void>((r) => {
		setImmediate(r);
	});
}

describe("proof-recorder direct-run entry", () => {
	const originalArgv = process.argv;
	const originalEnv: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) {
		originalEnv[k] = process.env[k];
	}
	let scratch: string;
	let origCwd: string;
	let exitCodes: number[];

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pr-cli-"));
		origCwd = process.cwd();
		// chdir so any incidental `mkdirSync("discovery/proof/...")` during a
		// happy-path invocation lands in the scratch dir, not the repo root.
		process.chdir(scratch);
		exitCodes = [];
		// Recording no-op exit: the direct-run block's success arm calls
		// `process.exit(code)`. Throwing here would propagate into the outer
		// `.catch(...)` and rewrite exit(0) as exit(1); recording without
		// throwing lets the module finish so we can assert on the code.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		clearEnv(ENV_KEYS);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.chdir(origCwd);
		vi.restoreAllMocks();
		vi.doUnmock("node:fs");
		rmSync(scratch, { recursive: true, force: true });
		restoreEnv(ENV_KEYS, originalEnv);
	});

	// Direct-run false path: `pathToFileURL("").href` never equals the module's
	// own URL, so the top-level `if (...)` short-circuits and main() never runs.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		expect(exitCodes).toEqual([]);
	});

	// Direct-run false path: an unrelated argv[1] produces a file URL that
	// does not match the module's own — same short-circuit as above but
	// exercises the compare with a non-empty right-hand side.
	it("skips main() when argv[1] points at an unrelated file", async () => {
		process.argv = [NODE_BIN, join(scratch, "not-proof-recorder.ts")];
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		expect(exitCodes).toEqual([]);
	});

	// Direct-run true, main() resolves 0 via the `--help` short path. Covers
	// the `.then((code) => process.exit(code))` arm with a non-error code.
	it(".then arm calls exit(0) when main() resolves 0 (--help)", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--help"];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([0]);
		// USAGE banner should have been written to stdout before exit.
		const emitted = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("proof-recorder.sh");
		expect(emitted).toContain("Modalities");
	});

	// Direct-run true, main() resolves non-zero via missing --task. Covers
	// the `.then((code) => process.exit(code))` arm with a non-zero code —
	// distinct from the .catch arm because parseArgs returns { kind: "err" }
	// cleanly instead of throwing.
	it(".then arm forwards the exit code when main() resolves non-zero", async () => {
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([2]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("ERROR: --task required");
	});

	// Direct-run true, main() throws an Error whose `.stack` is set — the
	// `.catch` arm should write that stack and exit(1). We force mkdirSync
	// to throw so main() aborts after arg parsing.
	it(".catch arm writes error.stack and calls exit(1) when main() throws an Error with a stack", async () => {
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			return {
				...actual,
				mkdirSync: vi.fn<() => never>(() => {
					const err = new Error("boom-with-stack");
					err.stack = "STACKTRACE:boom-with-stack";
					throw err;
				}),
			};
		});
		process.argv = [NODE_BIN, MODULE_PATH, "--task", "T-1", "--modality", "iac"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("STACKTRACE:boom-with-stack");
	});

	// Same catch arm but the Error has no `.stack` — the `error.stack ?? error.message`
	// nullish-coalesce must fall to `.message`.
	it(".catch arm falls back to error.message when the thrown Error has no stack", async () => {
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			return {
				...actual,
				mkdirSync: vi.fn<() => never>(() => {
					const err = new Error("stackless-boom");
					err.stack = undefined;
					throw err;
				}),
			};
		});
		process.argv = [NODE_BIN, MODULE_PATH, "--task", "T-2", "--modality", "iac"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("stackless-boom");
		expect(emitted).not.toContain("STACKTRACE:");
	});

	// Catch arm with a thrown non-Error — the ternary's false arm invokes
	// `String(error)` instead of touching `.stack` / `.message`.
	it(".catch arm stringifies a thrown non-Error value instead of reading .stack", async () => {
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			return {
				...actual,
				mkdirSync: vi.fn<() => never>(() => {
					// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error to exercise the fallback branch
					throw "boom-not-an-error";
				}),
			};
		});
		process.argv = [NODE_BIN, MODULE_PATH, "--task", "T-3", "--modality", "iac"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./proof-recorder.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("boom-not-an-error");
	});
});
