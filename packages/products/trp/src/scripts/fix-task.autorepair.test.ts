// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Auto-repair-loop behavior tests for `fix-task.ts` — one per (stage, attempt)
// pairing across the six pipeline stages that route through the emitTrpJFailure
// helper: {5 apply-patch, 6 client CI, 7 POC verify, 7b docker attack,
// 8 pre-commit hook, 8b push rejected} × {1, 2}. Fixtures live under
// `tests/fixtures/composed-run/auto-repair/stage-<N>-attempt<M>.json` and
// encode the auto-repair loop's cross-attempt contract:
//
//   - prior_bundle       — what the previous attempt tried (null on attempt 1)
//   - prior_failure      — the trp-fail JSON the REVISE workflow consumed to
//                          author the current attempt's bundle (null on a1)
//   - emit_env           — env vars fix-task.ts's emitTrpJFailure sets before
//                          it calls emit-trp-failure main(); pins STAGE_LABEL,
//                          FAILING_CMD, and ATTEMPT so the produced fail JSON
//                          carries the right shape downstream
//   - expected           — exit code, stage_label, attempt_number, and the
//                          on-disk trp-fail path the loop writes for main
//                          context to feed the next REVISE round
//
// WHY these tests exist. The auto-repair loop (SRP-J / TRP-J) is the contract
// between the driver and main context: any Stage 5-8b failure must produce a
// trp-fail-<slug>-a<N>.json with a specific stage_label and attempt_number so
// prep-revise-input.py can build the workflow's `previous_attempt` args on
// the next round. A drift in the exit code, the fail-JSON schema, or the
// stage_label token silently breaks the revise loop — the driver exits 0 or
// exits 6 without a fail JSON and the wrapper's TRP-EE loop halts.
//
// Test surface.
//
// (A) Driver-level: each of the 12 fixtures invokes fix-task main() with the
//     fixture's argv against a scratch cwd carrying only `sfp.env` + `trp.env`
//     (no bundle, no POC dir, no bin/mise). main() naturally reaches
//     Stage 4b's "TRP4 bundle absent" branch and emits a trp-fail-a<N>.json
//     that mirrors the shape the target stage would emit — same schema, same
//     exit 66, same attempt_number semantics. This proves the auto-repair
//     loop machinery fires end-to-end from a real main() invocation and that
//     `--attempt=N` argv parsing threads through to the emitted attempt_number.
//
// (B) Emit-level: for each fixture, drive emit-trp-failure main() directly
//     with the fixture's `emit_env` and prior_bundle. This is the exact
//     helper fix-task's emitTrpJFailure delegates to — so the produced fail
//     JSON's stage_label / ci_failure.command / prior_bundle fields are the
//     ground truth the REVISE workflow reads. Confirming this shape per
//     (stage, attempt) is the "correct branch of auto-repair loop entered"
//     assertion — the workflow branches on stage_label, and drift there
//     routes the wrong REVISE prompt.
//
// Why we don't drive main() all the way to Stage 5-8b per fixture:
// reaching those stages requires standing up a POC dir with evidence.lock,
// cloning a client repo into fix-src/, a valid bundle that clears cross-file
// + schema checks, mocked docker, git, gh, and a bin/mise stub. The
// composed-run / hand-itc-308.parity harness exists to exercise the full
// path via a stubbed fix-task.sh; the point of THIS test is the two-layer
// contract that governs the loop, not the pipeline plumbing between them.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, vitest/require-mock-type-parameters, eslint/no-unused-vars, eslint/no-loop-func */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";

// Hoisted mock: intercept `@foundation/shell` before fix-task.ts loads so no
// real subprocess (time-tracker, mise, git, gh, docker, curl) runs during
// the test. The default resolved value is a silent exit-0 result; a specific
// test can override via `mockedSh.mockResolvedValueOnce(...)` if it needs to
// steer a particular sh() call — none of the 12 fixtures currently do,
// because main()'s Stage 4b branch fails before any real sh() call fires.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
	stdioJournal: vi.fn(),
}));

const mockedSh = vi.mocked(sh);

type ShResult = Awaited<ReturnType<typeof sh>>;

function shResult(exitCode: number, stdout = "", stderr = ""): ShResult {
	return {
		command: "mock",
		args: [],
		exitCode,
		signal: undefined,
		stdout,
		stderr,
		timedOut: false,
		durationMs: 0,
	};
}

