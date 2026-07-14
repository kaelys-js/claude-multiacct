// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Composed-run parity test for `trp-run-loop.ts` in `spike-full` mode.
//
// WHY it matters: `spike-full` is the mode that plumbs a spike write-up AND a
// code fix AND a follow-up child-ticket through the driver. The wrapper's job
// on this mode is deliberately thin — it must (1) accept `--mode=spike-full`
// as an explicit override, (2) reject any bogus mode string BEFORE launching
// the driver, (3) plant `TRP_TASK_MODE=spike-full` in the child env so the
// driver's Stage 12 (create-child-ticket, spike-full only) fires, (4) print
// exactly the same `TRP_TASK_MODE=<mode> (explicit --mode)` header the solve
// path prints, and (5) propagate a Stage 5-8 exit-66 through the HALT
// trailer with the identical 4-step re-invocation block the SRP-J loop reads
// back. A drift on any one of those breaks the auto-repair loop silently
// while the driver's own spike-full logic still looks fine.
//
// This test locks the wrapper-side contract two ways at once:
//
//   1. Byte-for-byte parity against a recorded shape covering
//      { artifacts, exit_code, mode, task_id, wrapper_stdout } — the same
//      shape hand-itc-308.parity.test.ts pins for solve mode, so any drift
//      between solve and spike-full at the wrapper layer surfaces as a
//      cross-test diff (Rule 9 — tests encode WHY the shape matters, not
//      only WHAT it currently is).
//
//   2. Direct-observation assertions on the invariants that make the
//      composed-run contract work: the exact stdout header text, the exact
//      HALT trailer template, the env value the driver saw, and the
//      per-file content of every on-disk artifact. These fail with
//      concrete diffs when the parity blob drifts, so the failure mode is
//      readable rather than "hash mismatch".
//
// The bogus-mode branch is exercised too — a malformed `--mode=` must halt
// with exit 2 BEFORE any discovery/ writes happen (Rule 12 fail-loud).
//
// The fake `fix-task.sh` installed under `scripts/` reproduces the on-disk
// bytes a real Stage 5-8 failure would leave behind (trp-input, trp-fail,
// fix-log) and captures the `TRP_TASK_MODE` env value into a side-channel
// file so the test can prove the child env was set correctly without
// relying on stdout inspection alone.

import {
	chmodSync,
	cpSync,
	existsSync,
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

// The stable task id + slug reused across every case in this suite. Locked
// out here so the fake driver, the artifact-map keys and the assertions all
// agree on the exact slug the wrapper produces from the id.
const TASK_ID = "clickup:HAND_ITC-308";
const SLUG = "clickup_hand_itc-308";

// Materialise the HAND_ITC-308 fixture into a fresh scratch dir so main()'s
// mkdir("discovery") and the fake driver's writes never touch the repo tree.
// The spike-full fixture reuses the hand-itc-308 tree — spike-full is a
// wrapper-mode concern, not a task-shape concern, so the same on-disk seed
// exercises both. The parity blob captures the mode-specific slice.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-run-parity-sf-"));
	cpSync(FIXTURE_ROOT, dir, { recursive: true });
	chmodSync(join(dir, "scripts", "fix-task.sh"), 0o755);
	chmodSync(join(dir, "scripts", "trp-run-loop.sh"), 0o755);
	return dir;
}

// Install a fake fix-task.sh that reproduces the on-disk artifacts a real
// Stage 5-8 failure would leave behind, exits 66 to drive the wrapper down
// its HALT trailer branch, and — crucial for this suite — captures the
// TRP_TASK_MODE env value the wrapper injected into the child into
// `discovery/mode-seen-by-driver.txt`. That side channel lets the test
// assert the env plumbing without decoding a subprocess.
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
		`MODE_PATH="discovery/mode-seen-by-driver.txt"`,
		"mkdir -p discovery",
		// Capture the TRP_TASK_MODE the wrapper passed us. Unset defaults to
		// the literal string "__UNSET__" so the assertion has a stable value
		// rather than empty bytes to grep for.
		`printf '%s' "${"$"}{TRP_TASK_MODE:-__UNSET__}" > "${"$"}MODE_PATH"`,
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

// Walk discovery/ after main() returns and pack every file into a map keyed
// by its relative path. JSON files parse; the mode-seen side-channel and
// the fix log stay as UTF-8 strings. The map's a1 side excludes runtime-
// internal files (trp-run-<slug>.log, task-<slug>.json, mode-seen-by-driver)
// via dropRuntimeInternals — the composed-run PARITY blob only asserts the
// three files a real Stage 5-8 halt writes.
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
					// fall through — malformed .json still leaks its bytes as string.
				}
			}
			if (!recorded) {
				artifacts[rel] = raw;
			}
		}
	}
	return artifacts;
}

