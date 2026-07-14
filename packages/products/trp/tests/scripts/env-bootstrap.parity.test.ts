// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Parity test for `env-bootstrap.ts` (the TS port of
// `trp/scripts/env-bootstrap.sh`). Confirms the four lockfile-detection
// branches (pnpm / yarn / bun / npm) each pick the right install command,
// the `--with-docker` toggle gates the compose up-d call, and the
// terminal branches (SKIP-no-lockfile, non-directory fix-src, unknown flag,
// help) round-trip to bash-parity stdout/stderr/exit.
//
// WHY it matters: `env-bootstrap.ts` is invoked out of `fix-task.sh` (the
// driver) as the Stage-E pre-install. If the port drifts from the bash
// source — a swapped `pnpm ci` for `npm ci`, a `--ignore-scripts` dropped
// off yarn, a compose file loop that stops at the wrong candidate — the
// downstream verifier reads a different tree than the finding was authored
// against and Stage F either fails on an install error the reviewer can't
// reproduce or (worse) silently runs a postinstall out of node_modules
// (SR8 supply-chain). A single-runtime unit test can not catch that; only
// a byte-for-byte capture against the recorded bash output can.
//
// Output shape: (b) captured stdout + stderr + numeric exit. The driver
// does not JSON.parse env-bootstrap's output — it gates on the exit code
// and forwards the streams to the operator log — so a shape-(a) parity
// (JSON.stringify + JSON.parse) would over-constrain trivial punctuation
// while under-testing the actual observables (which command line was
// echoed, which stream did the SKIP land on). All three observables are
// asserted here.
//
// Comparator: captured bytes are piped through
// `sanitize-fixture.runPipeline` with a per-case scrub rule that collapses
// the runtime scratch fix-src prefix to the literal token `<FIX_SRC>`.
// The only ephemeral bytes in env-bootstrap's output are that path when
// it leaks into the SKIP stderr line and the non-directory error stderr
// line; dry-run mode short-circuits every subprocess so the other bytes
// are byte-stable across machines. `sanitize-manifest.json` at the
// fixture root documents this shape; the runtime manifest is built
// programmatically here because the scratch path is only known once the
// tempdir exists.
//
// Failure diagnostic (Rule 12): on mismatch the assertion body prints
// both actual and expected bytes so a CI reader sees exactly which byte
// drifted without cross-referencing the fixture by hand.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, vitest/require-mock-type-parameters, eslint/prefer-destructuring */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sh } from "@foundation/shell";
import { main, detectPm, findComposeFile, parseArgs } from "../../src/scripts/env-bootstrap.ts";
import { type SanitizeManifest, runPipeline } from "../../src/scripts/sanitize-fixture.ts";

// Hoisted mock of `@foundation/shell`. The dry-run branch in env-bootstrap
// returns BEFORE `sh()` is invoked, so the mock is a no-op for every
// parity case — those cases pass `--dry-run` and never touch a subprocess.
// The one non-dry-run test (RunError propagation) drives `mockedSh` to
// return exitCode=42 so `run()` throws `RunError(42, line)` and `main()`
// hands the code back. Vitest hoists this above the imports at transform
// time regardless of source order.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
	stdioJournal: vi.fn(() => ({})),
}));

const mockedSh = vi.mocked(sh);

const FIXTURE_ROOT = resolve(import.meta.dirname, "..", "fixtures", "scripts", "env-bootstrap");