// Silence process.stdout / process.stderr so vitest's reporter isn't drowned
// by the driver's stage logs. Accessors on the returned handle collect the
// captured bytes for the (few) assertions that grep them.
type StdioCapture = { stdout: () => string; stderr: () => string };

function captureStdio(): StdioCapture {
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
	};
}

// Fixture manifest shape — mirrors the JSON on disk.
type EmitEnv = {
	readonly STAGE_LABEL: string;
	readonly FAILING_CMD: string;
	readonly ATTEMPT: string;
};

type Expected = {
	readonly exit_code: number;
	readonly stage_label: string;
	readonly attempt_number: number;
	readonly next_attempt_number: number;
	readonly next_bundle_path: string;
	readonly trp_fail_written_at: string;
};

type Fixture = {
	readonly _comment?: string;
	readonly stage: number | string;
	readonly attempt: number;
	readonly task_id: string;
	readonly task_id_slug: string;
	readonly argv: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly prior_bundle: Record<string, unknown> | null;
	readonly prior_failure: Record<string, unknown> | null;
	readonly emit_env: EmitEnv;
	readonly expected: Expected;
};

const FIXTURE_ROOT = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"composed-run",
	"auto-repair",
);

// Exact 12-fixture list — per plan D-D, {5, 6, 7, 7b, 8, 8b} × {1, 2}. Any
// drift (added, removed, renamed) breaks the loop below intentionally; Rule
// 12 wants that visible instead of a silent coverage loss.
const FIXTURES: readonly string[] = [
	"stage-5-attempt1",
	"stage-5-attempt2",
	"stage-6-attempt1",
	"stage-6-attempt2",
	"stage-7-attempt1",
	"stage-7-attempt2",
	"stage-7b-attempt1",
	"stage-7b-attempt2",
	"stage-8-attempt1",
	"stage-8-attempt2",
	"stage-8b-attempt1",
	"stage-8b-attempt2",
];

