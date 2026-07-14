// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Composed-run parity test for the `spike-writeup` mode. The composed run —
// `trp-run-loop.ts` (wrapper) driving `scripts/fix-task.sh` (driver) — is the
// end-to-end shape a Claude session observes when a spike ticket lands with
// no bundle and the canonical writeup ships the comment payload. The wrapper
// header, the resolved-mode line, the driver's `[SW] spike-writeup emit`
// block, the "no bundle -> canonical writeup" fallback, and the wrapper's
// SUCCESS trailer together form the contract downstream tools grep against.
// This test pins that contract byte-for-byte against the recorded fixture at
// `tests/fixtures/composed-run/spike-writeup/expected.txt`.
//
// Shape captured per run:
//   === exit ===
//   <numeric exit code>
//   === stdout ===
//   <wrapper prologue + driver emit + wrapper SUCCESS trailer>
//   === stderr ===
//   <stderr bytes, empty on the happy path>
//
// Byte counts in the driver's writes vary per run as the canonical writeup
// edits, so the fixture's `sanitize-manifest.json` scrubs `\d+ bytes` to a
// `__BYTES__` placeholder before the diff. The synthetic driver installed
// below emits real integer byte counts so the scrub is actually exercised
// rather than compared against a pre-scrubbed literal.

import {
	chmodSync,
	cpSync,
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
const FIXTURE_ROOT = resolve(HERE, "..", "fixtures", "composed-run", "spike-writeup");
const EXPECTED_PATH = join(FIXTURE_ROOT, "expected.txt");
const MANIFEST_PATH = join(FIXTURE_ROOT, "sanitize-manifest.json");

const TASK_ID = "clickup:HAND_ITC-308";
const SLUG = "clickup_hand_itc-308";

// Materialise the spike-writeup fixture into a scratch dir so main()'s
// discovery/ writes never touch the repo tree. The scratch dir also holds
// the synthetic fix-task.sh the wrapper spawns.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-spike-writeup-"));
	cpSync(FIXTURE_ROOT, dir, { recursive: true });
	return dir;
}

// Install a synthetic driver that produces the exact middle-of-stdout the
// real fix-task.ts spike-writeup path would emit. The driver mirrors the
// canonical-source fallback branch: no bundle on disk, canonical writeup
// owned by LiveWriteup, comment payload rendered from the canonical .md.
//
// Byte counts (2048, 1536) are illustrative — the fixture's scrub rule
// (`\d+ bytes` -> `__BYTES__`) collapses them before the parity check, and
// the point of shipping them here is to prove the sanitize step actually
// runs. Any positive integer would satisfy the pattern.
function installSpikeWriteupDriver(dir: string): void {
	// `cpSync` from FIXTURE_ROOT copied whatever the fixture ships. The
	// fixture does not carry `scripts/`, so mkdir it before writing the
	// synthetic fix-task.sh. sfp.env / trp.env are written empty as a
	// precaution against a future change that has the wrapper pre-source
	// them — the current wrapper does not touch either.
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "sfp.env"), "");
	writeFileSync(join(dir, "trp.env"), "");
	const path = join(dir, "scripts", "fix-task.sh");
	const script = [
		"#!/usr/bin/env bash",
		"set -uo pipefail",
		String.raw`printf '\n== [0] bootstrap ==\n'`,
		String.raw`printf '   tools ready\n'`,
		String.raw`printf '\n== [1] load POC context ==\n'`,
		`printf '   no POC dir for ${TASK_ID} — using task JSON at discovery/task-${SLUG}.json as context\\n'`,
		String.raw`printf '   spike-writeup: skipping client-repo resolution (client_repo=<none>)\n'`,
		String.raw`printf '   ClickUp task:   ()\n'`,
		String.raw`printf '\n== [SW] spike-writeup emit (spike-writeup) ==\n'`,
		String.raw`printf '   TRP_ALLOW_INLINE_SPIKE!=true — driver will NOT produce a writeup (LiveWriteup owns canonical)\n'`,
		`printf '   wrote /tmp/trp-spike-input-${SLUG}.json (2048 bytes, 0 criterion(s))\\n'`,
		String.raw`printf '\n== NEXT (main-context step): ==\n'`,
		String.raw`printf "  Workflow({ scriptPath: 'workflows/trp-fix-task.js',\n"`,
		`printf "             args: <contents of /tmp/trp-spike-input-${SLUG}.json (already carries trp_task_mode='spike-writeup')> })\\n"`,
		`printf '  Then write the returned bundle to discovery/trp-bundle-${SLUG}.json and re-run this driver.\\n'`,
		`printf '   no bundle at discovery/trp-bundle-${SLUG}.json — using canonical writeup (discovery/proof/${SLUG}/spike-writeup.md) for comment payload\\n'`,
		`printf '   wrote discovery/proof/${SLUG}/comment-payload.json (1536 bytes, from spike-writeup.md)\\n'`,
		String.raw`printf '== done (mode=spike-writeup, comment-payload from canonical source) ==\n'`,
		"exit 0",
	].join("\n");
	writeFileSync(path, `${script}\n`);
	chmodSync(path, 0o755);
}