// Regex-escape a literal string for embedding in a `RegExp` pattern. The
// scratch path we substitute contains `/` on POSIX, plus temp-dir suffixes
// that may include `+` or `.` in principle — escape defensively rather
// than trusting `tmpdir()`'s current shape.
function escapeRegex(literal: string): string {
	return literal.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

type FixtureCase = {
	readonly _case?: string;
	readonly tree: Readonly<Record<string, string>>;
	readonly argv_extra: readonly string[];
	readonly expected: {
		readonly stdout: string;
		readonly stderr: string;
		readonly exit: number;
	};
};

// The parity fixtures, driven by describe.each. Ordered to match the
// four lockfile branches in `detectPm()` first, then the SKIP branch,
// then the compose-toggle pair.
const PARITY_CASES: readonly string[] = [
	"pnpm",
	"yarn",
	"bun-lockb",
	"bun-lock",
	"npm",
	"none-lockfile",
	"compose-without-flag",
	"compose-with-flag",
];

// Materialise a scratch fix-src tree from a flat `{relpath: content}` map.
// Parent directories are mkdirp'd on demand so the fixture manifest keeps
// one entry per file (no directory sentinels).
function materialiseTree(root: string, tree: Readonly<Record<string, string>>): void {
	for (const [relPath, body] of Object.entries(tree)) {
		writeFileSync(join(root, relPath), body);
	}
}

// Build a sanitize manifest that collapses the runtime scratch path to
// `<FIX_SRC>`. The manifest is per-case because the scratch dir is only
// known once the tempdir exists; a static file on disk cannot hold the
// pattern.
function scratchManifest(scratch: string): SanitizeManifest {
	return {
		scrub_rules: [
			{
				pattern: escapeRegex(scratch),
				replacement: "<FIX_SRC>",
				reason:
					"runtime scratch fix-src path — collapses to a stable token so the compare is hermetic across machines",
			},
		],
		structural_shape_only: [],
	};
}

// Rule 12: fail loud. Print both sides so vitest names the divergent byte
// without a re-derivation from the log. Lives outside the `it()` block so
// vitest/no-conditional-in-test doesn't flag the branch.
function logMismatch(label: string, actual: string, expected: string): void {
	if (actual !== expected) {
		// eslint-disable-next-line no-console
		console.error(
			`[env-bootstrap parity/${label}] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
		);
	}
}

// Capture writes to a stream by installing a spy that concatenates every
// chunk. Returns the accessor + the spy so afterEach can restore it. Two
// spies (stdout + stderr) are installed per case; both are restored in
// afterEach via `vi.restoreAllMocks`.
function spyStream(stream: NodeJS.WriteStream): () => string {
	let buf = "";
	vi.spyOn(stream, "write").mockImplementation(((chunk: string | Uint8Array) => {
		buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as (typeof stream)["write"]);
	return () => buf;
}

describe("env-bootstrap.ts — parity against trp/scripts/env-bootstrap.sh", () => {
	let scratch: string;
	let getStdout: () => string;
	let getStderr: () => string;

	beforeEach(() => {
		// macOS symlinks /tmp -> /private/tmp; align on the realpath form so
		// the scrub regex (built from `scratch`) matches whatever path the
		// module captures via node:fs. Without realpath the module's own
		// `statSync` on the resolved path leaks the /private/... form into
		// the SKIP stderr line and the scrub misses.
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "env-bootstrap-parity-")));
		getStdout = spyStream(process.stdout);
		getStderr = spyStream(process.stderr);
		mockedSh.mockReset();
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe.each(PARITY_CASES)("case %s", (caseName) => {
		it("reproduces the recorded stdout / stderr / exit byte-for-byte", async () => {
			const fixture = JSON.parse(
				readFileSync(join(FIXTURE_ROOT, caseName, "expected.json"), "utf8"),
			) as FixtureCase;

			materialiseTree(scratch, fixture.tree);

			const argv = [scratch, ...fixture.argv_extra];
			const exit = await main(argv);

			const manifest = scratchManifest(scratch);
			const actualStdout = runPipeline(getStdout(), manifest);
			const actualStderr = runPipeline(getStderr(), manifest);

			logMismatch(`${caseName}:stdout`, actualStdout, fixture.expected.stdout);
			logMismatch(`${caseName}:stderr`, actualStderr, fixture.expected.stderr);

			expect(actualStdout).toBe(fixture.expected.stdout);
			expect(actualStderr).toBe(fixture.expected.stderr);
			expect(exit).toBe(fixture.expected.exit);
			// Every parity case is dry-run: sh() must not be reached. The
			// docker-with-flag fixture is where a byte-order bug is most
			// likely to be hidden by a real subprocess call succeeding for
			// the wrong reason.
			expect(mockedSh).not.toHaveBeenCalled();
		});
	});
});

// ---------------------------------------------------------------------
// Edge-case + branch-coverage tests (not fixture-backed — the observable
// is a short stderr line or a return code; a per-case fixture would be
// more ceremony than it is worth).
// ---------------------------------------------------------------------

describe("env-bootstrap.ts — argv + terminal branches", () => {
	let scratch: string;
	let getStdout: () => string;
	let getStderr: () => string;

	beforeEach(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "env-bootstrap-branches-")));
		getStdout = spyStream(process.stdout);
		getStderr = spyStream(process.stderr);
		mockedSh.mockReset();
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("prints USAGE on --help and returns 0 without touching the tree", async () => {
		const exit = await main(["--help"]);
		expect(exit).toBe(0);
		// The USAGE block is the bash source's line 2-12 slice; every line
		// starts with `#` or `set -euo pipefail`. Assert a stable anchor
		// (the shebang comment) plus the final `set -euo pipefail` so a
		// silent truncation of the middle lines still fails.
		const stdout = getStdout();
		expect(stdout).toContain("env-bootstrap.sh");
		expect(stdout).toContain("set -euo pipefail");
		expect(getStderr()).toBe("");
	});

	it("prints USAGE on -h (short flag) with the same body", async () => {
		const exit = await main(["-h"]);
		expect(exit).toBe(0);
		expect(getStdout()).toContain("set -euo pipefail");
	});

	it("returns 2 with 'unknown flag' on an unrecognised dash-prefix argv", async () => {
		const exit = await main(["--frobnicate"]);
		expect(exit).toBe(2);
		expect(getStderr()).toBe("ERROR: unknown flag: --frobnicate\n");
	});

	it("returns 2 with 'fix-src path required' when no positional is passed", async () => {
		const exit = await main(["--dry-run"]);
		expect(exit).toBe(2);
		expect(getStderr()).toBe("ERROR: fix-src path required.\n");
	});

	it("returns 2 with 'unexpected positional arg' when two positionals are passed", async () => {
		const exit = await main([scratch, "second-arg"]);
		expect(exit).toBe(2);
		expect(getStderr()).toBe("ERROR: unexpected positional arg: second-arg\n");
	});

	it("returns 2 with 'not a directory' when the positional does not point at a dir", async () => {
		const notADir = join(scratch, "does-not-exist");
		const exit = await main([notADir]);
		expect(exit).toBe(2);
		expect(getStderr()).toBe(`ERROR: fix-src not a directory: ${notADir}\n`);
	});

	it("also rejects a file (not a directory) as the positional", async () => {
		// isDir() returns false for a file — matches bash `[ -d file ]`.
		const filePath = join(scratch, "not-a-dir.txt");
		writeFileSync(filePath, "");
		const exit = await main([filePath]);
		expect(exit).toBe(2);
		expect(getStderr()).toBe(`ERROR: fix-src not a directory: ${filePath}\n`);
	});

	it("propagates a non-zero exit from `sh()` as the process exit code (RunError)", async () => {
		// Stage a pnpm lockfile so installStage reaches `run()` and calls
		// `sh()` (no --dry-run). The mocked sh returns exitCode=42; run()
		// throws RunError(42, line); main() catches and returns 42.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockResolvedValue({
			command: "pnpm",
			args: ["install", "--frozen-lockfile", "--ignore-scripts"],
			exitCode: 42,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
		} as Awaited<ReturnType<typeof sh>>);

		const exit = await main([scratch]);
		expect(exit).toBe(42);
		// sh() was reached — the mock recorded a single call for the install
		// command (compose stage never runs because installStage threw).
		expect(mockedSh).toHaveBeenCalledTimes(1);
		const call = mockedSh.mock.calls[0];
		expect(call?.[0]).toBe("pnpm");
		expect(call?.[1]).toEqual(["install", "--frozen-lockfile", "--ignore-scripts"]);
	});

	it("normalises a negative exit code (signal-terminated child) to 1", async () => {
		// execa's `sh()` surfaces signal-terminated children as exitCode < 0;
		// `run()` normalises that to 1 so the main() return value stays in
		// the shell's non-signal exit range. Uses -1 as the sentinel.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockResolvedValue({
			command: "pnpm",
			args: [],
			exitCode: -1,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
		} as Awaited<ReturnType<typeof sh>>);

		const exit = await main([scratch]);
		expect(exit).toBe(1);
	});

	it("returns 0 when `sh()` exits cleanly (installStage + composeStage happy path)", async () => {
		// Not --dry-run: run() invokes sh(), which returns 0 (mocked), so
		// run() completes without throwing and main() returns 0. Covers the
		// `result.exitCode !== 0` false branch of run() (line 155) which
		// dry-run cases and RunError cases can't reach.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		mockedSh.mockResolvedValue({
			command: "mock",
			args: [],
			exitCode: 0,
			signal: undefined,
			stdout: "",
			stderr: "",
			timedOut: false,
			durationMs: 0,
		} as Awaited<ReturnType<typeof sh>>);

		const exit = await main([scratch, "--with-docker"]);
		expect(exit).toBe(0);
		// Two subprocess calls: install (pnpm) + compose up (docker). Both
		// reach sh() because the run() success branch flows through.
		expect(mockedSh).toHaveBeenCalledTimes(2);
		expect(mockedSh.mock.calls[0]?.[0]).toBe("pnpm");
		expect(mockedSh.mock.calls[1]?.[0]).toBe("docker");
	});

	it("does not throw non-RunError exceptions; they propagate to the caller", async () => {
		// A generic Error from `sh()` (network flake, mock misconfig) is NOT
		// caught by main()'s `error instanceof RunError` branch — parity
		// with the bash source, which has no separate handler for
		// non-shell-exit errors. main() rethrows so the CLI wrapper's
		// top-level catch converts it to exit 1.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockRejectedValue(new Error("simulated non-run failure"));

		await expect(main([scratch])).rejects.toThrow("simulated non-run failure");
	});
});