function loadFixture(name: string): Fixture {
	const path = join(FIXTURE_ROOT, `${name}.json`);
	return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

// Env keys that any fixture may touch; we snapshot + wipe them per test so
// leaks from the harness (or a prior fixture) can't drift a run's exit code.
const ENV_KEYS = [
	"TRP_TASK_MODE",
	"TRP_FIX_LOOP_ENABLED",
	"TRP_FIX_LOOP_MAX_ATTEMPTS",
	"TRP_ALLOW_REMOTE_MUTATE",
	"TRP_ALLOW_INLINE_SPIKE",
	"TRP_ALLOW_CHILD_TICKET_CREATE",
	"TRP_PARALLEL_SAFE",
	"MISE_TRUSTED_CONFIG_PATHS",
	// emit-trp-failure env inputs — reset so a stray value from the driver
	// path doesn't leak into the direct emit-level assertion.
	"BUNDLE_JSON",
	"LOG_PATH",
	"OUT_PATH",
	"STAGE_LABEL",
	"FAILING_CMD",
	"ATTEMPT",
] as const;

describe("fix-task main() — auto-repair fixtures (stage × attempt matrix)", () => {
	let scratch: string;
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "fix-task-autorepair-"));
		originalCwd = process.cwd();
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		mockedSh.mockResolvedValue(shResult(0));
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = v;
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("has exactly 12 auto-repair fixtures on disk (stage × attempt matrix)", () => {
		// Rule 12 witness: fixture inventory must be exactly 12 files. A drift
		// (missing stage, missing attempt) silently drops loop coverage; this
		// assertion names the gap.
		expect(FIXTURES.length).toBe(12);
		for (const name of FIXTURES) {
			expect(existsSync(join(FIXTURE_ROOT, `${name}.json`))).toBe(true);
		}
	});

	// One `it` per fixture so vitest's reporter names the failing fixture
	// directly rather than a mega-test that runs 12 assertions.
	for (const name of FIXTURES) {
		it(`fixture: ${name} — driver enters auto-repair loop + emit produces the right fail JSON`, async () => {
			const fx = loadFixture(name);
			process.chdir(scratch);

			// Apply the fixture's env vars on top of the wiped baseline.
			for (const [k, v] of Object.entries(fx.env ?? {})) {
				process.env[k] = v;
			}

			// Minimal driver scaffolding — sfp.env + trp.env satisfy stage-0
			// preflight; nothing else is needed because we intentionally drive
			// main() to Stage 4b's TRP4 bundle absent branch (the reliably
			// reachable auto-repair firing point from a clean scratch).
			writeFileSync(
				join(scratch, "sfp.env"),
				"SFP_REPO_HAND=handled:tttstudios/handled-monorepo-poc:main\n",
			);
			writeFileSync(join(scratch, "trp.env"), "");

			// Task JSON provides the client_repo hint so Stage 1 client-repo
			// resolution doesn't fall over on the "no client_repo in task JSON"
			// die-loud path (which would exit 2 before the auto-repair loop
			// gets a chance to fire).
			mkdirSync(join(scratch, "discovery"), { recursive: true });
			writeFileSync(
				join(scratch, `discovery/task-${fx.task_id_slug}.json`),
				JSON.stringify({
					name: `auto-repair fixture ${name}`,
					text_content: "synthetic — used by the auto-repair matrix",
					client_repo: "tttstudios/handled-monorepo-poc",
					default_branch: "main",
					pinned_sha: "0000000000000000000000000000000000000000",
				}),
			);

			// bin/mise stub — executable no-op so `isExecutable("bin/mise")`
			// passes Stage 0's bootstrap check. The stub returns exit 0 for
			// every arg tuple; only the .install call runs and doesn't need
			// a specific stdout shape.
			mkdirSync(join(scratch, "bin"), { recursive: true });
			writeFileSync(join(scratch, "bin/mise"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

			// Prior-attempt fail JSON: on attempt >= 2 the REVISE loop consumes
			// this artifact; on attempt 1 it never exists. Materialize it when
			// the fixture provides one so the "correct branch of the loop
			// entered" assertion has a real on-disk precondition to reflect.
			if (fx.prior_failure && fx.attempt >= 2) {
				const priorFailPath = `discovery/trp-fail-${fx.task_id_slug}-a${fx.attempt - 1}.json`;
				writeFileSync(
					join(scratch, priorFailPath),
					`${JSON.stringify(fx.prior_failure, null, 2)}\n`,
				);
			}

			// ─── (A) Driver-level: invoke fix-task main() with fixture argv ──
			//
			// main() will reach Stage 4b (no bundle on disk) and emit the
			// auto-repair trp-fail JSON. This proves the driver's loop entry
			// path is intact for the fixture's argv shape, its --attempt=N is
			// wired through to the fail-JSON's attempt_number, and its exit
			// code is 66 (the auto-repair contract).
			const stdio = captureStdio();
			let exitCaught: number | null = null;
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				exitCaught = code ?? 0;
				throw new Error(`__EXIT_${exitCaught}__`);
			}) as never);
			const { main } = await import("./fix-task.ts");
			let rc: number | null = null;
			try {
				rc = await main(fx.argv);
			} catch (error) {
				if (exitCaught === null) {
					throw error;
				}
			}
			exitSpy.mockRestore();

			const observedExit = rc ?? exitCaught ?? -1;

			// Exit 66 is the auto-repair contract for stages 5-8b per SRP18.
			// The current fix-task.ts port routes every reachable failure at
			// or above Stage 4b through emitTrpJFailure → process.exit(66),
			// so the observed exit matches the fixture's expected exit for
			// every entry in the matrix.
			expect(observedExit).toBe(fx.expected.exit_code);

			// The driver's on-disk artifact — a trp-fail JSON at the fixture's
			// expected path, keyed by the passed --attempt=N. This is what
			// prep-revise-input.py picks up on the next round.
			const trpFailPath = join(scratch, fx.expected.trp_fail_written_at);
			expect(existsSync(trpFailPath)).toBe(true);
			const failJson = JSON.parse(readFileSync(trpFailPath, "utf8")) as Record<string, unknown>;
			expect(failJson.attempt_number).toBe(fx.expected.attempt_number);

			// The driver's on-disk log carries the [trp-j] loop trailer with
			// the next-attempt N+1 and next-bundle path — the exact bytes
			// main context greps to plan the next round.
			const logPath = join(scratch, `discovery/fix-log-${fx.task_id_slug}.txt`);
			expect(existsSync(logPath)).toBe(true);
			const logBody = readFileSync(logPath, "utf8");
			expect(logBody).toContain(
				`[trp-j] auto-repair loop (attempt ${fx.expected.attempt_number} / 5)`,
			);
			expect(logBody).toContain(
				`--after-workflow=${fx.expected.next_bundle_path} --attempt=${fx.expected.next_attempt_number}`,
			);

			// stdout carries the [trp-j] emit + the next-attempt hint too;
			// downstream tools (trp-run-loop wrapper) grep on stdout, not on
			// the log file, so lock that surface here as well.
			const stdoutText = stdio.stdout();
			expect(stdoutText).toContain(
				`[trp-j] auto-repair loop (attempt ${fx.expected.attempt_number} / 5)`,
			);

			// ─── (B) Emit-level: invoke emit-trp-failure with fixture env ──
			//
			// Directly drive the helper fix-task's emitTrpJFailure delegates
			// to, using the fixture's target STAGE_LABEL (not the "TRP4 bundle
			// absent" the driver naturally reaches). This confirms the fail
			// JSON schema — attempt_number, stage_label, prior_bundle,
			// ci_failure.command — is produced correctly for the stage the
			// fixture models, so a real Stage 5-8b failure flowing through
			// this same helper writes what the REVISE workflow expects.
			const emitLog = join(scratch, `discovery/emit-log-${fx.task_id_slug}.txt`);
			const emitBundle = join(scratch, `discovery/emit-bundle-${fx.task_id_slug}.json`);
			const emitOut = join(scratch, `discovery/emit-out-${fx.task_id_slug}.json`);
			writeFileSync(
				emitLog,
				[
					"[ci] pnpm run lint",
					`   BLOCKER: ${fx.emit_env.STAGE_LABEL} failed at "${fx.emit_env.FAILING_CMD}"`,
					`FAIL: ${fx.emit_env.FAILING_CMD}`,
				].join("\n"),
			);
			// prior_bundle is null on attempt=1, an object on attempt>=2 (the
			// bundle that got applied in the prior attempt). emit-trp-failure
			// loads it verbatim into the fail JSON's prior_bundle field.
			const priorBundleForEmit = fx.prior_bundle ?? {};
			writeFileSync(emitBundle, JSON.stringify(priorBundleForEmit));

			process.env.BUNDLE_JSON = emitBundle;
			process.env.LOG_PATH = emitLog;
			process.env.OUT_PATH = emitOut;
			process.env.STAGE_LABEL = fx.emit_env.STAGE_LABEL;
			process.env.FAILING_CMD = fx.emit_env.FAILING_CMD;
			process.env.ATTEMPT = fx.emit_env.ATTEMPT;

			const { main: emitMain } = await import("./emit-trp-failure.ts");
			const emitRc = await emitMain();
			expect(emitRc).toBe(0);
			expect(existsSync(emitOut)).toBe(true);

			const emitJson = JSON.parse(readFileSync(emitOut, "utf8")) as Record<string, unknown>;
			// stage_label pins the branch of the REVISE workflow that fires;
			// drift here silently routes the wrong prompt.
			expect(emitJson.stage_label).toBe(fx.expected.stage_label);
			expect(emitJson.attempt_number).toBe(fx.expected.attempt_number);
			expect(emitJson.bundle_missing).toBe(false);

			const ciFailure = emitJson.ci_failure as Record<string, unknown>;
			expect(ciFailure.command).toBe(fx.emit_env.FAILING_CMD);
			expect(ciFailure.stage).toBe(fx.expected.stage_label);
			// stderr_tail carries the log excerpt around the failing command
			// — non-empty when the log has any [ci]/BLOCKER/FAIL lines, which
			// the fixture's emitLog write always ensures.
			expect(String(ciFailure.stderr_tail).length).toBeGreaterThan(0);

			// prior_bundle round-trip: on attempt >=2 the fail JSON carries
			// the applied bundle so REVISE sees what was tried; on a1 it is
			// the empty object (emit-trp-failure treats an empty on-disk
			// bundle as `{}`, not missing).
			const emittedPrior = emitJson.prior_bundle as Record<string, unknown>;
			if (fx.prior_bundle) {
				expect(emittedPrior.branch_name).toBe(fx.prior_bundle.branch_name);
			} else {
				expect(emittedPrior).toEqual({});
			}
		});
	}
});
