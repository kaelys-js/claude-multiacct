// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// G4b composed-run parity test for `trp-run-loop.ts` in **reproduce** mode.
//
// WHY it matters: `--mode=reproduce` is the mode the driver runs for a failing
// regression test + minimal writeup (no PR). The wrapper's contract in this
// mode is subtle:
//
//   1. `resolveMode()` must honour the explicit `--mode=reproduce` override
//      instead of auto-detecting from the task-json spike marker. If the
//      override is silently ignored, downstream stages that key on
//      `TRP_TASK_MODE` (see `modeRuns()` in `fix-task.ts`, which enables the
//      `stage_commit` and `stage_tracker_post` branches for `reproduce`)
//      run against the wrong stage map.
//   2. The mode string must round-trip verbatim into stdout on the
//      `   TRP_TASK_MODE=reproduce (explicit --mode)` line — main-context
//      log-parsers grep for that literal.
//   3. Every other byte of stdout (the wrapper banner, the HALT trailer,
//      the on-disk artifact map) is mode-agnostic and must stay identical
//      to the solve-mode baseline. A drift on any of them means the
//      wrapper accidentally diverged its shape by mode, which is a
//      contract break.
//
// Recording captures the same {artifacts, exit_code, mode, task_id,
// wrapper_stdout} shape as the sibling solve-mode test at
// `tests/fixtures/composed-run/hand-itc-308-reproduce-expected.json`.
// The wrapper_stdout collapses through the shared sanitize.ts hasher so a
// byte diff on any of the three concerns above trips the fnv1a marker.
//
// The fake fix-task.sh is identical to the one the solve-mode parity test
// installs — the driver's stub behaviour is mode-independent (it just
// exits 66 to force the HALT branch). What changes between the two
// baselines is exactly the wrapper's stdout mode line + the recorded
// `mode` field; the artifact map is byte-for-byte identical. That
// asymmetry is the whole point: pinning both baselines lets us detect
// either "reproduce mode leaks into artifacts it shouldn't" (artifacts
// drift) or "reproduce mode is silently dropped" (wrapper_stdout drift).

import {
	chmodSync,
	cpSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/scripts/trp-run-loop.ts";
import { sanitize, stableStringify } from "../../src/workflows/sanitize.ts";

const HERE = import.meta.dirname;
const FIXTURE_ROOT = resolve(HERE, "..", "fixtures", "hand-itc-308");
const BASELINE_PATH = resolve(
	HERE,
	"..",
	"fixtures",
	"composed-run",
	"hand-itc-308-reproduce-expected.json",
);

// Materialise the HAND_ITC-308 fixture into a fresh scratch dir so main()'s
// mkdir/discovery writes never touch the repo tree.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-run-reproduce-"));
	cpSync(FIXTURE_ROOT, dir, { recursive: true });
	chmodSync(join(dir, "scripts", "fix-task.sh"), 0o755);
	chmodSync(join(dir, "scripts", "trp-run-loop.sh"), 0o755);
	return dir;
}

// Install a fake fix-task.sh that reproduces the on-disk artifacts a real
// Stage 5-8 failure would leave behind: a trp-input-* JSON captured pre-run,
// a trp-fail-*-a1.json failure record, and a fix-log-*.txt trailing log.
// Exits 66 to drive the wrapper down its HALT trailer branch. Kept
// verbatim from the solve-mode parity test so the two baselines only
// legitimately diverge on the mode line + `mode` field — see the header
// comment for why that asymmetry matters.
function installComposedRunDriver(dir: string, slug: string): void {
	const path = join(dir, "scripts", "fix-task.sh");
	const script = [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		`SLUG="${slug}"`,
		// Split the literal `${SLUG}` so no single string token contains a
		// `${...}` sequence (eslint no-template-curly-in-string) — these are
		// bash variable references, not a forgotten JS template literal, and
		// the on-disk bytes this produces must stay byte-identical.
		`INPUT_PATH="discovery/trp-input-${"$"}{SLUG}.json"`,
		`FAIL_PATH="discovery/trp-fail-${"$"}{SLUG}-a1.json"`,
		`LOG_PATH="discovery/fix-log-${"$"}{SLUG}.txt"`,
		"mkdir -p discovery",
		"cat > \"$INPUT_PATH\" <<'EOF'",
		'{"branch_prefix":"security/","clickup_task_id":"","clickup_task_url":"","client_repo":"tttstudios/handled-monorepo-poc","client_slug":"handled-monorepo-poc","default_branch":"main","pinned_files":[],"pinned_sha":"5d47be3a593effe56e35991476b5e0efe93f01eb","poc_evidence_lock":"","poc_readme":"__PLACEHOLDER_POC_README__","summary_section":"","task_id":"clickup:HAND_ITC-308","trp_parallel_safe":true}',
		"EOF",
		"cat > \"$FAIL_PATH\" <<'EOF'",
		'{"attempt_number":1,"bundle_missing":true,"ci_failure":{"command":"__PLACEHOLDER_COMMAND__","exit_code":1,"stage":"TRP4 bundle absent","stderr_tail":"__PLACEHOLDER_STDERR_TAIL__"},"prior_bundle":{},"stage_label":"TRP4 bundle absent","style_recon":null}',
		"EOF",
		"cat > \"$LOG_PATH\" <<'EOF'",
		"__PLACEHOLDER_FIX_LOG__",
		"EOF",
		"exit 66",
	].join("\n");
	writeFileSync(path, `${script}\n`);
	chmodSync(path, 0o755);
}