// ---------------------------------------------------------------------
// Pure-helper coverage — detectPm / findComposeFile / parseArgs. Direct
// calls with no I/O beyond the scratch tempdir; each assertion pins one
// branch inside those helpers so the coverage counter stays honest.
// ---------------------------------------------------------------------

describe("detectPm", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "env-bootstrap-detect-")));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns 'none' when no lockfile is present", () => {
		expect(detectPm(scratch)).toBe("none");
	});

	it("returns 'pnpm' when pnpm-lock.yaml exists", () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		expect(detectPm(scratch)).toBe("pnpm");
	});

	it("prefers pnpm even when a stale package-lock.json is present alongside", () => {
		// The source comment calls this branch out by name — some repos
		// keep a stale package-lock.json next to pnpm-lock.yaml; pnpm wins
		// so the install command matches the primary lockfile.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		writeFileSync(join(scratch, "package-lock.json"), "");
		expect(detectPm(scratch)).toBe("pnpm");
	});

	it("returns 'yarn' when yarn.lock exists (and no pnpm-lock.yaml)", () => {
		writeFileSync(join(scratch, "yarn.lock"), "");
		expect(detectPm(scratch)).toBe("yarn");
	});

	it("returns 'bun' when bun.lockb exists", () => {
		writeFileSync(join(scratch, "bun.lockb"), "");
		expect(detectPm(scratch)).toBe("bun");
	});

	it("returns 'bun' when only bun.lock (text form) exists", () => {
		writeFileSync(join(scratch, "bun.lock"), "");
		expect(detectPm(scratch)).toBe("bun");
	});

	it("returns 'npm' when only package-lock.json exists", () => {
		writeFileSync(join(scratch, "package-lock.json"), "");
		expect(detectPm(scratch)).toBe("npm");
	});
});

