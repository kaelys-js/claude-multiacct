// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// CLI-entry coverage for `fix-task.ts` — the TRP driver's top-level
// `if (isDirectRun()) { ... }` block. Programmatic `import { main }`
// callers skip that block, so its `.then(exit)` and `.catch(exit(1))`
// arms need dedicated coverage: reset the module registry, retarget
// `process.argv[1]`, mock `process.exit` as a recorder (no throw — the
// module continues on both arms, and a thrown sentinel would rewrite
// exit(2) into exit(1)), then dynamically re-import so v8 attributes
// the top-level branches to a running test.
//
// fix-task.ts imports `sh` from `@foundation/shell` transitively via
// several sibling modules. The mock hoist below keeps that dependency
// out of the CLI-contract tests: none of the code paths under test
// need a real subprocess call.

/* oxlint-disable vitest/no-conditional-in-test, vitest/require-mock-type-parameters, eslint/require-await, eslint/no-unused-vars */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeFsTypes from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<() => Promise<{ exitCode: number; stdout: string; stderr: string }>>(async () => ({
		exitCode: 0,
		stdout: "",
		stderr: "",
	})),
	stdioJournal: vi.fn(),
}));

const HERE = import.meta.dirname;
const MODULE_PATH = resolvePath(HERE, "fix-task.ts");
const NODE_BIN = process.argv[0] ?? "node";

// Env keys the driver reads/writes. Kept together so restoreEnv can put
// the process env back exactly as it was — otherwise a prior test could
// leak TRP_TASK_MODE into a later one and swap invalid-mode coverage
// into a valid-mode path.
const ENV_KEYS = [
	"TRP_TASK_MODE",
	"TRP_ALLOW_REMOTE_MUTATE",
	"TRP_ALLOW_INLINE_SPIKE",
	"TRP_ALLOW_CHILD_TICKET_CREATE",
	"TRP_PARALLEL_SAFE",
	"MISE_TRUSTED_CONFIG_PATHS",
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const k of keys) {
		out[k] = process.env[k];
	}
	return out;
}

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

// A single tick past the microtask boundary — lets the module's top-level
// `main().then(...).catch(...)` chain settle before we assert on the
// recorded exit codes.
async function flushImmediate(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

// Snapshot SIGINT/SIGTERM/SIGHUP listeners before each test and restore
// them after. The driver's runPipeline installs signal handlers that the
// finally block uninstalls — but tests that never reach the pipeline
// still shouldn't leave stray handlers between cases.
function snapshotSignals(): Record<string, NodeJS.SignalsListener[]> {
	const out: Record<string, NodeJS.SignalsListener[]> = {};
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		out[sig] = process.listeners(sig as NodeJS.Signals) as NodeJS.SignalsListener[];
	}
	return out;
}

function restoreSignals(orig: Readonly<Record<string, NodeJS.SignalsListener[]>>): void {
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		for (const l of process.listeners(sig)) {
			process.off(sig, l);
		}
		for (const l of orig[sig] ?? []) {
			process.on(sig, l);
		}
	}
}

