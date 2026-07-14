// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Behaviour tests for `env-bootstrap.ts` — the TS port of
// `trp/scripts/env-bootstrap.sh`. The wrapper is the seam between the fix-src
// checkout and every Stage-F verifier: an install branch that misidentifies
// the package manager, drops `--ignore-scripts`, or silently ignores a
// docker-compose failure poisons the whole revise loop. These tests fix the
// operator-visible contract for every branch — argparse, PM detection,
// compose-file discovery, dry-run passthrough, and the RunError → exit-code
// translation in `main()`.
//
// `@foundation/shell`'s `sh` is mocked so no real `pnpm`/`yarn`/`docker`
// process runs; every test drives the mocked exit code to steer the branch.
// `stdioJournal` is stubbed to a no-op so `run()` doesn't crash when the
// mocked module load elides the real journal factory. Filesystem is real
// (temp dir per test) — lockfile / compose-file presence is the load-bearing
// signal the impl reads.

/* oxlint-disable typescript/explicit-function-return-type, vitest/require-mock-type-parameters */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";
import { detectPm, findComposeFile, main, parseArgs } from "./env-bootstrap.ts";

// Hoisted mock: replace `@foundation/shell` before the module under test is
// evaluated so `run()` never spawns a real child. `stdioJournal` is stubbed
// with a plain no-op journal because the impl calls it unconditionally on
// the non-dry-run path; a bare `sh`-only mock would leave it undefined and
// the module would throw on the first `run()`.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
	stdioJournal: vi.fn(() => ({ stdout: () => {}, stderr: () => {} })),
}));

const mockedSh = vi.mocked(sh);

// Compact ShResult-shaped literal for the `sh` mock. Only `exitCode` is read
// by the impl, but the ShResult type demands the full shape.
function shResult(exitCode: number, stdout = "", stderr = ""): Awaited<ReturnType<typeof sh>> {
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

// Silence + capture stdout / stderr so a failing test doesn't drown the
// reporter and so assertions can grep for the exact log lines the operator
// reads. Returned accessors join every write into one string.
function captureStreams(): { stdout: () => string; stderr: () => string } {
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
	};
}

