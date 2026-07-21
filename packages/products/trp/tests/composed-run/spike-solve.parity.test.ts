// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Composed-run parity test for `trp-run-loop.ts` in `spike-solve` mode.
//
// WHY it matters: `spike-solve` is a distinct mode from the auto-detected pair
// (`spike-writeup` | `solve`) — it's only reachable via `--mode=spike-solve`
// and its downstream contract (a spike write-up bundled with a code fix) is
// what the SRP-J revise loop reads back when the driver trips Stage 5-8. If
// the wrapper's mode banner, HALT trailer, or on-disk artefact layout drifts
// for this mode alone, the auto-repair loop routes the wrong REVISE args back
// into `Workflow()` and the loop silently stalls at attempt 2.
//
// This test pins the same contract shape hand-itc-308 pins for solve mode,
// against a spike-solve baseline captured from the synthetic
// `HAND_SYNTH-1003` fixture.
//
// Shape captured per run:
//   { artifacts, exit_code, mode, task_id, wrapper_stdout }
// Long strings collapse through the shared sanitize.ts hasher; stableStringify
// sorts keys so byte diffs don't depend on insertion order. A drift on ANY
// field trips the byte-for-byte assertion — which is the contract we want
// locked down. The direct sub-assertions below (exit code, mode banner) fail
// louder on the specific-drift path so a mismatch reads as "mode wire broke"
// rather than "byte diff somewhere in the shape".

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

// Reuse the hand-itc-308 fixture as the staging source — it's the only
// composed-run fixture that ships a complete `scripts/` + `discovery/`
// layout. The spike-solve-specific bytes (task JSON, mode banner) are
// injected on top in `stageFixture()`.
const STAGING_ROOT = resolve(HERE, "..", "fixtures", "hand-itc-308");

// The spike-solve task JSON (custom_id HAND_SYNTH-1003) drives the task-id
// wired through the wrapper. Copied into discovery/task-<slug>.json so
// resolveMode's file-existence check hits a real file, even though
// --mode=spike-solve short-circuits the auto-detect branch.
const SPIKE_SOLVE_TASK_JSON = resolve(
	HERE,
	"..",
	"fixtures",
	"composed-run",
	"spike-solve",
	"task.json",
);

const BASELINE_PATH = resolve(
	HERE,
	"..",
	"fixtures",
	"composed-run",
	"spike-solve",
	"expected.json",
);

const TASK_ID = "clickup:HAND_SYNTH-1003";
// Mirrors `slugify()` in trp-run-loop.ts — kept as a literal so a drift in
// the slug transform trips this test alongside the wrapper's own unit test,
// rather than the two moving in lockstep and hiding the mismatch.
const SLUG = "clickup_hand_synth-1003";

// Copy the hand-itc-308 fixture layout into a fresh scratch dir so main()'s
// mkdir/discovery writes never touch the repo tree. Overwrite the staged
// discovery/task-*.json with the spike-solve task payload keyed under the
// spike-solve slug.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-run-spike-solve-"));
	cpSync(STAGING_ROOT, dir, { recursive: true });
	chmodSync(join(dir, "scripts", "fix-task.sh"), 0o755);
	chmodSync(join(dir, "scripts", "trp-run-loop.sh"), 0o755);
	// Remove the hand-itc-308 discovery file — a stale task-*.json under the
	// wrong slug would sit alongside the spike-solve one and confuse a reader
	// diffing artefacts.
	const staleTask = join(dir, "discovery", "task-clickup_hand_itc-308.json");
	if (existsSync(staleTask)) {
		rmSync(staleTask, { force: true });
	}
	cpSync(SPIKE_SOLVE_TASK_JSON, join(dir, "discovery", `task-${SLUG}.json`));
	return dir;
}

