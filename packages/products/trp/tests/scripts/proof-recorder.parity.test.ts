// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Parity + branch coverage for `proof-recorder.ts` — the TS port of
// `trp/scripts/proof-recorder.sh`. The bash source dispatches on five
// modalities (ui, backend, terminal, iac, bugfix-red-green) and switches
// on two platform probes (util-linux `sha256sum` vs BSD/macOS `shasum`;
// util-linux `script --version` vs BSD `script file cmd`). A drift on any
// modality's write-then-sidecar sequence, on any exit-code contract
// (2 unknown/missing, 4 no-regression, 5 fix-not-green), or on the
// platform branches would mean the driver's proof folder holds evidence
// the operator can't cite — SR3 (verify at exact commit) plus SP1
// (evidence by provenance) both fail silently.
//
// The tests mock `@foundation/shell.sh` so subprocesses never run; each
// scenario asserts on the exact arg vector passed to sh(), the resulting
// on-disk file content, the sidecar bytes, the stdout/stderr the caller
// sees, and the returned exit code. Filesystem writes go into a scratch
// dir per test so no state leaks across cases and the repo's real
// discovery/ tree stays untouched.
//
// Lint disables — the parity assertions are structured around narrow
// mock-implementation closures that branch on command args, so the
// vitest/no-conditional-* rules fire on legitimate patterns; `require-await`
// fires on async mock impls the port needs for type parity with `sh()`.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, vitest/require-mock-type-parameters, eslint/require-await, eslint/no-void, unicorn/prefer-array-find, typescript/consistent-type-imports */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";

vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
}));

const mockedSh = vi.mocked(sh);

type ShResult = Awaited<ReturnType<typeof sh>>;

function ok(stdout = "", stderr = "", exitCode = 0): ShResult {
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

// The module caches the sha256 probe across calls (`sha256CommandCache`).
// A test that flipped that branch would leak into every subsequent test in
// the same worker. Use dynamic import + `vi.resetModules()` inside a helper
// so each scenario starts with a clean cache. `main`, `parseArgs`, and
// `slugify` are re-imported per test — cheap on Node's module loader and
// the only way to get the observable branch coverage the port promises.
async function loadMod(): Promise<typeof import("../../src/scripts/proof-recorder.ts")> {
	vi.resetModules();
	return await import("../../src/scripts/proof-recorder.ts");
}

// Silence + capture stdout/stderr for a single test. Restores the spies
// on cleanup; the returned `.stdout()` / `.stderr()` join every write into
// a single string so the caller can grep exact substrings without caring
// how many chunks the source emitted.
function silenceIo(): {
	stdout: () => string;
	stderr: () => string;
	restore: () => void;
} {
	const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		restore: () => {
			outSpy.mockRestore();
			errSpy.mockRestore();
		},
	};
}

// Predicate over `sh()` mock calls. The mock is invoked as
// `sh(command, args, options)` — return true when the tuple matches.
function findShCall(
	predicate: (cmd: string, args: readonly string[]) => boolean,
): [string, readonly string[]] | null {
	for (const call of mockedSh.mock.calls) {
		const cmd = String(call[0]);
		const args = (call[1] ?? []) as readonly string[];
		if (predicate(cmd, args)) {
			return [cmd, args];
		}
	}
	return null;
}

// The bash source's exit-code contract:
//   0 — success
//   2 — argparse / required-arg / unknown-flag error
//   4 — bugfix-red-green: HEAD~1 was already green (no regression)
//   5 — bugfix-red-green: HEAD not green (fix does not pass its own test)
// A test that asserts a specific numeric drift here fails loud — the
// number itself is part of the contract fix-task.sh interprets.

