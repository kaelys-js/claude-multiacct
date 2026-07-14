// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Composed-run parity for `trp-run-loop.ts` in support mode.
//
// WHY it matters: support mode is the shortest of the six composed-run
// modes — stages 2-14 collapse to a single bootstrap that writes a
// tracker comment payload, and the wrapper reports SUCCESS on exit 0.
// Because so little runs between the wrapper banner and the SUCCESS
// trailer, any drift in the intermediate lines (the "== [0] bootstrap =="
// section, the wrote-file breadcrumb, the "== done" trailer) is
// disproportionately visible to an operator log-grep. This test pins the
// composed output byte-for-byte against
// `tests/fixtures/composed-run/support/expected.txt`, sanitized through
// the fixture's `sanitize-manifest.json`.
//
// Shape captured per run (composed text form):
//   === exit ===
//   <exit_code>
//   === stdout ===
//   <captured stdout, including the wrapper banner, mode line, the fake
//    fix-task.sh bootstrap section, and the SUCCESS trailer>
//   === stderr ===
//   <captured stderr>
//
// The fixture's sanitize rule collapses `\d+ bytes` -> `__BYTES__` so a
// change in the fake payload size does not itself break parity; a
// mistaken drop of the wrote-file line, or the mode line, or the SUCCESS
// trailer does.

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/scripts/trp-run-loop.ts";
import { loadManifest, runPipeline } from "../../src/scripts/sanitize-fixture.ts";

const HERE = import.meta.dirname;
const FIXTURE_DIR = resolve(HERE, "..", "fixtures", "composed-run", "support");
const EXPECTED_PATH = join(FIXTURE_DIR, "expected.txt");
const MANIFEST_PATH = join(FIXTURE_DIR, "sanitize-manifest.json");

const TASK_ID = "clickup:HAND_SYNTH-SUPPORT-01";
const SLUG = "clickup_hand_synth-support-01";

// Compose the {exit, stdout, stderr} triple into the sectioned text form
// that `expected.txt` records. Kept identical to the byte layout the
// fixture was captured in — the leading `=== exit ===` line, the numeric
// exit on its own line, then the stdout and stderr blocks each preceded
// by their `=== ... ===` banner. When stderr is empty the trailing block
// is just its banner and a newline (matches the fixture's tail bytes).
function composeSectioned(exitCode: number, stdout: string, stderr: string): string {
	return `=== exit ===\n${exitCode}\n=== stdout ===\n${stdout}=== stderr ===\n${stderr}`;
}

// Stage a scratch tree that main() can chdir into. main() shells out to
// `./scripts/fix-task.sh` — that path has to exist and produce the exact
// support-mode bootstrap output the fixture recorded. Everything else
// lives under `discovery/` and is written by main() itself.
function stageScratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-run-support-parity-"));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	return dir;
}

// Write a fake `scripts/fix-task.sh` that reproduces the exact stdout the
// real driver emits when TRP_TASK_MODE=support: a blank line before the
// section, the "== [0] bootstrap ==" header, the wrote-file breadcrumb
// with a byte count (any value — the sanitize rule collapses it), the
// "== done (mode=support — stages 2-14 skipped) ==" trailer, then exit 0.
//
// The exact bytes here are what produce the SUCCESS branch through the
// wrapper. If the wrapper starts filtering the child's stdout, or
// misroutes it away from process.stdout, the composed sanitized text
// diverges from the fixture and the parity assertion trips — which is
// the contract we want to lock down.
function installFakeSupportDriver(dir: string): void {
	const path = join(dir, "scripts", "fix-task.sh");
	// The 247 is arbitrary; the sanitize manifest rewrites `247 bytes`
	// (or any `\d+ bytes`) to `__BYTES__` before comparison so the
	// number itself is not load-bearing on the assertion. Using a
	// non-zero constant keeps the child's stdout deterministic across
	// runs.
	const script = [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		"# Fake fix-task.sh — reproduces the support-mode bootstrap output",
		"# a real driver emits before it short-circuits at stage 1.",
		"mkdir -p discovery/proof/clickup_hand_synth-support-01",
		"echo '{}' > discovery/proof/clickup_hand_synth-support-01/comment-payload.json",
		"echo ''",
		"echo '== [0] bootstrap =='",
		`echo '   wrote discovery/proof/${SLUG}/comment-payload.json (247 bytes)'`,
		"echo '== done (mode=support — stages 2-14 skipped) =='",
		"exit 0",
	].join("\n");
	writeFileSync(path, `${script}\n`);
	chmodSync(path, 0o755);
}

describe("trp-run-loop composed-run parity — HAND_SYNTH-SUPPORT-01 support mode", () => {
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
		stagedDir = stageScratch();
		installFakeSupportDriver(stagedDir);
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

	it("reproduces the recorded composed stdout/stderr/exit form under sanitize", async () => {
		const exitCode = await main([TASK_ID, "--mode=support"]);
		const composed = composeSectioned(exitCode, stdoutText(), stderrText());
		const manifest = loadManifest(MANIFEST_PATH);
		const sanitized = runPipeline(composed, manifest);
		const expected = readFileSync(EXPECTED_PATH, "utf8");

		expect(sanitized).toBe(expected);
	});

	it("resolves --mode=support as an explicit override and exits 0", async () => {
		// Guard against a regression where an explicit --mode is silently
		// re-derived from the task JSON (auto-detection would land on
		// "solve" here — there is no task JSON at all in the scratch dir).
		// The wrapper must trust the operator's override and report the
		// source as `explicit --mode`.
		const exitCode = await main([TASK_ID, "--mode=support"]);
		expect(exitCode).toBe(0);
		const out = stdoutText();
		expect(out).toContain("TRP_TASK_MODE=support (explicit --mode)");
		expect(out).toContain("=== TRP-EE: SUCCESS (attempt 1) ===");
		// A HALT trailer never fires on a successful run — asserting its
		// absence prevents a future refactor from tacking a "next step"
		// block onto every exit code.
		expect(out).not.toContain("=== TRP-EE: HALT");
		expect(out).not.toContain("=== TRP-EE: HARD FAIL");
	});

	it("propagates the child's stdout section through the journal", async () => {
		// The wrapper delegates support-mode work to fix-task.sh. If the
		// journal ever stops fanning the child's stdout into
		// process.stdout, the bootstrap section vanishes from the operator
		// log and the parity fixture would still record a wrapper-only
		// blob. This assertion catches that shape-level regression
		// independently of the byte-for-byte parity above, so a broken
		// journal doesn't hide behind a compensating fixture edit.
		await main([TASK_ID, "--mode=support"]);
		const out = stdoutText();
		expect(out).toContain("== [0] bootstrap ==");
		expect(out).toContain(`wrote discovery/proof/${SLUG}/comment-payload.json`);
		expect(out).toContain("== done (mode=support — stages 2-14 skipped) ==");
	});

	it("sanitize manifest collapses the byte count to a stable placeholder", async () => {
		// The whole reason the fixture ships a sanitize-manifest is so
		// tiny drifts in the comment-payload JSON's size don't break the
		// parity assertion. If the manifest ever grows a rule that
		// accidentally over-scrubs (or loses the byte-count rule
		// entirely), this test catches it before the parity assertion
		// misdiagnoses the failure.
		await main([TASK_ID, "--mode=support"]);
		const composed = composeSectioned(0, stdoutText(), stderrText());
		const manifest = loadManifest(MANIFEST_PATH);
		const sanitized = runPipeline(composed, manifest);
		expect(sanitized).toContain("(__BYTES__)");
		expect(sanitized).not.toMatch(/\(\d+ bytes\)/u);
	});
});
