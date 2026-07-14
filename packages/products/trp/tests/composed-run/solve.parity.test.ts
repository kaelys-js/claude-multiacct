// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Composed-run parity test for `trp-run-loop.ts` in `solve` mode.
//
// WHY it matters: solve is the default TRP path for a non-spike ticket, and
// its stdout/stderr shape — wrapper banner + driver stages + HALT trailer
// when the driver exits 66 with no bundle on attempt=1 — is the exact byte
// stream a Claude session in the main context greps to decide "did the
// wrapper halt on stage 4b for lack of a bundle, or on something else?".
// A drift in any of those lines silently breaks the SRP-J revise loop, so
// this test pins the composed output against the recorded fixture at
// `tests/fixtures/composed-run/solve/expected.txt`.
//
// Shape captured: the canonical parity envelope
//   `=== exit ===\n<code>\n=== stdout ===\n<stdout>=== stderr ===\n<stderr>`
// then sanitized through `sanitize-fixture.runPipeline` against the
// fixture's own `sanitize-manifest.json` (which collapses volatile
// `\d+ bytes` counters to `__BYTES__`). Byte-for-byte compare against
// the recorded expected.txt — Rule 12 dictates any drift fails loud.
//
// The driver (`./scripts/fix-task.sh`) is stubbed in the scratch cwd
// because the real driver is a 3.6k-line TS port that shells out to git
// + gh + workflow subprocesses; standing that up per-test would drown
// the parity signal (the wrapper's contract) in driver flakiness. The
// stub reproduces the recorded stdout + stderr the real driver emits on
// its `TRP4 bundle absent` branch, verbatim from the fixture. If the
// real driver's output on that branch ever drifts, that's a fix-task
// parity concern — this test focuses on how the wrapper composes with
// whatever the driver writes.

/* oxlint-disable vitest/no-conditional-in-test */

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
import { loadManifest, runPipeline } from "../../src/scripts/sanitize-fixture.ts";
import { main } from "../../src/scripts/trp-run-loop.ts";

const HERE = import.meta.dirname;
const FIXTURE_DIR = resolve(HERE, "..", "fixtures", "composed-run", "solve");
const EXPECTED_PATH = join(FIXTURE_DIR, "expected.txt");
const MANIFEST_PATH = join(FIXTURE_DIR, "sanitize-manifest.json");
const TASK_JSON_PATH = join(FIXTURE_DIR, "task.json");

const TASK_ID = "clickup:HAND_ITC-308";
const TASK_SLUG = "clickup_hand_itc-308";

// The driver stdout the real fix-task.ts emits when it enters and halts on
// stage 4b with no bundle on attempt=1. Copied verbatim from the recorded
// expected.txt so a drift in the fixture and a drift in this literal show
// up as the SAME parity failure — the fixture is the single source of
// truth, this string is its dependent.
//
// Notable escapes: em-dashes are the real UTF-8 codepoints (—) the
// driver prints, not ASCII '--'. Two blank lines around `[4b]` are
// intentional and mirror the driver's `section() + writeStderr('\n')`
// interleave — the BLOCKER line is preceded by a bare newline on stdout
// before the WARN goes to stderr.
const DRIVER_STDOUT = [
	"",
	"== [0] bootstrap ==",
	"   tools ready",
	"",
	"== [1] load POC context ==",
	`   no POC dir for ${TASK_ID} — using task JSON at discovery/task-${TASK_SLUG}.json as context`,
	"   PINNED_SHA=5d47be3a593e (source: gh_api_remote_head)",
	`   ${TASK_ID} -> tttstudios/handled-monorepo-poc (slug=handled-monorepo-poc, branch=main) @ 5d47be3a593e`,
	"   ClickUp task:   ()",
	"",
	`== [2] fetch client @ pinned SHA -> discovery/fix-src/handled-monorepo-poc-${TASK_SLUG}/ ==`,
	"   using existing clone; hard-reset + checkout 5d47be3a593effe56e35991476b5e0efe93f01eb",
	"   fetch failed but pinned SHA is local — proceeding (offline mode)",
	"   HEAD -> 5d47be3a",
	"",
	`== [3] prep workflow input -> discovery/trp-input-${TASK_SLUG}.json ==`,
	// 500 is arbitrary — the sanitize manifest's `\d+ bytes` rule collapses
	// it to `__BYTES__`. A byte-count drift in the real driver has no bearing
	// on the wrapper's contract, so we don't try to fake the exact number.
	"   wrote 500 bytes",
	"",
	"== [4b] TRP-V cross-file bundle check (semantic consistency) ==",
	"",
	`   BLOCKER: TRP4 bundle absent failed at "no bundle at discovery/trp-bundle-${TASK_SLUG}.json on attempt=1 — main-context Workflow() invocation required (mirrors SRP29)"`,
	`   wrote discovery/trp-fail-${TASK_SLUG}-a1.json (200 bytes)`,
	"   [trp-j] auto-repair loop (attempt 1 / 5)",
	`   [trp-j] main context re-invokes workflow with previous_attempt = @discovery/trp-fail-${TASK_SLUG}-a1.json`,
	`   [trp-j] then re-run: ./scripts/fix-task.sh ${TASK_ID} --after-workflow=discovery/trp-bundle-${TASK_SLUG}.json --attempt=2`,
	"",
].join("\n");