// Format the captured triplet in the fixture's on-disk shape so both sides
// of the comparison have the same envelope. Deliberately does not append a
// trailing newline — expected.txt ends with `=== stderr ===\n` when stderr
// is empty, and the format string below already carries that final `\n`.
function formatCapture(exitCode: number, stdoutText: string, stderrText: string): string {
	return `=== exit ===\n${exitCode}\n=== stdout ===\n${stdoutText}=== stderr ===\n${stderrText}`;
}

function capturedText(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

describe("composed-run parity — spike-writeup mode (HAND_ITC-308)", () => {
	let originalCwd: string;
	let stagedDir: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalCwd = process.cwd();
		for (const key of [
			"TRP_ALLOW_REMOTE_MUTATE",
			"TRP_TASK_MODE",
			"TRP_ALLOW_INLINE_SPIKE",
		] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		stagedDir = stageFixture();
		installSpikeWriteupDriver(stagedDir);
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

	it("reproduces expected.txt byte-for-byte after sanitize scrub", async () => {
		const exitCode = await main([TASK_ID, "--mode=spike-writeup"]);
		const stdoutText = capturedText(stdoutSpy);
		const stderrText = capturedText(stderrSpy);

		const captured = formatCapture(exitCode, stdoutText, stderrText);
		const manifest = loadManifest(MANIFEST_PATH);
		const scrubbed = runPipeline(captured, manifest);
		const expected = readFileSync(EXPECTED_PATH, "utf8");

		expect(scrubbed).toBe(expected);
	});

	it("resolves --mode=spike-writeup as the explicit override (not auto-detected)", async () => {
		const exitCode = await main([TASK_ID, "--mode=spike-writeup"]);
		const stdoutText = capturedText(stdoutSpy);

		expect(exitCode).toBe(0);
		// The `(explicit --mode)` suffix is the tell that resolveMode() took the
		// override branch rather than the task-JSON heuristic. A drift here would
		// mean the wrapper silently fell back to auto-detection — which for the
		// __PLACEHOLDER__ task shape ships in the fixture would still resolve
		// to "solve", not "spike-writeup", and the parity assertion above would
		// catch it. This assertion pins the source label independently.
		expect(stdoutText).toContain("TRP_TASK_MODE=spike-writeup (explicit --mode)");
	});

	it("propagates the driver's exit 0 as the wrapper's SUCCESS path", async () => {
		const exitCode = await main([TASK_ID, "--mode=spike-writeup"]);
		const stdoutText = capturedText(stdoutSpy);

		expect(exitCode).toBe(0);
		// The SUCCESS trailer is what a Claude session greps for to confirm the
		// composed run finished without needing REVISE. HALT / HARD FAIL trailers
		// carry different tokens and would leak past this assertion, so any
		// drift in the wrapper's exit-code branch fires here.
		expect(stdoutText).toContain("=== TRP-EE: SUCCESS (attempt 1) ===");
		expect(stdoutText).not.toContain("=== TRP-EE: HALT");
		expect(stdoutText).not.toContain("=== TRP-EE: HARD FAIL");
	});
});