describe("proof-recorder — parseArgs", () => {
	const savedEnv = {
		PROOF_MODALITY: process.env["PROOF_MODALITY"],
		PROOF_SCRIPT: process.env["PROOF_SCRIPT"],
	};

	beforeEach(() => {
		Reflect.deleteProperty(process.env, "PROOF_MODALITY");
		Reflect.deleteProperty(process.env, "PROOF_SCRIPT");
	});

	afterEach(() => {
		if (savedEnv.PROOF_MODALITY === undefined) {
			Reflect.deleteProperty(process.env, "PROOF_MODALITY");
		} else {
			process.env["PROOF_MODALITY"] = savedEnv.PROOF_MODALITY;
		}
		if (savedEnv.PROOF_SCRIPT === undefined) {
			Reflect.deleteProperty(process.env, "PROOF_SCRIPT");
		} else {
			process.env["PROOF_SCRIPT"] = savedEnv.PROOF_SCRIPT;
		}
	});

	it("accepts every long flag and returns them as-typed", async () => {
		const { parseArgs } = await loadMod();
		const outcome = parseArgs([
			"--task",
			"HAND-1",
			"--modality",
			"ui",
			"--script",
			"tests/e2e.spec.ts",
			"--out",
			"/tmp/x.log",
		]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") {
			throw new Error("expected ok");
		}
		expect(outcome.args).toEqual({
			task: "HAND-1",
			modality: "ui",
			scriptPath: "tests/e2e.spec.ts",
			outOverride: "/tmp/x.log",
		});
	});

	it("--help and -h both short-circuit to kind:help before required-arg checks", async () => {
		const { parseArgs } = await loadMod();
		expect(parseArgs(["--help"]).kind).toBe("help");
		expect(parseArgs(["-h"]).kind).toBe("help");
		// help wins even when --task is missing — the source's while-loop
		// returns from -h before the required-arg validation below fires.
		expect(parseArgs(["--modality", "ui", "-h"]).kind).toBe("help");
	});

	it("reports 'unknown flag' with exit 2 on an unrecognised argv token", async () => {
		const { parseArgs } = await loadMod();
		const io = silenceIo();
		try {
			const outcome = parseArgs(["--bogus"]);
			expect(outcome).toEqual({ kind: "err", exitCode: 2 });
			expect(io.stderr()).toBe("ERROR: unknown flag: --bogus\n");
		} finally {
			io.restore();
		}
	});

	it("reports 'ERROR: --task required' with exit 2 when --task is absent", async () => {
		const { parseArgs } = await loadMod();
		const io = silenceIo();
		try {
			const outcome = parseArgs(["--modality", "iac"]);
			expect(outcome).toEqual({ kind: "err", exitCode: 2 });
			expect(io.stderr()).toBe("ERROR: --task required\n");
		} finally {
			io.restore();
		}
	});

	it("reports 'ERROR: --modality (or PROOF_MODALITY) required' when modality is absent from argv AND env", async () => {
		const { parseArgs } = await loadMod();
		const io = silenceIo();
		try {
			const outcome = parseArgs(["--task", "T"]);
			expect(outcome).toEqual({ kind: "err", exitCode: 2 });
			expect(io.stderr()).toBe("ERROR: --modality (or PROOF_MODALITY) required\n");
		} finally {
			io.restore();
		}
	});

	it("falls back to PROOF_MODALITY / PROOF_SCRIPT env when the flags are omitted", async () => {
		process.env["PROOF_MODALITY"] = "backend";
		process.env["PROOF_SCRIPT"] = "/opt/x.sh";
		const { parseArgs } = await loadMod();
		const outcome = parseArgs(["--task", "T"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") {
			throw new Error("expected ok");
		}
		expect(outcome.args.modality).toBe("backend");
		expect(outcome.args.scriptPath).toBe("/opt/x.sh");
	});

	it("trailing --task with no value defaults task to '' and errors with 'task required'", async () => {
		const { parseArgs } = await loadMod();
		const io = silenceIo();
		try {
			// `argv[i + 1] ?? ""` right-hand side fires when the flag is
			// argv's final token. Task stays empty → the required-arg check
			// below rejects with exit 2.
			const outcome = parseArgs(["--modality", "iac", "--task"]);
			expect(outcome).toEqual({ kind: "err", exitCode: 2 });
			expect(io.stderr()).toContain("ERROR: --task required");
		} finally {
			io.restore();
		}
	});

	it("trailing --script with no value defaults script to '' but does not itself error", async () => {
		const { parseArgs } = await loadMod();
		const outcome = parseArgs(["--task", "T", "--modality", "iac", "--script"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") {
			throw new Error("expected ok");
		}
		expect(outcome.args.scriptPath).toBe("");
	});

	it("trailing --out with no value defaults outOverride to ''", async () => {
		const { parseArgs } = await loadMod();
		const outcome = parseArgs(["--task", "T", "--modality", "iac", "--out"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") {
			throw new Error("expected ok");
		}
		expect(outcome.args.outOverride).toBe("");
	});

	it("--modality on argv overrides PROOF_MODALITY env", async () => {
		process.env["PROOF_MODALITY"] = "backend";
		const { parseArgs } = await loadMod();
		const outcome = parseArgs(["--task", "T", "--modality", "ui"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind !== "ok") {
			throw new Error("expected ok");
		}
		expect(outcome.args.modality).toBe("ui");
	});
});

describe("proof-recorder — slugify", () => {
	it("lowercases and dashes non-alnum runs, collapsing repeats and trimming edges", async () => {
		const { slugify } = await loadMod();
		expect(slugify("HAND ITC-308")).toBe("hand-itc-308");
		expect(slugify("---weird--Case!!!---")).toBe("weird-case");
		expect(slugify("clickup:HAND_ITC-308")).toBe("clickup-hand-itc-308");
	});

	it("collapses two-character non-alnum runs to a single dash (no trailing-dash artefact)", async () => {
		const { slugify } = await loadMod();
		// Two spaces then two exclamation marks — the `-+` collapse pass has
		// to fire twice, mirroring `sed 's/--*/-/g'` in the bash source.
		expect(slugify("A  B!!C")).toBe("a-b-c");
	});

	it("handles a whole-non-alnum input by trimming to the empty string", async () => {
		const { slugify } = await loadMod();
		expect(slugify("!!!")).toBe("");
	});
});

// Every dispatch scenario runs inside a scratch cwd so `main()`'s
// `mkdirSync('discovery/proof/<slug>', {recursive:true})` doesn't touch
// the repo tree and the after-hook can `rm -rf` the whole scratch.
describe("proof-recorder — main() dispatch", () => {
	let scratchDir: string;
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};

	const ENV_KEYS = ["PROOF_MODALITY", "PROOF_SCRIPT", "TEST_CMD"] as const;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratchDir = mkdtempSync(join(tmpdir(), "proof-recorder-"));
		process.chdir(scratchDir);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		mockedSh.mockReset();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		try {
			rmSync(scratchDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	// Default sh() mock: sha256sum probe succeeds, sha256sum itself echoes
	// a fixed hex + path, every other subprocess exits 0 with empty output.
	// Individual tests override with mockImplementation for finer control.
	function installDefaultSh(): void {
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("sha256sum from util-linux\n");
			}
			if (command === "sha256sum") {
				// bash: `sha256sum <path>` → `<sha>  <path>`. Anchor to a
				// fixed hex so the sidecar bytes are predictable.
				return ok(
					`deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  ${String(args?.[0] ?? "")}\n`,
				);
			}
			return ok("", "", 0);
		});
	}

	it("prints USAGE and returns 0 on --help", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--help"]);
			expect(rc).toBe(0);
			expect(io.stdout()).toContain("proof-recorder.sh — one wrapper");
			expect(io.stdout()).toContain("bugfix-red-green");
		} finally {
			io.restore();
		}
	});

	it("returns the argparse error code (2) when --task is missing", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--modality", "iac"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: --task required");
		} finally {
			io.restore();
		}
	});

	it("rejects an unknown modality with a two-line stderr and exit 2", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "nosuch"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: unknown modality: nosuch");
			expect(io.stderr()).toContain("one of: ui backend terminal iac bugfix-red-green");
		} finally {
			io.restore();
		}
	});

	// ─── ui ───────────────────────────────────────────────────────────

	it("ui: refuses when --script is missing (requireScript, exit 2)", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "ui"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: --script (or PROOF_SCRIPT) required for modality 'ui'");
		} finally {
			io.restore();
		}
	});

	it("ui: refuses when the --script file does not exist (requireScript, exit 2)", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main([
				"--task",
				"T",
				"--modality",
				"ui",
				"--script",
				"does-not-exist.spec.ts",
			]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: script not found: does-not-exist.spec.ts");
		} finally {
			io.restore();
		}
	});

	it("ui: happy path writes the combined log, sidecars every png/mp4/webm artefact, and returns 0", async () => {
		const scriptFile = join(scratchDir, "e2e.spec.ts");
		writeFileSync(scriptFile, "// stub\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(
					`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ${String(args?.[0] ?? "")}\n`,
				);
			}
			if (command === "npx") {
				// Playwright prints on stdout AND stderr; combined-output
				// concatenation is the observable oracle.
				return ok("[playwright] running\n", "[playwright] warn\n", 0);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "HAND-1", "--modality", "ui", "--script", scriptFile]);
			expect(rc).toBe(0);
			// The combined-log path: destDir + `/ui-<ts>.log`, with the ts
			// baked in — glob its parent for the single expected log.
			const destDir = join(scratchDir, "discovery", "proof", "hand-1");
			expect(existsSync(destDir)).toBe(true);
			// Sidecar for the run log — content is exactly "<sha>  <basename>\n".
			// Find the log; there's exactly one on a fresh run.
			const { readdirSync } = await import("node:fs");
			const files = readdirSync(destDir).toSorted();
			const log = files.find((f) => f.startsWith("ui-") && f.endsWith(".log"));
			expect(log).toBeTruthy();
			expect(log).toBeDefined();
			const logAbs = join(destDir, log as string);
			expect(readFileSync(logAbs, "utf8")).toBe("[playwright] running\n[playwright] warn\n");
			expect(existsSync(`${logAbs}.sha256`)).toBe(true);
			expect(readFileSync(`${logAbs}.sha256`, "utf8")).toBe(
				`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ${log as string}\n`,
			);
			// The artifact dir was created and passed as PLAYWRIGHT_OUTPUT_DIR
			// on the sh() call for npx.
			const npxCall = mockedSh.mock.calls.find((c) => String(c[0]) === "npx");
			expect(npxCall).toBeDefined();
			const opts = (npxCall?.[2] ?? {}) as {
				env?: { PLAYWRIGHT_OUTPUT_DIR?: string };
			};
			expect(opts.env?.PLAYWRIGHT_OUTPUT_DIR).toContain("ui-");
			expect(opts.env?.PLAYWRIGHT_OUTPUT_DIR).toContain("-artifacts");
		} finally {
			io.restore();
		}
	});

	it("ui: sidecars every matching artefact under $ARTIFACT_DIR and skips non-matches", async () => {
		const scriptFile = join(scratchDir, "e2e.spec.ts");
		writeFileSync(scriptFile, "// stub\n");
		const { main } = await loadMod();
		// Intercept the npx call: seed the artifact dir with a mixture of
		// matching + non-matching files so the extension filter has a job.
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(
					`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ${String(args?.[0] ?? "")}\n`,
				);
			}
			if (command === "npx") {
				// Playwright is mocked; simulate its output-dir artefacts.
				const artifactDir = (
					(args as readonly string[] | undefined)?.[2] ? undefined : undefined
				) as string | undefined;
				void artifactDir;
				// Find the artifactDir from the process env passed via options.
				return ok();
			}
			return ok();
		});
		// We can't peek options mid-mock cleanly; re-implement to record env.
		const capturedEnv: Record<string, string | undefined> = {};
		mockedSh.mockImplementation(async (command, args, options) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(
					`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ${String(args?.[0] ?? "")}\n`,
				);
			}
			if (command === "npx") {
				capturedEnv.PLAYWRIGHT_OUTPUT_DIR = (
					options?.env as { PLAYWRIGHT_OUTPUT_DIR?: string } | undefined
				)?.PLAYWRIGHT_OUTPUT_DIR;
				const dir = capturedEnv.PLAYWRIGHT_OUTPUT_DIR;
				if (dir !== undefined) {
					// Seed a matching png, mp4, webm and a non-matching txt +
					// a nested subdir with another matching png (recursive walk).
					writeFileSync(join(dir, "screenshot.png"), "PNG-BYTES");
					writeFileSync(join(dir, "video.mp4"), "MP4-BYTES");
					writeFileSync(join(dir, "trace.webm"), "WEBM-BYTES");
					writeFileSync(join(dir, "readme.txt"), "SKIP");
					mkdirSync(join(dir, "nested"), { recursive: true });
					writeFileSync(join(dir, "nested", "extra.png"), "NESTED-PNG");
				}
				return ok("", "", 0);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "HAND-2", "--modality", "ui", "--script", scriptFile]);
			expect(rc).toBe(0);
			// Sidecar count: one per each of {run-log, screenshot.png, video.mp4,
			// trace.webm, nested/extra.png} = 5. readme.txt is filtered out.
			const dir = capturedEnv.PLAYWRIGHT_OUTPUT_DIR;
			expect(dir).toBeTruthy();
			if (dir === undefined) {
				throw new Error("PLAYWRIGHT_OUTPUT_DIR was not captured");
			}
			expect(existsSync(join(dir, "screenshot.png.sha256"))).toBe(true);
			expect(existsSync(join(dir, "video.mp4.sha256"))).toBe(true);
			expect(existsSync(join(dir, "trace.webm.sha256"))).toBe(true);
			expect(existsSync(join(dir, "readme.txt.sha256"))).toBe(false);
			expect(existsSync(join(dir, "nested", "extra.png.sha256"))).toBe(true);
		} finally {
			io.restore();
		}
	});

	it("ui: a directory entry whose name matches the extension regex is skipped by the isFile guard", async () => {
		const scriptFile = join(scratchDir, "e2e.spec.ts");
		writeFileSync(scriptFile, "// stub\n");
		const { main } = await loadMod();
		const capturedEnv: Record<string, string | undefined> = {};
		mockedSh.mockImplementation(async (command, args, options) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`33  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "npx") {
				capturedEnv.PLAYWRIGHT_OUTPUT_DIR = (
					options?.env as { PLAYWRIGHT_OUTPUT_DIR?: string } | undefined
				)?.PLAYWRIGHT_OUTPUT_DIR;
				const dir = capturedEnv.PLAYWRIGHT_OUTPUT_DIR;
				if (dir !== undefined) {
					// A directory whose NAME ends in .png — the extension regex
					// matches, but isFile() returns false so the loop skips it.
					// This is the observable branch for the "recursive walk turned
					// up a matching-name-but-not-a-file entry" edge case.
					mkdirSync(join(dir, "tricky.png"), { recursive: true });
					// A regular matching file so at least one sidecar still runs.
					writeFileSync(join(dir, "real.png"), "PNG");
				}
				return ok();
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "ui", "--script", scriptFile]);
			expect(rc).toBe(0);
			const dir = capturedEnv.PLAYWRIGHT_OUTPUT_DIR;
			expect(dir).toBeTruthy();
			if (dir === undefined) {
				throw new Error("PLAYWRIGHT_OUTPUT_DIR not captured");
			}
			// real.png gets a sidecar; the tricky.png directory does NOT.
			expect(existsSync(join(dir, "real.png.sha256"))).toBe(true);
			expect(existsSync(join(dir, "tricky.png.sha256"))).toBe(false);
		} finally {
			io.restore();
		}
	});

	it("ui: playwright non-zero exit is logged to stderr but sidecar still runs", async () => {
		const scriptFile = join(scratchDir, "e2e.spec.ts");
		writeFileSync(scriptFile, "// stub\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`cc  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "npx") {
				return ok("stdout-before-fail\n", "some error\n", 1);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "ui", "--script", scriptFile]);
			expect(rc).toBe(0); // ui swallows non-zero (bash `|| { ... }`)
			expect(io.stderr()).toContain("playwright exited non-zero — log kept for review");
		} finally {
			io.restore();
		}
	});

	// ─── backend ──────────────────────────────────────────────────────

	it("backend: happy path writes the combined log, sidecars it, returns 0", async () => {
		const scriptFile = join(scratchDir, "curl.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\ncurl --version\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`dd  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "bash") {
				return ok("curl 8.5.0\n", "", 0);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "HAND-BE", "--modality", "backend", "--script", scriptFile]);
			expect(rc).toBe(0);
			// sh("bash", [scriptFile], ...) exact-arg check.
			const bashCall = findShCall((cmd, a) => cmd === "bash" && a[0] === scriptFile);
			expect(bashCall).not.toBeNull();
			expect(io.stdout()).toContain("== done ==");
		} finally {
			io.restore();
		}
	});

	it("backend: non-zero script exit is logged to stderr but the exit code stays 0", async () => {
		const scriptFile = join(scratchDir, "curl.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\nfalse\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`ee  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "bash") {
				return ok("", "boom\n", 1);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "backend", "--script", scriptFile]);
			expect(rc).toBe(0);
			expect(io.stderr()).toContain("backend script exited non-zero — log kept for review");
		} finally {
			io.restore();
		}
	});

	it("backend: refuses when the --script file does not exist (requireScript)", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "backend", "--script", "/nowhere/here"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: script not found: /nowhere/here");
		} finally {
			io.restore();
		}
	});

	it("backend: --out override redirects the log to the explicit path", async () => {
		const scriptFile = join(scratchDir, "curl.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\ncurl\n");
		const outPath = join(scratchDir, "custom.log");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`ff  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "bash") {
				return ok("captured\n");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main([
				"--task",
				"T",
				"--modality",
				"backend",
				"--script",
				scriptFile,
				"--out",
				outPath,
			]);
			expect(rc).toBe(0);
			expect(readFileSync(outPath, "utf8")).toBe("captured\n");
			expect(existsSync(`${outPath}.sha256`)).toBe(true);
		} finally {
			io.restore();
		}
	});

	// ─── terminal ─────────────────────────────────────────────────────

	it("terminal: refuses when --script does not exist (requireScript, exit 2)", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main([
				"--task",
				"T",
				"--modality",
				"terminal",
				"--script",
				"/does/not/exist.sh",
			]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: script not found: /does/not/exist.sh");
		} finally {
			io.restore();
		}
	});

	it("terminal: util-linux branch invokes `script -q -c 'bash <path>' <out>` when `script --version` succeeds", async () => {
		const scriptFile = join(scratchDir, "session.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\ntop\n");
		const { main } = await loadMod();
		let sawUtilLinuxInvocation = false;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`11  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "script" && args?.[0] === "--version") {
				return ok("util-linux 2.39\n", "", 0);
			}
			if (command === "script" && args?.[0] === "-q" && args?.[1] === "-c") {
				sawUtilLinuxInvocation = true;
				expect(args?.[2]).toBe(`bash ${scriptFile}`);
				return ok();
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "terminal", "--script", scriptFile]);
			expect(rc).toBe(0);
			expect(sawUtilLinuxInvocation).toBe(true);
		} finally {
			io.restore();
		}
	});

	it("terminal: BSD/macOS branch (script probe fails) invokes `script -q <out> bash <path>`", async () => {
		const scriptFile = join(scratchDir, "session.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\ntop\n");
		const { main } = await loadMod();
		let sawBsdInvocation = false;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`22  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "script" && args?.[0] === "--version") {
				// BSD script(1) doesn't know --version; exit non-zero.
				return ok("", "unknown option --version\n", 1);
			}
			if (command === "script" && args?.[0] === "-q" && args?.[2] === "bash") {
				sawBsdInvocation = true;
				expect(args?.[3]).toBe(scriptFile);
				return ok();
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "terminal", "--script", scriptFile]);
			expect(rc).toBe(0);
			expect(sawBsdInvocation).toBe(true);
		} finally {
			io.restore();
		}
	});

	it("terminal: an sh() rejection on the probe also falls through to the BSD branch", async () => {
		const scriptFile = join(scratchDir, "session.sh");
		writeFileSync(scriptFile, "#!/usr/bin/env bash\ntop\n");
		const { main } = await loadMod();
		let sawBsdInvocation = false;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`33  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "script" && args?.[0] === "--version") {
				// Spawn failure — sh() rewraps ENOENT as a rejection.
				throw new Error("ENOENT: script not on PATH");
			}
			if (command === "script" && args?.[0] === "-q") {
				sawBsdInvocation = true;
				return ok();
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "terminal", "--script", scriptFile]);
			expect(rc).toBe(0);
			expect(sawBsdInvocation).toBe(true);
		} finally {
			io.restore();
		}
	});

	// ─── iac ──────────────────────────────────────────────────────────

	it("iac: hasTerraformFiles readdir failure falls through to the 'skipped' path (defensive catch)", async () => {
		// Pre-create the discovery/proof tree so main()'s mkdirSync doesn't
		// need write permission on cwd, then strip read permission from the
		// scratch dir. `readdirSync('.')` now fails with EACCES; the catch
		// block returns false and the source records the 'skipped' path.
		// Traversal (execute) permission stays on so `writeFileSync` inside
		// the pre-created subtree still works.
		const { chmodSync } = await import("node:fs");
		mkdirSync(join(scratchDir, "discovery", "proof", "t"), {
			recursive: true,
		});
		chmodSync(scratchDir, 0o111);
		try {
			const { main } = await loadMod();
			installDefaultSh();
			const io = silenceIo();
			try {
				const rc = await main(["--task", "T", "--modality", "iac"]);
				expect(rc).toBe(0);
				const destDir = join(scratchDir, "discovery", "proof", "t");
				// Restore read permission on scratchDir before we enumerate
				// the results — the test's own readdir needs it too.
				chmodSync(scratchDir, 0o755);
				const { readdirSync } = await import("node:fs");
				const files = readdirSync(destDir);
				const log = files.find((f) => f.startsWith("iac-") && f.endsWith(".log"));
				expect(log).toBeDefined();
				const body = readFileSync(join(destDir, log as string), "utf8");
				// The catch returned false → the 'skipped' branch runs, not
				// the "(terraform plan exited non-zero)" fallback.
				expect(body).toContain("-- terraform plan -- (no .tf files at cwd; skipped)");
			} finally {
				io.restore();
			}
		} finally {
			// Best-effort restore in case the assertion path failed early.
			try {
				chmodSync(scratchDir, 0o755);
			} catch {
				// scratch already restored
			}
		}
	});

	it("iac: no .tf files and no compose file emits both 'skipped' notes", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "iac"]);
			expect(rc).toBe(0);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const files = readdirSync(destDir);
			const log = files.find((f) => f.startsWith("iac-") && f.endsWith(".log"));
			expect(log).toBeDefined();
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("== iac snapshot @");
			expect(body).toContain("-- terraform plan -- (no .tf files at cwd; skipped)");
			expect(body).toContain("-- docker compose config -- (no compose file at cwd; skipped)");
			// terraform/docker never spawned when files are absent.
			expect(mockedSh.mock.calls.find((c) => String(c[0]) === "terraform")).toBeUndefined();
			expect(mockedSh.mock.calls.find((c) => String(c[0]) === "docker")).toBeUndefined();
		} finally {
			io.restore();
		}
	});

	it("iac: `terraform.tf` in cwd triggers `terraform plan -no-color` and captures its combined output", async () => {
		writeFileSync(join(scratchDir, "terraform.tf"), "resource {}\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`44  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "terraform") {
				expect(args).toEqual(["plan", "-no-color"]);
				return ok("Plan: 0 to add\n", "", 0);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "iac"]);
			expect(rc).toBe(0);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("-- terraform plan --");
			expect(body).toContain("Plan: 0 to add");
			expect(body).not.toContain("(no .tf files at cwd; skipped)");
		} finally {
			io.restore();
		}
	});

	it("iac: an arbitrary `.tf` glob match (not `terraform.tf`) also triggers terraform", async () => {
		writeFileSync(join(scratchDir, "main.tf"), "resource {}\n");
		const { main } = await loadMod();
		let ranTerraform = false;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`55  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "terraform") {
				ranTerraform = true;
				return ok("plan ok\n");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			expect(ranTerraform).toBe(true);
		} finally {
			io.restore();
		}
	});

	it("iac: terraform non-zero exit appends '(terraform plan exited non-zero)'", async () => {
		writeFileSync(join(scratchDir, "terraform.tf"), "resource {}\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`66  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "terraform") {
				return ok("", "boom\n", 3);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("(terraform plan exited non-zero)");
		} finally {
			io.restore();
		}
	});

	it("iac: terraform sh() rejection (ENOENT — binary not installed) is caught and appended as non-zero", async () => {
		writeFileSync(join(scratchDir, "terraform.tf"), "resource {}\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`77  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "terraform") {
				throw new Error("ENOENT: terraform not on PATH");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("(terraform plan exited non-zero)");
		} finally {
			io.restore();
		}
	});

	it("iac: docker-compose.yml present runs `docker compose config` and captures its output", async () => {
		writeFileSync(join(scratchDir, "docker-compose.yml"), "services: {}\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`88  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "docker") {
				expect(args).toEqual(["compose", "config"]);
				return ok("services: {}\n");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("-- docker compose config --");
			expect(body).toContain("services: {}");
		} finally {
			io.restore();
		}
	});

	it("iac: docker compose non-zero exit appends '(docker compose config exited non-zero)'", async () => {
		writeFileSync(join(scratchDir, "docker-compose.yaml"), "x\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`99  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "docker") {
				return ok("", "invalid\n", 1);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("(docker compose config exited non-zero)");
		} finally {
			io.restore();
		}
	});

	it("iac: docker sh() rejection is caught and appended as non-zero", async () => {
		writeFileSync(join(scratchDir, "compose.yml"), "x\n");
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`aa  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "docker") {
				throw new Error("ENOENT: docker not on PATH");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "iac"]);
			const destDir = join(scratchDir, "discovery", "proof", "t");
			const { readdirSync } = await import("node:fs");
			const [log] = readdirSync(destDir).filter((f) => f.startsWith("iac-") && f.endsWith(".log"));
			const body = readFileSync(join(destDir, log as string), "utf8");
			expect(body).toContain("(docker compose config exited non-zero)");
		} finally {
			io.restore();
		}
	});

	// ─── bugfix-red-green ─────────────────────────────────────────────

	it("bugfix-red-green: refuses with exit 2 when TEST_CMD is unset", async () => {
		const { main } = await loadMod();
		installDefaultSh();
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: TEST_CMD required for bugfix-red-green");
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: refuses with exit 2 when git is not installed", async () => {
		process.env["TEST_CMD"] = "pytest tests/";
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`bb  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "git" && args?.[0] === "--version") {
				throw new Error("ENOENT: git");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: git not found");
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: git --version exit != 0 also fails-closed with exit 2", async () => {
		process.env["TEST_CMD"] = "pytest tests/";
		const { main } = await loadMod();
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`cc  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "git" && args?.[0] === "--version") {
				return ok("", "", 127);
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(2);
			expect(io.stderr()).toContain("ERROR: git not found");
		} finally {
			io.restore();
		}
	});

	// The bugfix-red-green happy-path / exit-4 / exit-5 tests share a
	// dispatcher-style mock. `bashPlan` decides the exit code for the two
	// `bash -c TEST_CMD` invocations in order (red first, green second).
	function makeBugfixMock(
		bashPlan: [number, number],
		options?: {
			readonly abbrevRef?: string;
			readonly workingDirty?: boolean;
			readonly stagedDirty?: boolean;
		},
	): void {
		let bashCall = 0;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				return ok("v\n");
			}
			if (command === "sha256sum") {
				return ok(`dd  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "git" && args?.[0] === "--version") {
				return ok("git version 2.45.0\n");
			}
			if (command === "git" && args?.[0] === "rev-parse" && args?.[1] === "--abbrev-ref") {
				return ok(`${options?.abbrevRef ?? "feature/x"}\n`);
			}
			if (command === "git" && args?.[0] === "rev-parse") {
				// Fallback for detached HEAD: `git rev-parse HEAD` → raw SHA.
				return ok("0123456789abcdef\n");
			}
			if (command === "git" && args?.[0] === "diff") {
				const isCached = args?.[1] === "--cached";
				if (isCached) {
					return ok("", "", (options?.stagedDirty ?? false) ? 1 : 0);
				}
				return ok("", "", (options?.workingDirty ?? false) ? 1 : 0);
			}
			if (command === "git" && args?.[0] === "stash") {
				return ok();
			}
			if (command === "git" && args?.[0] === "checkout") {
				return ok();
			}
			if (command === "bash" && args?.[0] === "-c") {
				const [redRc, greenRc] = bashPlan;
				bashCall += 1;
				const rc = bashCall === 1 ? redRc : greenRc;
				return ok(bashCall === 1 ? "red-out\n" : "green-out\n", "", rc);
			}
			return ok();
		});
	}

	it("bugfix-red-green: happy path writes red/green logs, sidecars both, returns 0", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 0]);
		const io = silenceIo();
		try {
			const rc = await main(["--task", "HAND-BF", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(0);
			const destDir = join(scratchDir, "discovery", "proof", "hand-bf");
			const { readdirSync } = await import("node:fs");
			const files = readdirSync(destDir).toSorted();
			const red = files.find((f) => f.endsWith("-red.log"));
			const green = files.find((f) => f.endsWith("-green.log"));
			expect(red).toBeDefined();
			expect(green).toBeDefined();
			expect(readFileSync(join(destDir, red as string), "utf8")).toBe("red-out\n");
			expect(readFileSync(join(destDir, green as string), "utf8")).toBe("green-out\n");
			expect(existsSync(join(destDir, `${red as string}.sha256`))).toBe(true);
			expect(existsSync(join(destDir, `${green as string}.sha256`))).toBe(true);
			// Stash must NOT run when both diffs are clean.
			expect(
				mockedSh.mock.calls.find((c) => String(c[0]) === "git" && String(c[1]?.[0]) === "stash"),
			).toBeUndefined();
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: HEAD~1 already green (red exit 0) returns 4 and warns to stderr", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([0, 0]);
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(4);
			expect(io.stderr()).toContain("WARN: HEAD~1 was green — no regression demonstrated");
			// No `== done ==` footer — the source returns before writing it.
			expect(io.stdout()).not.toContain("== done ==");
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: HEAD not green (green exit != 0) returns 5 and warns to stderr", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 1]);
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(5);
			expect(io.stderr()).toContain("WARN: HEAD was not green — fix does not pass its own test");
			expect(io.stdout()).not.toContain("== done ==");
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: dirty working tree triggers `git stash push -u -m ...` and later `git stash pop`", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 0], { workingDirty: true });
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "bugfix-red-green"]);
			const stashPush = mockedSh.mock.calls.find(
				(c) =>
					String(c[0]) === "git" && String(c[1]?.[0]) === "stash" && String(c[1]?.[1]) === "push",
			);
			expect(stashPush).toBeDefined();
			const stashPushArgs = stashPush?.[1] as readonly string[] | undefined;
			expect(stashPushArgs?.slice(0, 4)).toEqual(["stash", "push", "-u", "-m"]);
			// The 5th arg is the message; must start with `proof-recorder-`.
			expect(String(stashPushArgs?.[4] ?? "")).toMatch(/^proof-recorder-\d{8}T\d{6}Z$/u);
			const stashPop = mockedSh.mock.calls.find(
				(c) =>
					String(c[0]) === "git" && String(c[1]?.[0]) === "stash" && String(c[1]?.[1]) === "pop",
			);
			expect(stashPop).toBeDefined();
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: BOTH working AND staged dirty still stashes exactly once", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 0], { workingDirty: true, stagedDirty: true });
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "bugfix-red-green"]);
			const stashPushCalls = mockedSh.mock.calls.filter(
				(c) =>
					String(c[0]) === "git" && String(c[1]?.[0]) === "stash" && String(c[1]?.[1]) === "push",
			);
			// `||` in the source short-circuits: dirty-or-dirty triggers a
			// single stash regardless of both flags being set.
			expect(stashPushCalls).toHaveLength(1);
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: staged-dirty-only tree still triggers the stash branch", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 0], { stagedDirty: true });
		const io = silenceIo();
		try {
			await main(["--task", "T", "--modality", "bugfix-red-green"]);
			const stashPush = mockedSh.mock.calls.find(
				(c) =>
					String(c[0]) === "git" && String(c[1]?.[0]) === "stash" && String(c[1]?.[1]) === "push",
			);
			expect(stashPush).toBeDefined();
		} finally {
			io.restore();
		}
	});

	it("bugfix-red-green: detached HEAD (abbrev-ref='HEAD') falls back to the raw SHA for checkout", async () => {
		process.env["TEST_CMD"] = "pytest";
		const { main } = await loadMod();
		makeBugfixMock([1, 0], { abbrevRef: "HEAD" });
		const io = silenceIo();
		try {
			const rc = await main(["--task", "T", "--modality", "bugfix-red-green"]);
			expect(rc).toBe(0);
			// The `git rev-parse HEAD` fallback must have been called.
			const rawSha = mockedSh.mock.calls.find(
				(c) =>
					String(c[0]) === "git" &&
					String(c[1]?.[0]) === "rev-parse" &&
					String(c[1]?.[1]) === "HEAD",
			);
			expect(rawSha).toBeDefined();
			// checkout back to startRef uses the raw sha, not the string "HEAD".
			const checkoutBack = mockedSh.mock.calls.filter(
				(c) => String(c[0]) === "git" && String(c[1]?.[0]) === "checkout",
			);
			// At least one checkout to the raw SHA.
			expect(
				checkoutBack.some((c) => (c[1] as readonly string[]).includes("0123456789abcdef")),
			).toBe(true);
		} finally {
			io.restore();
		}
	});

	// ─── platform: sha256 command detection ───────────────────────────

	it("sha256 fallback: `sha256sum --version` failing selects `shasum -a 256` for every subsequent hash", async () => {
		writeFileSync(join(scratchDir, "curl.sh"), "#!/usr/bin/env bash\n:\n");
		const { main } = await loadMod();
		let shasumCalled = 0;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				// Simulate ENOENT: sh() rewraps as a promise rejection when the
				// binary is absent from PATH.
				throw new Error("ENOENT: sha256sum");
			}
			if (command === "shasum") {
				shasumCalled += 1;
				// Expect the `-a 256` leading args on every sidecar hash.
				expect(args?.[0]).toBe("-a");
				expect(args?.[1]).toBe("256");
				return ok(`fedcba98  ${String(args?.[2] ?? "")}\n`);
			}
			if (command === "bash") {
				return ok("ok\n");
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main([
				"--task",
				"T",
				"--modality",
				"backend",
				"--script",
				join(scratchDir, "curl.sh"),
			]);
			expect(rc).toBe(0);
			expect(shasumCalled).toBe(1);
			// The single writeSidecar call for backend hits shasum exactly once.
		} finally {
			io.restore();
		}
	});

	it("sha256 cache: two hashes in the same run share ONE `sha256sum --version` probe", async () => {
		writeFileSync(join(scratchDir, "e2e.spec.ts"), "// stub\n");
		const { main } = await loadMod();
		let probeCount = 0;
		let hashCalls = 0;
		mockedSh.mockImplementation(async (command, args) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				probeCount += 1;
				return ok("v\n");
			}
			if (command === "sha256sum") {
				hashCalls += 1;
				return ok(`00  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "npx") {
				// Drop a single matching png so the ui walk sidecars two files.
				const dir = (
					(args as readonly string[] | undefined) === undefined ? undefined : undefined
				) as string | undefined;
				void dir;
				return ok();
			}
			return ok();
		});
		// Re-implement with env-capture so we can drop artefacts.
		mockedSh.mockImplementation(async (command, args, options) => {
			if (command === "sha256sum" && args?.[0] === "--version") {
				probeCount += 1;
				return ok("v\n");
			}
			if (command === "sha256sum") {
				hashCalls += 1;
				return ok(`00  ${String(args?.[0] ?? "")}\n`);
			}
			if (command === "npx") {
				const dir = (options?.env as { PLAYWRIGHT_OUTPUT_DIR?: string } | undefined)
					?.PLAYWRIGHT_OUTPUT_DIR;
				if (dir !== undefined) {
					writeFileSync(join(dir, "shot.png"), "PNG");
				}
				return ok();
			}
			return ok();
		});
		const io = silenceIo();
		try {
			const rc = await main([
				"--task",
				"T",
				"--modality",
				"ui",
				"--script",
				join(scratchDir, "e2e.spec.ts"),
			]);
			expect(rc).toBe(0);
			// Cache invariant: exactly ONE probe regardless of hash count.
			expect(probeCount).toBe(1);
			// Two hashes: run log + shot.png sidecar.
			expect(hashCalls).toBe(2);
		} finally {
			io.restore();
		}
	});
});