const DRIVER_STDERR = `WARN: ${TASK_ID} has no client_repo in task JSON — falling back to tttstudios/handled-monorepo-poc\n`;

// Install a Node-shebang driver at ./scripts/fix-task.sh in the scratch
// cwd. Node is used (not bash) so the literal em-dashes and multi-line
// content round-trip through JSON.stringify without any heredoc/escaping
// gymnastics. The wrapper only calls `sh("./scripts/fix-task.sh", ...)`;
// the file's shebang decides its interpreter.
function installDriver(scratch: string, stdoutText: string, stderrText: string): void {
	const scriptsDir = join(scratch, "scripts");
	mkdirSync(scriptsDir, { recursive: true });
	const body = [
		"#!/usr/bin/env node",
		`process.stdout.write(${JSON.stringify(stdoutText)});`,
		`process.stderr.write(${JSON.stringify(stderrText)});`,
		"process.exit(66);",
		"",
	].join("\n");
	const path = join(scriptsDir, "fix-task.sh");
	writeFileSync(path, body);
	chmodSync(path, 0o755);
}

// Seed the fixture task JSON at the path the wrapper resolves for a
// discovery/task-<slug>.json probe. resolveMode() reads it via existsSync;
// the fake driver never touches it, but the mode-resolution path in the
// wrapper does when `--mode` isn't explicit. We pass `--mode=solve`
// anyway (source=explicit) so this write is defensive against a future
// wrapper change.
function seedTaskJson(scratch: string): void {
	const discoveryDir = join(scratch, "discovery");
	mkdirSync(discoveryDir, { recursive: true });
	const taskJson = readFileSync(TASK_JSON_PATH, "utf8");
	writeFileSync(join(discoveryDir, `task-${TASK_SLUG}.json`), taskJson);
}

function readSpyText(spy: ReturnType<typeof vi.spyOn>): string {
	return spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

describe("trp-run-loop composed-run parity — solve mode", () => {
	let originalCwd: string;
	let scratch: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalCwd = process.cwd();
		// resolveMode reads TRP_TASK_MODE indirectly (it's SET, not read, but
		// the wrapper's post-run env leak has bitten adjacent tests); save +
		// clear both mutation gates so this test never inherits state.
		for (const key of ["TRP_ALLOW_REMOTE_MUTATE", "TRP_TASK_MODE"] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		scratch = mkdtempSync(join(tmpdir(), "trp-solve-parity-"));
		process.chdir(scratch);
		seedTaskJson(scratch);
		installDriver(scratch, DRIVER_STDOUT, DRIVER_STDERR);
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
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// mkdtemp dirs are cleaned by the OS eventually — non-fatal.
		}
	});

	it("reproduces expected.txt byte-for-byte after sanitize", async () => {
		const exitCode = await main([TASK_ID, "--mode=solve"]);

		expect(exitCode).toBe(66);

		const capturedStdout = readSpyText(stdoutSpy);
		const capturedStderr = readSpyText(stderrSpy);

		// Canonical parity envelope. The wrapper's stdout must end with a
		// trailing newline (printHaltTrailer emits one on its final line);
		// concatenation preserves it so `=== stderr ===` lands on its own
		// line without an extra join character between blocks.
		const raw = `=== exit ===\n${exitCode}\n=== stdout ===\n${capturedStdout}=== stderr ===\n${capturedStderr}`;

		const manifest = loadManifest(MANIFEST_PATH);
		const actual = runPipeline(raw, manifest);
		const expected = readFileSync(EXPECTED_PATH, "utf8");

		if (actual !== expected) {
			// Rule 12: fail loud. JSON.stringify both sides so any invisible
			// whitespace or unicode difference reads legibly in the CI log
			// without cross-referencing the fixture by hand.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:solve] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
			);
		}
		expect(actual).toBe(expected);
	});

	it("resolves mode with source='explicit --mode' (not auto-detected)", async () => {
		// A regression guard: if a future refactor makes resolveMode ignore
		// --mode=... and fall back to task-JSON heuristic, expected.txt would
		// still match (the task JSON is [SPIKE]-free so the heuristic also
		// picks 'solve'), but the source label would change to
		// 'auto-detected' and the SRP-J audit trail would silently lie about
		// what mode the operator picked. Pin the source token explicitly.
		await main([TASK_ID, "--mode=solve"]);
		const stdout = readSpyText(stdoutSpy);
		expect(stdout).toContain("TRP_TASK_MODE=solve (explicit --mode)");
	});

	it("propagates the driver's exit 66 as its own exit code", async () => {
		// Independent of the parity envelope: the wrapper contract is that
		// exit 66 from the driver reaches the caller unchanged. This is the
		// signal `srp-run-loop.sh` and any main-context loop-wrapper polls to
		// decide "re-invoke workflow" vs "done". Rewriting the wrapper to
		// swallow or remap 66 would silently break auto-repair.
		const exitCode = await main([TASK_ID, "--mode=solve"]);
		expect(exitCode).toBe(66);
	});
});