describe("env-bootstrap parseArgs()", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "env-bootstrap-parse-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns err(2) with 'fix-src path required' when argv is empty", () => {
		const streams = captureStreams();
		const outcome = parseArgs([]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe("ERROR: fix-src path required.\n");
	});

	it("returns err(2) with 'not a directory' for a path that does not exist", () => {
		const missing = join(scratch, "nope");
		const streams = captureStreams();
		const outcome = parseArgs([missing]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe(`ERROR: fix-src not a directory: ${missing}\n`);
	});

	it("returns err(2) with 'not a directory' when the path is a regular file", () => {
		const file = join(scratch, "regular.txt");
		writeFileSync(file, "");
		const streams = captureStreams();
		const outcome = parseArgs([file]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe(`ERROR: fix-src not a directory: ${file}\n`);
	});

	it("returns ok with defaults (withDocker=false, dryRun=false) for a bare directory", () => {
		const outcome = parseArgs([scratch]);
		expect(outcome).toEqual({
			kind: "ok",
			args: { fixSrc: scratch, withDocker: false, dryRun: false },
		});
	});

	it("sets dryRun=true when --dry-run is present", () => {
		const outcome = parseArgs([scratch, "--dry-run"]);
		expect(outcome).toEqual({
			kind: "ok",
			args: { fixSrc: scratch, withDocker: false, dryRun: true },
		});
	});

	it("sets withDocker=true when --with-docker is present", () => {
		const outcome = parseArgs([scratch, "--with-docker"]);
		expect(outcome).toEqual({
			kind: "ok",
			args: { fixSrc: scratch, withDocker: true, dryRun: false },
		});
	});

	it("accepts flags before the positional argument (bash `for arg in $@` order-agnostic)", () => {
		const outcome = parseArgs(["--dry-run", "--with-docker", scratch]);
		expect(outcome).toEqual({
			kind: "ok",
			args: { fixSrc: scratch, withDocker: true, dryRun: true },
		});
	});

	it("returns help on --help", () => {
		const outcome = parseArgs(["--help"]);
		expect(outcome).toEqual({ kind: "help" });
	});

	it("returns help on -h", () => {
		const outcome = parseArgs(["-h"]);
		expect(outcome).toEqual({ kind: "help" });
	});

	it("returns err(2) with the offending token for an unknown flag", () => {
		const streams = captureStreams();
		const outcome = parseArgs([scratch, "--nope"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe("ERROR: unknown flag: --nope\n");
	});

	it("returns err(2) with the second positional when a duplicate positional is passed", () => {
		const streams = captureStreams();
		const outcome = parseArgs([scratch, "extra-arg"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe("ERROR: unexpected positional arg: extra-arg\n");
	});

	it("treats a token starting with '-' as a flag even when it looks like a path", () => {
		// Bash's `case "$arg" in -* ) ...` — anything with a leading dash is a
		// flag candidate. Order of checks matters: `-hz` is not `-h`, so it
		// falls through to the unknown-flag branch.
		const streams = captureStreams();
		const outcome = parseArgs(["-hz"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(streams.stderr()).toBe("ERROR: unknown flag: -hz\n");
	});
});

describe("env-bootstrap detectPm()", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "env-bootstrap-pm-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns 'none' when the directory has no recognised lockfile", () => {
		expect(detectPm(scratch)).toBe("none");
	});

	it("returns 'pnpm' when pnpm-lock.yaml is present", () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		expect(detectPm(scratch)).toBe("pnpm");
	});

	it("returns 'yarn' when yarn.lock is present", () => {
		writeFileSync(join(scratch, "yarn.lock"), "");
		expect(detectPm(scratch)).toBe("yarn");
	});

	it("returns 'bun' when bun.lockb (binary) is present", () => {
		writeFileSync(join(scratch, "bun.lockb"), "");
		expect(detectPm(scratch)).toBe("bun");
	});

	it("returns 'bun' when bun.lock (text form) is present without bun.lockb", () => {
		writeFileSync(join(scratch, "bun.lock"), "");
		expect(detectPm(scratch)).toBe("bun");
	});

	it("returns 'npm' when only package-lock.json is present", () => {
		writeFileSync(join(scratch, "package-lock.json"), "");
		expect(detectPm(scratch)).toBe("npm");
	});

	it("prefers pnpm over npm when both lockfiles exist (order comment in impl)", () => {
		// The impl's inline comment warns that some repos keep a stale
		// package-lock.json next to pnpm-lock.yaml. Priority MUST be pnpm.
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		writeFileSync(join(scratch, "package-lock.json"), "");
		expect(detectPm(scratch)).toBe("pnpm");
	});

	it("prefers yarn over bun when both are present", () => {
		writeFileSync(join(scratch, "yarn.lock"), "");
		writeFileSync(join(scratch, "bun.lockb"), "");
		expect(detectPm(scratch)).toBe("yarn");
	});

	it("ignores a directory named like a lockfile (statSync isFile guard)", () => {
		mkdirSync(join(scratch, "pnpm-lock.yaml"));
		expect(detectPm(scratch)).toBe("none");
	});
});

describe("env-bootstrap findComposeFile()", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "env-bootstrap-compose-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("returns '' when no compose candidate exists", () => {
		expect(findComposeFile(scratch)).toBe("");
	});

	it("finds docker-compose.yml (first candidate)", () => {
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.yml");
	});

	it("finds docker-compose.yaml when .yml absent", () => {
		writeFileSync(join(scratch, "docker-compose.yaml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.yaml");
	});

	it("finds compose.yml when only compose.* variants exist", () => {
		writeFileSync(join(scratch, "compose.yml"), "");
		expect(findComposeFile(scratch)).toBe("compose.yml");
	});

	it("finds compose.yaml when it is the only candidate", () => {
		writeFileSync(join(scratch, "compose.yaml"), "");
		expect(findComposeFile(scratch)).toBe("compose.yaml");
	});

	it("finds docker-compose-test.yml (test-suite variant)", () => {
		writeFileSync(join(scratch, "docker-compose-test.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose-test.yml");
	});

	it("finds docker-compose.test.yml (test-suite variant)", () => {
		writeFileSync(join(scratch, "docker-compose.test.yml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.test.yml");
	});

	it("first match wins when multiple candidates exist (declared order)", () => {
		// COMPOSE_CANDIDATES declares docker-compose.yml before compose.yaml.
		// The impl walks in declaration order — the .yml file must win even
		// though both are present.
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		writeFileSync(join(scratch, "compose.yaml"), "");
		expect(findComposeFile(scratch)).toBe("docker-compose.yml");
	});
});

describe("env-bootstrap main()", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "env-bootstrap-main-"));
		mockedSh.mockReset();
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// ---- exit-code branches from parseArgs ---------------------------------

	it("prints the USAGE block and returns 0 on --help", async () => {
		const streams = captureStreams();
		const rc = await main(["--help"]);
		expect(rc).toBe(0);
		const stdout = streams.stdout();
		// The USAGE text intentionally retains the bash `set -euo pipefail`
		// line (sed range parity) — assert it survives to stdout.
		expect(stdout).toMatch(/# env-bootstrap\.sh —/u);
		expect(stdout).toMatch(/set -euo pipefail/u);
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("returns 2 and prints 'fix-src path required' when argv is empty", async () => {
		const streams = captureStreams();
		const rc = await main([]);
		expect(rc).toBe(2);
		expect(streams.stderr()).toBe("ERROR: fix-src path required.\n");
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("returns 2 for an unknown flag", async () => {
		captureStreams();
		expect(await main(["--nope", scratch])).toBe(2);
		expect(mockedSh).not.toHaveBeenCalled();
	});

	// ---- install stage — package-manager branches --------------------------

	it("prints 'SKIP: no lockfile' to stderr and returns 0 when no lockfile is present", async () => {
		const streams = captureStreams();
		const rc = await main([scratch]);
		expect(rc).toBe(0);
		expect(streams.stderr()).toBe(`SKIP: no lockfile in ${scratch} — nothing to install.\n`);
		// COMPOSE stage still runs and reports 'none found' on an empty dir.
		expect(streams.stdout()).toContain("COMPOSE: none found.\n");
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("invokes 'pnpm install --frozen-lockfile --ignore-scripts' inside fixSrc for pnpm", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockResolvedValueOnce(shResult(0));
		const streams = captureStreams();
		const rc = await main([scratch]);
		expect(rc).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(1);
		expect(mockedSh).toHaveBeenCalledWith(
			"pnpm",
			["install", "--frozen-lockfile", "--ignore-scripts"],
			expect.objectContaining({ cwd: scratch, rejectOnError: false }),
		);
		const stdout = streams.stdout();
		expect(stdout).toContain("PM: pnpm\n");
		expect(stdout).toContain("+ pnpm install --frozen-lockfile --ignore-scripts\n");
	});

	it("invokes 'yarn install --frozen-lockfile --ignore-scripts' for yarn", async () => {
		writeFileSync(join(scratch, "yarn.lock"), "");
		mockedSh.mockResolvedValueOnce(shResult(0));
		const streams = captureStreams();
		expect(await main([scratch])).toBe(0);
		expect(mockedSh).toHaveBeenCalledWith(
			"yarn",
			["install", "--frozen-lockfile", "--ignore-scripts"],
			expect.objectContaining({ cwd: scratch }),
		);
		expect(streams.stdout()).toContain("PM: yarn\n");
	});

	it("invokes 'bun install --frozen-lockfile --ignore-scripts' for bun", async () => {
		writeFileSync(join(scratch, "bun.lockb"), "");
		mockedSh.mockResolvedValueOnce(shResult(0));
		captureStreams();
		expect(await main([scratch])).toBe(0);
		expect(mockedSh).toHaveBeenCalledWith(
			"bun",
			["install", "--frozen-lockfile", "--ignore-scripts"],
			expect.objectContaining({ cwd: scratch }),
		);
	});

	it("invokes 'npm ci --ignore-scripts' for npm (no --frozen-lockfile flag on npm)", async () => {
		writeFileSync(join(scratch, "package-lock.json"), "");
		mockedSh.mockResolvedValueOnce(shResult(0));
		captureStreams();
		expect(await main([scratch])).toBe(0);
		// The impl explicitly comments why npm gets `ci` not `install --frozen-lockfile`.
		expect(mockedSh).toHaveBeenCalledWith(
			"npm",
			["ci", "--ignore-scripts"],
			expect.objectContaining({ cwd: scratch }),
		);
	});

	// ---- dry-run: no subprocess, still prints the '+ ' line ----------------

	it("does not invoke sh under --dry-run, but still prints the '+ ...' pre-echo", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		const streams = captureStreams();
		const rc = await main([scratch, "--dry-run"]);
		expect(rc).toBe(0);
		expect(mockedSh).not.toHaveBeenCalled();
		// Bash `run` echoes the command line whether or not it runs it — the
		// operator relies on the echo to audit dry-runs.
		expect(streams.stdout()).toContain("+ pnpm install --frozen-lockfile --ignore-scripts\n");
	});

	// ---- install failure → RunError → exit code ----------------------------

	it("returns the install command's non-zero exit code verbatim (RunError translation)", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockResolvedValueOnce(shResult(3));
		captureStreams();
		expect(await main([scratch])).toBe(3);
		// Compose stage MUST be skipped after a failed install — the RunError
		// aborts the try block before composeStage runs.
		expect(mockedSh).toHaveBeenCalledTimes(1);
	});

	it("normalises negative exit codes (signal-terminated) to 1", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		// The impl's comment on the -1 branch says bash's 128+N surfaces as
		// -1 from execa; RunError floors it to 1 so downstream loops see a
		// clean non-zero.
		mockedSh.mockResolvedValueOnce(shResult(-1));
		captureStreams();
		expect(await main([scratch])).toBe(1);
	});

	// ---- compose stage -----------------------------------------------------

	it("prints 'COMPOSE: none found.' when no compose file exists", async () => {
		const streams = captureStreams();
		expect(await main([scratch])).toBe(0);
		expect(streams.stdout()).toContain("COMPOSE: none found.\n");
	});

	it("prints the compose filename and the skip line when --with-docker is not set", async () => {
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		const streams = captureStreams();
		expect(await main([scratch])).toBe(0);
		const stdout = streams.stdout();
		expect(stdout).toContain("COMPOSE: docker-compose.yml\n");
		expect(stdout).toContain("COMPOSE: --with-docker not set; skipping 'up -d'.\n");
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("runs 'docker compose -f <file> up -d' inside fixSrc when --with-docker is set", async () => {
		writeFileSync(join(scratch, "compose.yaml"), "");
		mockedSh.mockResolvedValueOnce(shResult(0));
		const streams = captureStreams();
		const rc = await main([scratch, "--with-docker"]);
		expect(rc).toBe(0);
		expect(mockedSh).toHaveBeenCalledWith(
			"docker",
			["compose", "-f", "compose.yaml", "up", "-d"],
			expect.objectContaining({ cwd: scratch }),
		);
		expect(streams.stdout()).toContain("+ docker compose -f compose.yaml up -d\n");
	});

	it("propagates a non-zero docker exit code from composeStage to main's return", async () => {
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		// No lockfile → install skipped; compose is the first (and only) sh call.
		mockedSh.mockResolvedValueOnce(shResult(4));
		captureStreams();
		expect(await main([scratch, "--with-docker"])).toBe(4);
	});

	// ---- both stages together ----------------------------------------------

	it("runs install then compose in order when both preconditions hold", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		mockedSh.mockResolvedValue(shResult(0));
		const streams = captureStreams();
		expect(await main([scratch, "--with-docker"])).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(2);
		// Call 1 is the install.
		expect(mockedSh.mock.calls[0]?.[0]).toBe("pnpm");
		// Call 2 is the compose up.
		expect(mockedSh.mock.calls[1]?.[0]).toBe("docker");
		expect(mockedSh.mock.calls[1]?.[1]).toEqual([
			"compose",
			"-f",
			"docker-compose.yml",
			"up",
			"-d",
		]);
		const stdout = streams.stdout();
		// Ordering — PM header must appear before COMPOSE header.
		expect(stdout.indexOf("PM: pnpm")).toBeLessThan(stdout.indexOf("COMPOSE: docker-compose.yml"));
	});

	it("dry-run under --with-docker echoes both '+ ' lines and calls sh zero times", async () => {
		writeFileSync(join(scratch, "yarn.lock"), "");
		writeFileSync(join(scratch, "docker-compose.yml"), "");
		const streams = captureStreams();
		expect(await main([scratch, "--with-docker", "--dry-run"])).toBe(0);
		expect(mockedSh).not.toHaveBeenCalled();
		const stdout = streams.stdout();
		expect(stdout).toContain("+ yarn install --frozen-lockfile --ignore-scripts\n");
		expect(stdout).toContain("+ docker compose -f docker-compose.yml up -d\n");
	});

	// ---- non-RunError bubbles out (defensive) ------------------------------

	it("rethrows a non-RunError exception from sh (unexpected error, not an exit-code)", async () => {
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "");
		mockedSh.mockRejectedValueOnce(new Error("execa boom"));
		captureStreams();
		// The impl only catches RunError; anything else propagates. This
		// protects operators from a silent 0 return on a bug in the shell
		// layer.
		await expect(main([scratch])).rejects.toThrow("execa boom");
	});
});