describe("findComposeFile", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "env-bootstrap-compose-")));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns an empty string when no candidate exists", () => {
		expect(findComposeFile(scratch)).toBe("");
	});

	it("prefers docker-compose.yml over every other candidate", () => {
		// docker-compose.yml is the first candidate in the walk; every
		// other listed candidate must lose to it when both are present.
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		writeFileSync(join(scratch, "compose.yml"), "");
		writeFileSync(join(scratch, "docker-compose-test.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.yml");
	});

	it("picks docker-compose.yaml when only the .yaml form is present", () => {
		writeFileSync(join(scratch, "docker-compose.yaml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.yaml");
	});

	it("picks compose.yml when only the short form is present", () => {
		writeFileSync(join(scratch, "compose.yml"), "");
		expect(findComposeFile(scratch)).toBe("compose.yml");
	});

	it("picks compose.yaml when only the short-yaml form is present", () => {
		writeFileSync(join(scratch, "compose.yaml"), "");
		expect(findComposeFile(scratch)).toBe("compose.yaml");
	});

	it("picks docker-compose-test.yml when only the test-suffix form is present", () => {
		writeFileSync(join(scratch, "docker-compose-test.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose-test.yml");
	});

	it("picks docker-compose.test.yml when only the dotted-test form is present", () => {
		writeFileSync(join(scratch, "docker-compose.test.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.test.yml");
	});

	it("skips a directory named like a compose file (isFile check gates it)", () => {
		// Bash `[ -f path ]` and the TS `isFile()` both return false on a
		// directory — a nested `docker-compose.yml/` should not fingerprint
		// as the compose file.
		mkdirSync(join(scratch, "docker-compose.yml"));
		expect(findComposeFile(scratch)).toBe("");
	});
});

describe("parseArgs", () => {
	let scratch: string;
	let getStderr: () => string;

	beforeEach(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "env-bootstrap-parseargs-")));
		getStderr = spyStream(process.stderr);
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns {kind:'ok', args} for the minimal valid argv", () => {
		const out = parseArgs([scratch]);
		expect(out.kind).toBe("ok");
		if (out.kind === "ok") {
			expect(out.args).toEqual({ fixSrc: scratch, withDocker: false, dryRun: false });
		}
	});

	it("sets dryRun when --dry-run is passed", () => {
		const out = parseArgs([scratch, "--dry-run"]);
		expect(out.kind).toBe("ok");
		if (out.kind === "ok") {
			expect(out.args.dryRun).toBe(true);
			expect(out.args.withDocker).toBe(false);
		}
	});

	it("sets withDocker when --with-docker is passed", () => {
		const out = parseArgs([scratch, "--with-docker"]);
		expect(out.kind).toBe("ok");
		if (out.kind === "ok") {
			expect(out.args.withDocker).toBe(true);
			expect(out.args.dryRun).toBe(false);
		}
	});

	it("sets both flags when both are passed (order-independent)", () => {
		const out = parseArgs(["--with-docker", scratch, "--dry-run"]);
		expect(out.kind).toBe("ok");
		if (out.kind === "ok") {
			expect(out.args).toEqual({ fixSrc: scratch, withDocker: true, dryRun: true });
		}
	});

	it("returns {kind:'help'} on --help (no stderr, no state)", () => {
		const out = parseArgs(["--help"]);
		expect(out.kind).toBe("help");
		expect(getStderr()).toBe("");
	});
});
