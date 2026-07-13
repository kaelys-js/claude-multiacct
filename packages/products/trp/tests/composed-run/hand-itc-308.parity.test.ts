// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// G4b composed-run parity test for `trp-run-loop.ts` against HAND_ITC-308.
//
// WHY it matters: the composed run — wrapper -> driver -> failure -> HALT
// trailer — is the end-to-end shape a Claude session observes when the SRP-J
// revise loop trips. The wrapper's stdout, the resolved mode, the propagated
// exit code, and the driver's on-disk artifacts (discovery/trp-input-*,
// discovery/trp-fail-*-a1.json, discovery/fix-log-*.txt) together form the
// contract the main-context loop reads back. A drift on any one field breaks
// the auto-repair loop silently. This test pins that contract byte-for-byte
// against the recorded fixture at
// `tests/fixtures/composed-run/hand-itc-308-solve-expected.json`.
//
// Shape captured per run:
//   { artifacts, exit_code, mode, task_id, wrapper_stdout }
// Every long string collapses through the shared sanitize.ts hasher; the
// stableStringify sorts keys so byte diffs don't depend on insertion order.

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
	"hand-itc-308-solve-expected.json",
);

// Materialise the HAND_ITC-308 fixture into a fresh scratch dir so main()'s
// mkdir/discovery writes never touch the repo tree.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-composed-run-parity-"));
	cpSync(FIXTURE_ROOT, dir, { recursive: true });
	chmodSync(join(dir, "scripts", "fix-task.sh"), 0o755);
	chmodSync(join(dir, "scripts", "trp-run-loop.sh"), 0o755);
	return dir;
}

// Install a fake fix-task.sh that reproduces the on-disk artifacts a real
// Stage 5-8 failure would leave behind: a trp-input-* JSON captured pre-run,
// a trp-fail-*-a1.json failure record, and a fix-log-*.txt trailing log.
// Exits 66 to drive the wrapper down its HALT trailer branch.
//
// The exact byte content of each artifact is what produced the sanitize
// markers in the recorded baseline. Any drift here (extra newline, reordered
// key) shifts the fnv1a hash and trips the parity assertion — which is the
// contract we want to lock down.
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
// Drop it from the artifact map before comparison; the baseline was captured
// without it.
function dropRuntimeInternals(artifacts: Record<string, unknown>, slug: string): void {
	Reflect.deleteProperty(artifacts, `discovery/trp-run-${slug}.log`);
	Reflect.deleteProperty(artifacts, `discovery/task-${slug}.json`);
}

// `TRP_TASK_MODE` defaults to "solve" when unset. Hoisted out of the `it()`
// body so the `??` doesn't read as a conditional inside a test (vitest
// no-conditional-in-test).
function resolveTaskMode(): string {
	return process.env.TRP_TASK_MODE ?? "solve";
}

describe("trp-run-loop composed-run parity — HAND_ITC-308 solve mode", () => {
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

		const exitCode = await main([taskId]);
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
});