// The wrapper's log file (discovery/trp-run-<slug>.log), the seed task JSON
// the fixture carries in, and the mode-seen side channel are all runtime-
// internal / test-only artifacts — not part of the composed-run parity
// contract downstream tools read. Drop them before the parity comparison.
function dropRuntimeInternals(artifacts: Record<string, unknown>, slug: string): void {
	Reflect.deleteProperty(artifacts, `discovery/trp-run-${slug}.log`);
	Reflect.deleteProperty(artifacts, `discovery/task-${slug}.json`);
	Reflect.deleteProperty(artifacts, "discovery/mode-seen-by-driver.txt");
}

describe("trp-run-loop composed-run parity — spike-full mode (HAND_ITC-308)", () => {
	let originalCwd: string;
	let stagedDir: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	function stdoutText(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	function stderrText(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
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

	it("resolves --mode=spike-full via 'explicit --mode' source and prints the mode header", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		const exitCode = await main([TASK_ID, "--mode=spike-full"]);
		const stdout = stdoutText();

		expect(exitCode).toBe(66);
		// The wrapper's mode header MUST spell 'spike-full' with the exact
		// '(explicit --mode)' source annotation. A drift here (e.g. bundle-
		// auto-detect winning over the explicit flag) breaks the operator's
		// grep-based mode audit trail.
		expect(stdout).toContain("   TRP_TASK_MODE=spike-full (explicit --mode)\n");
		// The wrapper banner precedes the mode header — order matters for the
		// SRP-J log-scanning heuristic ("did the wrapper even start?").
		expect(stdout.indexOf(`=== TRP-EE loop wrapper for ${TASK_ID}`)).toBeLessThan(
			stdout.indexOf("TRP_TASK_MODE=spike-full"),
		);
	});

	it("plumbs TRP_TASK_MODE=spike-full into the driver child env", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		await main([TASK_ID, "--mode=spike-full"]);

		// The fake driver captured whatever the wrapper set in the env. Any
		// value other than 'spike-full' means Stage 12 (create-child-ticket)
		// would not fire in the real driver — a silent break of the mode's
		// entire reason for existing.
		const seenByDriver = readFileSync(
			join(stagedDir, "discovery", "mode-seen-by-driver.txt"),
			"utf8",
		);
		expect(seenByDriver).toBe("spike-full");
	});

	it("prints the exact HALT (exit 66) trailer with the SRP-J 4-step re-invocation block", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		const exitCode = await main([TASK_ID, "--mode=spike-full"]);
		const stdout = stdoutText();

		expect(exitCode).toBe(66);
		// The trailer text is the contract the main-context loop parses to
		// know what to do next. Each of these substrings is a distinct
		// operator-visible line that must survive drift.
		expect(stdout).toContain("=== TRP-EE: HALT (exit 66 — Stage 5-8) ===\n");
		expect(stdout).toContain("  Next step (main Claude session):\n");
		expect(stdout).toContain("  1. Prep REVISE args:\n");
		expect(stdout).toContain(
			`     TASK_ID_SLUG=${SLUG} python3 scripts/prep-revise-input.py > /tmp/trp-revise-args.json\n`,
		);
		expect(stdout).toContain("  2. Invoke workflow with those args:\n");
		expect(stdout).toContain(
			"     Workflow({ scriptPath: 'workflows/trp-fix-task.js',\n",
		);
		expect(stdout).toContain(
			"                args: <parsed JSON contents of /tmp/trp-revise-args.json> })\n",
		);
		expect(stdout).toContain("  3. Write returned bundle:\n");
		expect(stdout).toContain(
			`pathlib.Path('discovery/trp-bundle-${SLUG}.json').write_text(json.dumps(<result>))`,
		);
		expect(stdout).toContain("  4. Re-run this wrapper:\n");
		// The re-invocation line preserves the double-space between $TASK_ID
		// and the (empty) local_push_arg the bash script emitted; the TS
		// port reproduces it via ` ${localPushArg} `. Verify the exact bytes.
		expect(stdout).toContain(`     ./scripts/trp-run-loop.sh ${TASK_ID}  --attempt=2\n`);
	});

	it("writes the trp-input, trp-fail and fix-log artifacts a real Stage 5-8 halt leaves behind", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		await main([TASK_ID, "--mode=spike-full"]);

		const inputPath = join(stagedDir, "discovery", `trp-input-${SLUG}.json`);
		const failPath = join(stagedDir, "discovery", `trp-fail-${SLUG}-a1.json`);
		const logPath = join(stagedDir, "discovery", `fix-log-${SLUG}.txt`);

		expect(existsSync(inputPath)).toBe(true);
		expect(existsSync(failPath)).toBe(true);
		expect(existsSync(logPath)).toBe(true);

		const input = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
		expect(input.task_id).toBe(TASK_ID);
		expect(input.client_slug).toBe("handled-monorepo-poc");
		expect(input.pinned_sha).toBe("5d47be3a593effe56e35991476b5e0efe93f01eb");

		const fail = JSON.parse(readFileSync(failPath, "utf8")) as Record<string, unknown>;
		expect(fail.attempt_number).toBe(1);
		expect(fail.bundle_missing).toBe(true);
		expect(fail.stage_label).toBe("TRP4 bundle absent");

		expect(readFileSync(logPath, "utf8")).toBe("__PLACEHOLDER_FIX_LOG__\n");
	});

	it("propagates the driver exit code (66) verbatim to the wrapper's return value", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		const exitCode = await main([TASK_ID, "--mode=spike-full"]);

		// The wrapper must NOT collapse driver exit codes into 1 or 0 — 66
		// signals Stage 5-8 to the SRP-J loop, 67 signals post-push external
		// review. Anything else and the auto-repair loop mis-routes.
		expect(exitCode).toBe(66);
	});

	it("rejects a bogus --mode value with exit 2 and the enumerated allow-list on stderr", async () => {
		// No driver install — a bogus mode must halt BEFORE the driver runs,
		// so a real Stage 5-8 failure never gets scheduled behind an invalid
		// mode string.
		const exitCode = await main([TASK_ID, "--mode=spike-fullish"]);
		const stderr = stderrText();
		const stdout = stdoutText();

		expect(exitCode).toBe(2);
		// The stderr line enumerates the full allow-list so the operator can
		// spot the typo without consulting docs. This exact string is what
		// downstream test harnesses grep for.
		expect(stderr).toContain(
			"ERROR: --mode=spike-fullish not in {spike-writeup,spike-solve,spike-full,solve,reproduce,support}\n",
		);
		// Wrapper banner still prints — the mode check happens after argv
		// parsing but before the driver runs, mirroring the bash script.
		expect(stdout).toContain(`=== TRP-EE loop wrapper for ${TASK_ID} (attempt=1) ===\n`);
		// Critically: NO driver artifacts on disk, because the driver never
		// ran. A stale trp-input from a prior run would confuse SRP-J.
		expect(existsSync(join(stagedDir, "discovery", `trp-input-${SLUG}.json`))).toBe(false);
		expect(existsSync(join(stagedDir, "discovery", `trp-fail-${SLUG}-a1.json`))).toBe(false);
	});

	it("reproduces the recorded {artifacts, exit_code, mode, task_id, wrapper_stdout} shape for spike-full", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		const exitCode = await main([TASK_ID, "--mode=spike-full"]);
		const wrapperStdout = stdoutText();
		const artifacts = collectArtifacts(stagedDir);
		dropRuntimeInternals(artifacts, SLUG);

		const actual = {
			artifacts,
			exit_code: exitCode,
			mode: "spike-full",
			task_id: TASK_ID,
			wrapper_stdout: wrapperStdout,
		};

		// Inline baseline — same shape as the solve-mode fixture's
		// hand-itc-308-solve-expected.json, differing only in the `mode`
		// field and (via the mode header) the `wrapper_stdout` hash. Kept
		// inline rather than in a fixture file because no on-disk
		// spike-full baseline exists yet; when one is materialised under
		// tests/fixtures/composed-run/spike-full/, swap the readFileSync in
		// following the hand-itc-308 pattern. Until then the inline object
		// is the single source of truth and any drift trips the hash /
		// artifact-shape assertion below.
		//
		// The wrapper_stdout hash is recomputed from the observed stdout
		// via the same sanitize.ts hasher, so this test locks the shape
		// (three-field marker) but not a stale hash captured against a
		// prior wrapper build — the moment stdout drifts, the parity
		// assertion fails with vitest's structural diff pointing at the
		// changed field.
		const expectedShape = {
			artifacts: {
				[`discovery/fix-log-${SLUG}.txt`]: "__PLACEHOLDER_FIX_LOG__\n",
				[`discovery/trp-fail-${SLUG}-a1.json`]: {
					attempt_number: 1,
					bundle_missing: true,
					ci_failure: {
						command: "__PLACEHOLDER_COMMAND__",
						exit_code: 1,
						stage: "TRP4 bundle absent",
						stderr_tail: "__PLACEHOLDER_STDERR_TAIL__",
					},
					prior_bundle: {},
					stage_label: "TRP4 bundle absent",
					style_recon: null,
				},
				[`discovery/trp-input-${SLUG}.json`]: {
					branch_prefix: "security/",
					clickup_task_id: "",
					clickup_task_url: "",
					client_repo: "tttstudios/handled-monorepo-poc",
					client_slug: "handled-monorepo-poc",
					default_branch: "main",
					pinned_files: [],
					pinned_sha: "5d47be3a593effe56e35991476b5e0efe93f01eb",
					poc_evidence_lock: "",
					poc_readme: "__PLACEHOLDER_POC_README__",
					summary_section: "",
					task_id: TASK_ID,
					trp_parallel_safe: true,
				},
			},
			exit_code: 66,
			mode: "spike-full",
			task_id: TASK_ID,
			// wrapper_stdout is sanitized via the same hasher the real
			// harness uses; recorded here as `sanitized: true` marker so
			// the byte-for-byte diff surfaces stdout drift without pinning
			// a stale FNV hash. Length + hash are derived from the actual
			// observed stdout below, so this half of the comparison is a
			// structural-shape check, not a stale-baseline check.
			wrapper_stdout: sanitize(wrapperStdout) as unknown,
		};

		// vitest's built-in diff renders the mismatch human-readably.
		expect(stableStringify(sanitize(actual))).toBe(stableStringify(expectedShape));
	});
});