// Fake fix-task.sh reproducing the on-disk artefacts a real Stage 5-8 failure
// would leave behind, keyed under the spike-solve slug. Exits 66 to drive
// the wrapper down its HALT trailer branch — that's the code path we're
// pinning here.
//
// Placeholder tokens (`__PLACEHOLDER_*`) are long enough (>40 chars once
// composed) to trip sanitize.ts's threshold, so the baseline records them
// as fnv1a markers rather than raw bytes. Any drift in the on-disk shape
// (extra newline, reordered key) shifts the hash and trips the parity
// assertion — which is the contract we want locked down.
function installComposedRunDriver(dir: string, slug: string): void {
	const path = join(dir, "scripts", "fix-task.sh");
	const script = [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		`SLUG="${slug}"`,
		// Split the literal `${SLUG}` so no single string token contains a
		// `${...}` sequence (eslint no-template-curly-in-string) — these are
		// bash variable references, not a forgotten JS template literal.
		`INPUT_PATH="discovery/trp-input-${"$"}{SLUG}.json"`,
		`FAIL_PATH="discovery/trp-fail-${"$"}{SLUG}-a1.json"`,
		`LOG_PATH="discovery/fix-log-${"$"}{SLUG}.txt"`,
		"mkdir -p discovery",
		"cat > \"$INPUT_PATH\" <<'EOF'",
		'{"branch_prefix":"security/","clickup_task_id":"","clickup_task_url":"","client_repo":"tttstudios/handled-monorepo-poc","client_slug":"handled-monorepo-poc","default_branch":"main","pinned_files":[],"pinned_sha":"5d47be3a593effe56e35991476b5e0efe93f01eb","poc_evidence_lock":"","poc_readme":"__PLACEHOLDER_POC_README_SPIKE_SOLVE_MODE__","summary_section":"","task_id":"clickup:HAND_SYNTH-1003","trp_parallel_safe":true}',
		"EOF",
		"cat > \"$FAIL_PATH\" <<'EOF'",
		'{"attempt_number":1,"bundle_missing":true,"ci_failure":{"command":"__PLACEHOLDER_COMMAND_SPIKE_SOLVE__","exit_code":1,"stage":"TRP4 bundle absent","stderr_tail":"__PLACEHOLDER_STDERR_TAIL_SPIKE_SOLVE__"},"prior_bundle":{},"stage_label":"TRP4 bundle absent","style_recon":null}',
		"EOF",
		"cat > \"$LOG_PATH\" <<'EOF'",
		"__PLACEHOLDER_FIX_LOG_SPIKE_SOLVE__",
		"EOF",
		"exit 66",
	].join("\n");
	writeFileSync(path, `${script}\n`);
	chmodSync(path, 0o755);
}

// Walk `discovery/` after main() returns and pack every file into a map
// keyed by its relative path. JSON files parse; everything else stays as
// a UTF-8 string. Directories under discovery/ are ignored — the composed-
// run shape only records the flat file layer the driver writes.
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
					// through the sanitizer as a plain string.
				}
			}
			if (!recorded) {
				artifacts[rel] = raw;
			}
		}
	}
	return artifacts;
}

// Drop artefacts that are runtime-internal to the wrapper and not part of
// the composed-run contract downstream tools read. The baseline is captured
// without these.
//
// - trp-run-<slug>.log: wrapper's own tee-log, journal-shaped not contract.
// - task-<slug>.json: the staged input; recording it in the artefact map
//   would inflate the diff with fixture content instead of driver output.
function dropRuntimeInternals(artifacts: Record<string, unknown>, slug: string): void {
	Reflect.deleteProperty(artifacts, `discovery/trp-run-${slug}.log`);
	Reflect.deleteProperty(artifacts, `discovery/task-${slug}.json`);
}

// `TRP_TASK_MODE` is set by the wrapper before invoking the driver. Read
// it back after main() returns to record what mode actually resolved.
// Hoisted so the `??` doesn't read as a conditional inside a test (vitest
// no-conditional-in-test).
function resolveTaskMode(): string {
	return process.env.TRP_TASK_MODE ?? "";
}

describe("trp-run-loop composed-run parity — HAND_SYNTH-1003 spike-solve mode", () => {
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

	it("resolves --mode=spike-solve, prints the spike-solve banner, and HALTs with exit 66", async () => {
		installComposedRunDriver(stagedDir, SLUG);

		const exitCode = await main([TASK_ID, "--mode=spike-solve"]);
		const wrapperStdout = stdoutText();
		const resolvedMode = resolveTaskMode();

		// Direct guardrails: fail loud on the specific-drift path before the
		// byte-compare buries the mismatch inside a shape diff.
		expect(exitCode).toBe(66);
		expect(resolvedMode).toBe("spike-solve");
		expect(wrapperStdout).toContain("TRP_TASK_MODE=spike-solve (explicit --mode)");
		expect(wrapperStdout).toContain(
			`=== TRP-EE loop wrapper for ${TASK_ID} (attempt=1) ===`,
		);
		// HALT trailer must name the right re-invoke command for the loop.
		expect(wrapperStdout).toContain(
			`./scripts/trp-run-loop.sh ${TASK_ID}  --attempt=2`,
		);
		expect(wrapperStdout).toContain(
			`discovery/trp-bundle-${SLUG}.json`,
		);

		// Every on-disk artefact the SRP-J loop reads back must land under
		// the spike-solve slug — a drift here would silently misroute the
		// REVISE bundle.
		const artifacts = collectArtifacts(stagedDir);
		dropRuntimeInternals(artifacts, SLUG);
		expect(Object.keys(artifacts).toSorted()).toStrictEqual([
			`discovery/fix-log-${SLUG}.txt`,
			`discovery/trp-fail-${SLUG}-a1.json`,
			`discovery/trp-input-${SLUG}.json`,
		]);

		const actual = {
			artifacts,
			exit_code: exitCode,
			mode: resolvedMode,
			task_id: TASK_ID,
			wrapper_stdout: wrapperStdout,
		};

		// vitest's built-in diff renders the mismatch human-readably on failure.
		const expected = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
		expect(stableStringify(sanitize(actual))).toBe(stableStringify(expected));
	});
});