// Walk `discovery/` after main() returns and pack every file into a map
// keyed by its relative path. JSON files parse; everything else stays as a
// UTF-8 string. Symlinks / directories under discovery/ are ignored — the
// composed-run shape only records the flat file layer the driver writes.
function collectArtifacts(dir: string): Record<string, unknown> {
	const discoveryDir = join(dir, "discovery");
	const artifacts: Record<string, unknown> = {};
	let entries: string[];
	try {
		entries = readdirSync(discoveryDir);
	} catch {
		return artifacts;
	}
	for (const name of entries.toSorted()) {
		const abs = join(discoveryDir, name);
		let st: ReturnType<typeof statSync> | undefined;
		try {
			st = statSync(abs);
		} catch {
			st = undefined;
		}
		if (st !== undefined && st.isFile()) {
			const rel = `discovery/${name}`;
			const raw = readFileSync(abs, "utf8");
			let recorded = false;
			if (name.endsWith(".json")) {
				try {
					artifacts[rel] = JSON.parse(raw) as unknown;
					recorded = true;
				} catch {
					// fall through — a malformed .json record still leaks its bytes
					// through the sanitizer as a plain string, which is the safer
					// disclosure-side default (the truth of the on-disk record).
				}
			}
			if (!recorded) {
				artifacts[rel] = raw;
			}
		}
	}
	return artifacts;
}

// The wrapper's log file (discovery/trp-run-<slug>.log) is a runtime-internal
// journal, not part of the composed-run contract that downstream tools read.
// The pre-staged task JSON (discovery/task-<slug>.json) is fixture setup, not
// a wrapper artifact. Drop both from the artifact map before comparison; the
// baseline was captured without them.
function dropRuntimeInternals(artifacts: Record<string, unknown>, slug: string): void {
	Reflect.deleteProperty(artifacts, `discovery/trp-run-${slug}.log`);
	Reflect.deleteProperty(artifacts, `discovery/task-${slug}.json`);
}

// Reads back the mode the wrapper actually resolved. `main()` sets
// `TRP_TASK_MODE` after `resolveMode()`, so this is a genuine post-run
// observation, not a re-derivation of the argv. Hoisted out of the `it()`
// body so the `??` doesn't read as a conditional inside a test (vitest
// no-conditional-in-test); when the wrapper's set is missing for any
// reason, we fall through to a marker string the baseline never matches
// so the failure surfaces loudly (Rule 12) rather than pretending "solve".
function resolveTaskMode(): string {
	return process.env.TRP_TASK_MODE ?? "__UNRESOLVED__";
}

describe("trp-run-loop composed-run parity — HAND_ITC-308 reproduce mode", () => {
	let originalCwd: string;
	let stagedDir: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	function stdoutText(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	beforeEach(() => {
		originalCwd = process.cwd();
		for (const key of ["TRP_ALLOW_REMOTE_MUTATE", "TRP_TASK_MODE"] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		stagedDir = stageFixture();
		process.chdir(stagedDir);
		stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
		stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		process.chdir(originalCwd);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		try {
			rmSync(stagedDir, { recursive: true, force: true });
		} catch {
			// mkdtemp dirs are cleaned by the OS eventually — non-fatal.
		}
	});

	it("reproduces the recorded {artifacts, exit_code, mode, task_id, wrapper_stdout} shape", async () => {
		const taskId = "clickup:HAND_ITC-308";
		const slug = "clickup_hand_itc-308";
		installComposedRunDriver(stagedDir, slug);

		// Explicit `--mode=reproduce` is the whole point of this test — the
		// solve-mode sibling exercises the auto-detect branch, this one pins
		// the explicit-override branch of `resolveMode()`.
		const exitCode = await main([taskId, "--mode=reproduce"]);
		const wrapperStdout = stdoutText();
		const artifacts = collectArtifacts(stagedDir);
		dropRuntimeInternals(artifacts, slug);

		const actual = {
			artifacts,
			exit_code: exitCode,
			mode: resolveTaskMode(),
			task_id: taskId,
			wrapper_stdout: wrapperStdout,
		};

		const expected = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;

		// vitest's built-in diff renders the mismatch human-readably on failure.
		expect(stableStringify(sanitize(actual))).toBe(stableStringify(expected));
	});

	it("records `reproduce` in the mode field (not solve, not spike-writeup)", async () => {
		// Belt-and-braces against a silent mode-override drop. Byte-parity in
		// the main assertion above catches this too, but a focused failure
		// here points a maintainer at the offending branch of `resolveMode()`
		// without having to eyeball a 745-char sanitized-hash mismatch. The
		// solve-mode sibling test has no equivalent because auto-detect on
		// the HAND_ITC-308 task JSON legitimately resolves to `solve` — this
		// assertion only pays for itself in a mode that requires an explicit
		// override to reach.
		const taskId = "clickup:HAND_ITC-308";
		const slug = "clickup_hand_itc-308";
		installComposedRunDriver(stagedDir, slug);

		const exitCode = await main([taskId, "--mode=reproduce"]);

		expect(exitCode).toBe(66);
		expect(resolveTaskMode()).toBe("reproduce");
		// The wrapper stamps the resolution source into stdout; a drift to
		// `auto-detected` here would mean the override branch of
		// `resolveMode()` silently dropped `--mode=reproduce` and fell
		// through to task-json heuristics.
		expect(stdoutText()).toContain("   TRP_TASK_MODE=reproduce (explicit --mode)\n");
	});
});