describe("fix-task direct-run entry", () => {
	const originalArgv = process.argv;
	let originalEnv: Record<string, string | undefined>;
	let originalSignals: Record<string, NodeJS.SignalsListener[]>;
	let scratch: string;
	let origCwd: string;
	let exitCodes: number[];

	beforeEach(() => {
		originalEnv = snapshotEnv(ENV_KEYS);
		originalSignals = snapshotSignals();
		scratch = mkdtempSync(join(tmpdir(), "ft-cli-"));
		origCwd = process.cwd();
		process.chdir(scratch);
		exitCodes = [];
		// Recorder-only exit: throwing would send exit(2) failures down the
		// outer catch arm and every "returns 2" test would collapse into an
		// exit(1) assertion. Record and let the module finish naturally.
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
		}) as never);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.resetModules();
	});

	afterEach(() => {
		process.argv = originalArgv;
		process.chdir(origCwd);
		vi.restoreAllMocks();
		rmSync(scratch, { recursive: true, force: true });
		restoreEnv(ENV_KEYS, originalEnv);
		restoreSignals(originalSignals);
	});

	// ─── isDirectRun() short-circuit branches ─────────────────────

	// argv[1] === undefined → !entry short-circuit, top-level `if` never fires.
	it("skips main() when process.argv has no entry path", async () => {
		process.argv = [NODE_BIN];
		await import(`./fix-task.ts`);
		await flushImmediate();
		expect(exitCodes).toEqual([]);
	});

	// argv[1] === some ghost path → realpathSync throws in isDirectRun's
	// second try/catch, both compare paths fail, top-level `if` never fires.
	it("skips main() when argv[1] cannot be realpath'd", async () => {
		process.argv = [NODE_BIN, join(scratch, "ghost")];
		await import(`./fix-task.ts`);
		await flushImmediate();
		expect(exitCodes).toEqual([]);
	});

	// ─── main() early-return arms (exit code passed through .then) ───

	// `--help` bypasses every validation and returns 0 before touching
	// sfp.env / trp.env. Covers the `helpRequested` arm + the `.then(exit)`
	// success arm with a non-error return.
	it("prints usage and exits 0 when --help is passed", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--help"];
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([0]);
		const emitted = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("TRP driver");
	});

	// No positional `<TRACKER>:<TASK_ID>` arg → main() emits the "pass
	// <TRACKER>:<TASK_ID>" hint and returns 2. Confirms the missing-task
	// arm ships an actionable stderr line and the `.then(exit)` propagates
	// the non-zero return code untouched.
	it("errors with a usage hint and exits 2 when TASK_ID is missing", async () => {
		process.argv = [NODE_BIN, MODULE_PATH];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([2]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("pass <TRACKER>:<TASK_ID>");
	});

	// `--mode=<invalid>` names a mode outside VALID_TASK_MODES → main
	// rejects it up front, before touching sfp.env / trp.env. The stderr
	// line names the invalid value so the operator sees which flag to fix.
	it("rejects an invalid --mode= value with exit 2", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-1", "--mode=not-a-mode"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([2]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("invalid TRP_TASK_MODE");
		expect(emitted).toContain("not-a-mode");
	});

	// Cwd is the scratch dir → sfp.env does not exist there → the sfp.env
	// guard fires. Confirms the driver refuses to run without the env file
	// rather than silently proceeding with defaults.
	it("errors with exit 2 when sfp.env is missing from cwd", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-1"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([2]);
		expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("sfp.env missing"))).toBe(
			true,
		);
	});

	// sfp.env present, trp.env absent → the second env-file guard fires.
	// Distinct assertion from the sfp.env case so a regression that
	// collapses both guards into one path is caught.
	it("errors with exit 2 when trp.env is missing but sfp.env is present", async () => {
		writeFileSync(join(scratch, "sfp.env"), "");
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-1"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([2]);
		expect(stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes("trp.env missing"))).toBe(
			true,
		);
	});

	// An unknown argv flag routes parseArgs into the `process.exit(2)`
	// direct call. With the mock recording (not throwing), main falls
	// through: no task id gets set → main returns 2 as well. Two exit(2)
	// records confirm both the parseArgs guard AND the missing-task guard
	// fire on the same run, which is the observable contract.
	it("records exit 2 from parseArgs when an unknown arg is passed", async () => {
		process.argv = [NODE_BIN, MODULE_PATH, "--not-a-real-flag"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		// parseArgs' direct exit(2) + main's own exit(2) from `!TASK_ID`.
		expect(exitCodes.length).toBeGreaterThanOrEqual(1);
		expect(exitCodes.every((c) => c === 2)).toBe(true);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("unknown arg: --not-a-real-flag");
	});

	// ─── .catch(exit(1)) arm ──────────────────────────────────────

	// Force writeFileSync to throw when main() clears the log file at
	// stage-0 bootstrap. sfp.env + trp.env are present so main() gets past
	// the guard checks and hits the LOG write, which now throws. The
	// outer `.catch` writes the error's stack to stderr and calls exit(1)
	// — Error branch of `error instanceof Error ? error.stack ?? error.message : String(error)`.
	it(".catch arm prints an Error's stack and exits 1 when writeFileSync throws", async () => {
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			const realWrite = actual.writeFileSync;
			return {
				...actual,
				writeFileSync: vi.fn<typeof actual.writeFileSync>((path, data, opts) => {
					if (typeof path === "string" && path.includes("discovery/fix-log-")) {
						throw new Error("boom-log-write");
					}
					return realWrite(path, data, opts);
				}),
			};
		});
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-1"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("boom-log-write");
		vi.doUnmock("node:fs");
	});

	// Non-Error thrown value → the ternary's `String(error)` arm runs.
	// Kept as a separate case so a future refactor of the catch block
	// that drops the fallback stringification loses a test rather than
	// silently changing behaviour.
	it(".catch arm stringifies a non-Error throw and exits 1", async () => {
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof NodeFsTypes>();
			const realWrite = actual.writeFileSync;
			return {
				...actual,
				writeFileSync: vi.fn<typeof actual.writeFileSync>((path, data, opts) => {
					if (typeof path === "string" && path.includes("discovery/fix-log-")) {
						// eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise the non-Error branch of the catch arm's ternary
						throw "boom-not-an-error";
					}
					return realWrite(path, data, opts);
				}),
			};
		});
		process.argv = [NODE_BIN, MODULE_PATH, "clickup:HAND_ITC-1"];
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await import(`./fix-task.ts`);
		await flushImmediate();
		await flushImmediate();
		expect(exitCodes).toEqual([1]);
		const emitted = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
		expect(emitted).toContain("boom-not-an-error");
		vi.doUnmock("node:fs");
	});
});
