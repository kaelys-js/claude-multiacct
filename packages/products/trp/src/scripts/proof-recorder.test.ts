// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Behavior tests for `proof-recorder.ts` — the TS port of
// `trp/scripts/proof-recorder.sh`.
//
// The module exports three things worth verifying:
//   * `slugify` — pure string transform; the observable is the returned
//     string, so we exercise every regex branch with concrete inputs.
//   * `parseArgs` — the argparse contract, including the PROOF_MODALITY /
//     PROOF_SCRIPT env fallbacks and the exact exit-code / stderr shape
//     the bash source promises operators.
//   * `main` — dispatches to every modality (ui / backend / terminal / iac
//     / bugfix-red-green), plus the shared prerequisites (--task, dest dir,
//     require_script). Every subprocess is proxied through `@foundation/shell`
//     so mocking `sh` gives us complete control over the modality outcomes
//     without ever launching playwright, terraform, docker, git, or script(1).
//
// WHY it matters: the disclosure protocol (SP1: evidence by provenance,
// not by copy) depends on this wrapper writing a log + sha256 sidecar for
// every capture. A silent regression in one of the branches would leave a
// finding without reproducible evidence — the whole point of the file.
// Tests pin every exit code, every "log kept for review" stderr line, every
// sidecar path, and the bugfix-red-green inverted-shape guard (exit 4 / 5).
//
// Lint disables — mock implementations are structured as narrow closures
// branching on command args; each closure is lexically nested under an
// `it()` callback which trips vitest/no-conditional-in-test on the parity
// pattern. `require-await` fires on async mock impls the port needs for
// type parity with `sh()`.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, vitest/require-mock-type-parameters, eslint/require-await, eslint/first, typescript/no-dynamic-delete, typescript/explicit-function-return-type */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";

// Hoisted mock — replaces `@foundation/shell` before the module under test
// evaluates. Every test that exercises a modality drives `mockedSh` down a
// specific branch. A real subprocess would couple these tests to the host's
// playwright / terraform / docker / git / script(1) install and defeat the
// point of the port.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn(),
}));

const mockedSh = vi.mocked(sh);

// Compact ShResult-shaped literal for mocks; the real ShResult carries more
// fields but the module only reads exitCode/stdout/stderr.
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
	} as unknown as Awaited<ReturnType<typeof sh>>;
}

// Import AFTER the mock is registered; the module-level sha256 probe cache
// is populated on first call and cannot be reset from outside without
// re-importing, so tests that need the fallback branch use vi.resetModules().
import { main, parseArgs, slugify } from "./proof-recorder.ts";

// ─── shared helpers ────────────────────────────────────────────────

// Default `sh` dispatcher — covers every subprocess the module might call
// with a "success + benign output" response. Individual tests override with
// mockImplementationOnce / mockImplementation to steer specific branches.
function defaultShImpl(): Parameters<typeof mockedSh.mockImplementation>[0] {
	return async (cmd: string, args: readonly string[] = []) => {
		if (cmd === "sha256sum" && args[0] === "--version") {
			return shResult(0);
		}
		if (cmd === "sha256sum") {
			return shResult(0, `deadbeef  ${args[0] ?? ""}\n`);
		}
		if (cmd === "shasum") {
			return shResult(0, `cafebabe  ${args[2] ?? ""}\n`);
		}
		if (cmd === "script" && args[0] === "--version") {
			return shResult(0);
		}
		if (cmd === "script") {
			return shResult(0);
		}
		if (cmd === "git") {
			return shResult(0);
		}
		return shResult(0);
	};
}

function captureStd(): {
	stdout: () => string;
	stderr: () => string;
	restore: () => void;
} {
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		restore: () => {
			stdoutSpy.mockRestore();
			stderrSpy.mockRestore();
		},
	};
}

// ─── slugify ───────────────────────────────────────────────────────

describe("slugify", () => {
	it("lowercases ASCII", () => {
		expect(slugify("Hello")).toBe("hello");
	});

	it("replaces non-alnum runs with a single dash", () => {
		expect(slugify("SEC 02: TokenLeak!!!")).toBe("sec-02-tokenleak");
	});

	it("trims leading and trailing dashes", () => {
		expect(slugify("---abc---")).toBe("abc");
	});

	it("collapses inner dash runs to a single dash", () => {
		expect(slugify("a---b____c")).toBe("a-b-c");
	});

	it("returns empty string for input that is entirely non-alnum", () => {
		// The bash source's tr → sed → sed pipeline reduces `!!!` to `-` and
		// then trims the edges, yielding `""`. Confirming this is what the
		// caller sees means downstream code that names paths from the slug
		// still has a knowable failure mode (empty dest-dir segment).
		expect(slugify("!!!")).toBe("");
	});

	it("handles the empty string", () => {
		expect(slugify("")).toBe("");
	});

	it("normalises non-ASCII the way `tr -c 'a-z0-9' '-'` would", () => {
		// Every non-[a-z0-9] codepoint becomes a dash; consecutive dashes
		// collapse. `café` → `caf-` after the tr, then trimmed to `caf`.
		expect(slugify("café")).toBe("caf");
	});

	it("keeps digits", () => {
		expect(slugify("v1.2.3")).toBe("v1-2-3");
	});
});

// ─── parseArgs ─────────────────────────────────────────────────────

describe("parseArgs", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = ["PROOF_MODALITY", "PROOF_SCRIPT"] as const;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		stderrSpy.mockRestore();
	});

	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	it("returns kind:ok with every flag captured", () => {
		const outcome = parseArgs([
			"--task",
			"SEC-02",
			"--modality",
			"backend",
			"--script",
			"scripts/attack.sh",
			"--out",
			"/tmp/out.log",
		]);
		expect(outcome).toEqual({
			kind: "ok",
			args: {
				task: "SEC-02",
				modality: "backend",
				scriptPath: "scripts/attack.sh",
				outOverride: "/tmp/out.log",
			},
		});
	});

	it("falls back to PROOF_MODALITY when --modality is omitted", () => {
		process.env.PROOF_MODALITY = "ui";
		const outcome = parseArgs(["--task", "T", "--script", "s.spec.ts"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect(outcome.args.modality).toBe("ui");
			expect(outcome.args.scriptPath).toBe("s.spec.ts");
		}
	});

	it("falls back to PROOF_SCRIPT when --script is omitted", () => {
		process.env.PROOF_SCRIPT = "env/set.sh";
		const outcome = parseArgs(["--task", "T", "--modality", "backend"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect(outcome.args.scriptPath).toBe("env/set.sh");
		}
	});

	it("explicit --script overrides PROOF_SCRIPT", () => {
		process.env.PROOF_SCRIPT = "from-env.sh";
		const outcome = parseArgs(["--task", "T", "--modality", "backend", "--script", "from-cli.sh"]);
		expect(outcome.kind).toBe("ok");
		if (outcome.kind === "ok") {
			expect(outcome.args.scriptPath).toBe("from-cli.sh");
		}
	});

	it("returns kind:help on --help", () => {
		expect(parseArgs(["--help"])).toEqual({ kind: "help" });
	});

	it("returns kind:help on -h", () => {
		expect(parseArgs(["-h"])).toEqual({ kind: "help" });
	});

	it("returns kind:err/2 on an unknown flag with an ERROR line on stderr", () => {
		const outcome = parseArgs(["--task", "T", "--modality", "ui", "--frobnicate"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(stderr()).toContain("ERROR: unknown flag: --frobnicate");
	});

	it("returns kind:err/2 when --task is missing", () => {
		const outcome = parseArgs(["--modality", "iac"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(stderr()).toContain("ERROR: --task required");
	});

	it("returns kind:err/2 when --modality is missing (and PROOF_MODALITY unset)", () => {
		const outcome = parseArgs(["--task", "T"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
		expect(stderr()).toContain("ERROR: --modality (or PROOF_MODALITY) required");
	});

	it("treats a trailing flag with no value as empty (no crash) — --task consumes ''", () => {
		// argv ends after `--task`; argv[i+1] is undefined and becomes "".
		// That drives the same missing-task branch as the no-flag case.
		const outcome = parseArgs(["--task"]);
		expect(outcome).toEqual({ kind: "err", exitCode: 2 });
	});
});

// ─── main() — dispatch, dest-dir, shared prereqs ────────────────────

describe("main() dispatch + shared prereqs", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = ["PROOF_MODALITY", "PROOF_SCRIPT", "TEST_CMD"] as const;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-"));
		process.chdir(scratch);
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		std = captureStd();
		mockedSh.mockReset();
		mockedSh.mockImplementation(defaultShImpl());
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	});

	// --- shared: parse + destdir --------------------------------------

	it("--help writes USAGE to stdout and returns 0", async () => {
		expect(await main(["--help"])).toBe(0);
		expect(std.stdout()).toContain("proof-recorder.sh");
		expect(std.stdout()).toContain("Modalities");
	});

	it("propagates parseArgs' err exitCode (unknown flag → 2)", async () => {
		expect(await main(["--task", "T", "--modality", "ui", "--wat"])).toBe(2);
		expect(std.stderr()).toContain("unknown flag");
	});

	it("returns 2 with an unknown-modality message on an unrecognised modality", async () => {
		expect(await main(["--task", "T", "--modality", "spelunk"])).toBe(2);
		expect(std.stderr()).toContain("ERROR: unknown modality: spelunk");
		expect(std.stderr()).toContain("one of: ui backend terminal iac bugfix-red-green");
	});

	it("creates discovery/proof/<task-slug>/ under cwd", async () => {
		// Feed a task with punctuation; the slug drives the dir name.
		expect(await main(["--task", "SEC 02: leak", "--modality", "iac"])).toBe(0);
		expect(existsSync(join(scratch, "discovery/proof/sec-02-leak"))).toBe(true);
	});

	it("prints the run header (task/modality/ts + dest) and the done footer on success", async () => {
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		const out = std.stdout();
		expect(out).toContain(">> proof-recorder task=T modality=iac ts=");
		expect(out).toContain("   dest=discovery/proof/t");
		expect(out).toContain("== done ==");
		expect(out).toContain("discovery/proof/t\n");
	});
});

// ─── modality: ui ──────────────────────────────────────────────────

describe("main() modality=ui", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-ui-"));
		process.chdir(scratch);
		std = captureStd();
		mockedSh.mockReset();
		mockedSh.mockImplementation(defaultShImpl());
		delete process.env.PROOF_SCRIPT;
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	it("returns 2 when --script is missing (require_script)", async () => {
		expect(await main(["--task", "T", "--modality", "ui"])).toBe(2);
		expect(std.stderr()).toContain("ERROR: --script (or PROOF_SCRIPT) required for modality 'ui'");
	});

	it("returns 2 when the --script path does not exist", async () => {
		expect(
			await main(["--task", "T", "--modality", "ui", "--script", "does-not-exist.spec.ts"]),
		).toBe(2);
		expect(std.stderr()).toContain("ERROR: script not found: does-not-exist.spec.ts");
	});

	it("runs playwright, writes the log, and produces a sha256 sidecar", async () => {
		const spec = join(scratch, "a.spec.ts");
		writeFileSync(spec, "test('x', () => {});\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "hashhash  file\n");
			}
			if (cmd === "npx") {
				return shResult(0, "PASS all specs\n", "");
			}
			return shResult(0);
		});

		expect(await main(["--task", "T", "--modality", "ui", "--script", spec])).toBe(0);
		const logs = readdirSync(join(scratch, "discovery/proof/t"));
		const log = logs.find((f) => f.startsWith("ui-") && f.endsWith(".log"));
		const sidecar = logs.find((f) => f.endsWith(".log.sha256"));
		expect(log).toBeDefined();
		expect(sidecar).toBeDefined();
		expect(readFileSync(join(scratch, "discovery/proof/t", log!), "utf8")).toContain(
			"PASS all specs",
		);
		// Sidecar line format: `<sha>  <basename>\n`
		expect(readFileSync(join(scratch, "discovery/proof/t", sidecar!), "utf8")).toMatch(
			/^hashhash {2}ui-.*\.log\n$/u,
		);
	});

	it("logs 'playwright exited non-zero' but keeps going on a failing run", async () => {
		const spec = join(scratch, "b.spec.ts");
		writeFileSync(spec, "test('x', () => {});\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "npx") {
				return shResult(1, "FAIL 1 test failing\n", "assertion failed\n");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "ui", "--script", spec])).toBe(0);
		expect(std.stderr()).toContain("playwright exited non-zero — log kept for review");
	});

	it("sidecars artefacts (png/mp4/webm) under the ui-<ts>-artifacts dir", async () => {
		const spec = join(scratch, "c.spec.ts");
		writeFileSync(spec, "test\n");

		// The playwright run creates artefact files that the recursive scan
		// picks up. Simulate that by having the `npx` mock create files under
		// the PLAYWRIGHT_OUTPUT_DIR env var when it runs.
		mockedSh.mockImplementation(
			async (cmd: string, args: readonly string[] = [], opts?: unknown) => {
				if (cmd === "sha256sum" && args[0] === "--version") {
					return shResult(0);
				}
				if (cmd === "sha256sum") {
					return shResult(0, "h  f\n");
				}
				if (cmd === "npx") {
					const artifactDir = (opts as { env?: Record<string, string> } | undefined)?.env
						?.PLAYWRIGHT_OUTPUT_DIR;
					if (artifactDir !== undefined) {
						mkdirSync(join(artifactDir, "sub"), { recursive: true });
						writeFileSync(join(artifactDir, "screenshot.png"), "PNG");
						writeFileSync(join(artifactDir, "sub", "video.mp4"), "MP4");
						writeFileSync(join(artifactDir, "sub", "trace.webm"), "WEBM");
						writeFileSync(join(artifactDir, "note.txt"), "SKIP");
					}
					return shResult(0);
				}
				return shResult(0);
			},
		);

		expect(await main(["--task", "T", "--modality", "ui", "--script", spec])).toBe(0);
		const destDir = join(scratch, "discovery/proof/t");
		const artifactDir = readdirSync(destDir).find((f) => f.endsWith("-artifacts"))!;
		const artifactRoot = join(destDir, artifactDir);
		expect(existsSync(join(artifactRoot, "screenshot.png.sha256"))).toBe(true);
		expect(existsSync(join(artifactRoot, "sub/video.mp4.sha256"))).toBe(true);
		expect(existsSync(join(artifactRoot, "sub/trace.webm.sha256"))).toBe(true);
		// note.txt is not png/mp4/webm — must not be sidecar'd.
		expect(existsSync(join(artifactRoot, "note.txt.sha256"))).toBe(false);
	});

	it("skips a directory whose name ends in .png/.mp4/.webm (isFile guard)", async () => {
		const spec = join(scratch, "e.spec.ts");
		writeFileSync(spec, "test\n");
		mockedSh.mockImplementation(
			async (cmd: string, args: readonly string[] = [], opts?: unknown) => {
				if (cmd === "sha256sum" && args[0] === "--version") {
					return shResult(0);
				}
				if (cmd === "sha256sum") {
					return shResult(0, "h  f\n");
				}
				if (cmd === "npx") {
					const artifactDir = (opts as { env?: Record<string, string> } | undefined)?.env
						?.PLAYWRIGHT_OUTPUT_DIR;
					if (artifactDir !== undefined) {
						// Directory whose name matches the extension regex — the
						// `!isFile(full)` branch skips it rather than sidecaring.
						mkdirSync(join(artifactDir, "trace.webm"), { recursive: true });
					}
					return shResult(0);
				}
				return shResult(0);
			},
		);
		expect(await main(["--task", "T", "--modality", "ui", "--script", spec])).toBe(0);
		const destDir = join(scratch, "discovery/proof/t");
		const artifactDir = readdirSync(destDir).find((f) => f.endsWith("-artifacts"))!;
		expect(existsSync(join(destDir, artifactDir, "trace.webm.sha256"))).toBe(false);
	});

	it("respects --out to override the default log path", async () => {
		const spec = join(scratch, "d.spec.ts");
		writeFileSync(spec, "test\n");
		const overrideOut = join(scratch, "custom-out.log");
		expect(
			await main(["--task", "T", "--modality", "ui", "--script", spec, "--out", overrideOut]),
		).toBe(0);
		expect(existsSync(overrideOut)).toBe(true);
		expect(existsSync(`${overrideOut}.sha256`)).toBe(true);
	});
});

// ─── modality: backend ─────────────────────────────────────────────

describe("main() modality=backend", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-be-"));
		process.chdir(scratch);
		std = captureStd();
		mockedSh.mockReset();
		mockedSh.mockImplementation(defaultShImpl());
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	it("returns 2 when --script is missing for backend (require_script)", async () => {
		delete process.env.PROOF_SCRIPT;
		expect(await main(["--task", "T", "--modality", "backend"])).toBe(2);
		expect(std.stderr()).toContain(
			"ERROR: --script (or PROOF_SCRIPT) required for modality 'backend'",
		);
	});

	it("returns 2 when the --script path does not exist for backend", async () => {
		expect(await main(["--task", "T", "--modality", "backend", "--script", "nope-be.sh"])).toBe(2);
		expect(std.stderr()).toContain("ERROR: script not found: nope-be.sh");
	});

	it("writes combined stdout+stderr from the bash script and sidecars the log", async () => {
		const script = join(scratch, "curl.sh");
		writeFileSync(script, "#!/bin/bash\necho hello\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "abcabc  file\n");
			}
			if (cmd === "bash") {
				return shResult(0, "hello\n", "warning: nope\n");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "backend", "--script", script])).toBe(0);
		const destDir = join(scratch, "discovery/proof/t");
		const log = readdirSync(destDir).find((f) => f.startsWith("backend-") && f.endsWith(".log"))!;
		expect(readFileSync(join(destDir, log), "utf8")).toBe("hello\nwarning: nope\n");
		expect(existsSync(join(destDir, `${log}.sha256`))).toBe(true);
	});

	it("logs the 'backend script exited non-zero' warning but returns 0", async () => {
		const script = join(scratch, "fail.sh");
		writeFileSync(script, "exit 3\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "bash") {
				return shResult(3, "", "boom\n");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "backend", "--script", script])).toBe(0);
		expect(std.stderr()).toContain("backend script exited non-zero — log kept for review");
	});
});

// ─── modality: terminal ────────────────────────────────────────────

describe("main() modality=terminal", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-term-"));
		process.chdir(scratch);
		std = captureStd();
		mockedSh.mockReset();
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	it("returns 2 when --script is missing for terminal (require_script)", async () => {
		mockedSh.mockImplementation(defaultShImpl());
		delete process.env.PROOF_SCRIPT;
		expect(await main(["--task", "T", "--modality", "terminal"])).toBe(2);
		expect(std.stderr()).toContain(
			"ERROR: --script (or PROOF_SCRIPT) required for modality 'terminal'",
		);
	});

	it("returns 2 when the --script path does not exist for terminal", async () => {
		mockedSh.mockImplementation(defaultShImpl());
		expect(await main(["--task", "T", "--modality", "terminal", "--script", "nope-term.sh"])).toBe(
			2,
		);
		expect(std.stderr()).toContain("ERROR: script not found: nope-term.sh");
	});

	it("takes the util-linux branch when `script --version` exits 0", async () => {
		const script = join(scratch, "sess.sh");
		writeFileSync(script, "ls\n");
		let scriptArgs: readonly string[] | undefined;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "script" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "script") {
				scriptArgs = args;
				return shResult(0);
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "terminal", "--script", script])).toBe(0);
		// util-linux: `script -q -c "bash <script>" <out>`
		expect(scriptArgs?.[0]).toBe("-q");
		expect(scriptArgs?.[1]).toBe("-c");
		expect(scriptArgs?.[2]).toBe(`bash ${script}`);
		expect(scriptArgs?.[3]).toMatch(/terminal-.*\.log$/u);
	});

	it("falls back to the BSD branch when `script --version` exits non-zero", async () => {
		const script = join(scratch, "sess2.sh");
		writeFileSync(script, "ls\n");
		let scriptArgs: readonly string[] | undefined;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "script" && args[0] === "--version") {
				return shResult(1);
			}
			if (cmd === "script") {
				scriptArgs = args;
				return shResult(0);
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "terminal", "--script", script])).toBe(0);
		// BSD: `script -q <out> bash <script>`
		expect(scriptArgs?.[0]).toBe("-q");
		expect(scriptArgs?.[1]).toMatch(/terminal-.*\.log$/u);
		expect(scriptArgs?.[2]).toBe("bash");
		expect(scriptArgs?.[3]).toBe(script);
	});

	it("also takes the BSD branch when `script --version` throws (ENOENT)", async () => {
		const script = join(scratch, "sess3.sh");
		writeFileSync(script, "ls\n");
		let bsdSeen = false;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "script" && args[0] === "--version") {
				throw new Error("ENOENT: script not installed");
			}
			if (cmd === "script") {
				bsdSeen = true;
				return shResult(0);
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "terminal", "--script", script])).toBe(0);
		expect(bsdSeen).toBe(true);
	});
});

// ─── modality: iac ─────────────────────────────────────────────────

describe("main() modality=iac", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-iac-"));
		process.chdir(scratch);
		std = captureStd();
		mockedSh.mockReset();
		mockedSh.mockImplementation(defaultShImpl());
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	function readLog(taskSlug = "t"): string {
		const destDir = join(scratch, `discovery/proof/${taskSlug}`);
		const log = readdirSync(destDir).find((f) => f.startsWith("iac-") && f.endsWith(".log"))!;
		return readFileSync(join(destDir, log), "utf8");
	}

	it("skips both sections when no .tf files and no compose file exist at cwd", async () => {
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		const body = readLog();
		expect(body).toContain("== iac snapshot @ ");
		expect(body).toContain("-- terraform plan -- (no .tf files at cwd; skipped)");
		expect(body).toContain("-- docker compose config -- (no compose file at cwd; skipped)");
	});

	it("runs terraform plan when terraform.tf is present at cwd", async () => {
		writeFileSync(join(scratch, "terraform.tf"), 'resource "null" "x" {}\n');
		let tfSeen = false;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "terraform") {
				tfSeen = true;
				return shResult(0, "No changes.\n", "");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(tfSeen).toBe(true);
		expect(readLog()).toContain("No changes.");
	});

	it("finds *.tf via the glob branch when there is no terraform.tf but there is main.tf", async () => {
		writeFileSync(join(scratch, "main.tf"), 'resource "null" "x" {}\n');
		let tfSeen = false;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "terraform") {
				tfSeen = true;
				return shResult(0, "plan ok\n", "");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(tfSeen).toBe(true);
	});

	it("appends the '(terraform plan exited non-zero)' marker when terraform exits nonzero", async () => {
		writeFileSync(join(scratch, "terraform.tf"), "junk\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "terraform") {
				return shResult(1, "", "syntax error\n");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(readLog()).toContain("(terraform plan exited non-zero)");
	});

	it("emits the '(terraform plan exited non-zero)' marker when the terraform binary is missing", async () => {
		writeFileSync(join(scratch, "terraform.tf"), "\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "terraform") {
				throw new Error("ENOENT: terraform not installed");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(readLog()).toContain("(terraform plan exited non-zero)");
	});

	it("runs docker compose config when docker-compose.yml is present", async () => {
		writeFileSync(join(scratch, "docker-compose.yml"), "services: {}\n");
		let composeSeen = false;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "docker") {
				composeSeen = true;
				return shResult(0, "services: {}\n", "");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(composeSeen).toBe(true);
	});

	it("also detects docker-compose.yaml and compose.yml", async () => {
		writeFileSync(join(scratch, "compose.yml"), "services: {}\n");
		let composeSeen = false;
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "docker") {
				composeSeen = true;
				return shResult(0);
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(composeSeen).toBe(true);
	});

	it("appends '(docker compose config exited non-zero)' when compose exits nonzero", async () => {
		writeFileSync(join(scratch, "docker-compose.yaml"), "services: {}\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "docker") {
				return shResult(1, "", "invalid\n");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(readLog()).toContain("(docker compose config exited non-zero)");
	});

	it("emits the compose non-zero marker when the docker binary is missing", async () => {
		writeFileSync(join(scratch, "docker-compose.yml"), "services: {}\n");
		mockedSh.mockImplementation(async (cmd: string, args: readonly string[] = []) => {
			if (cmd === "sha256sum" && args[0] === "--version") {
				return shResult(0);
			}
			if (cmd === "sha256sum") {
				return shResult(0, "h  f\n");
			}
			if (cmd === "docker") {
				throw new Error("ENOENT: docker not installed");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(readLog()).toContain("(docker compose config exited non-zero)");
	});
});

// ─── modality: bugfix-red-green ────────────────────────────────────

describe("main() modality=bugfix-red-green", () => {
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;
	const savedTestCmd = process.env.TEST_CMD;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-brg-"));
		process.chdir(scratch);
		std = captureStd();
		mockedSh.mockReset();
		delete process.env.TEST_CMD;
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		if (savedTestCmd === undefined) {
			delete process.env.TEST_CMD;
		} else {
			process.env.TEST_CMD = savedTestCmd;
		}
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	it("returns 2 when TEST_CMD is unset", async () => {
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(2);
		expect(std.stderr()).toContain("ERROR: TEST_CMD required for bugfix-red-green");
	});

	it("returns 2 when git is not available", async () => {
		process.env.TEST_CMD = "make test";
		mockedSh.mockImplementation(async (cmd: string) => {
			if (cmd === "git") {
				throw new Error("ENOENT: git");
			}
			return shResult(0);
		});
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(2);
		expect(std.stderr()).toContain("ERROR: git not found");
	});

	it("returns 4 when HEAD~1 is already green (no regression demonstrated)", async () => {
		process.env.TEST_CMD = "true";
		mockedSh.mockImplementation(gitAndBashPlan({ headMinusOneRc: 0, headRc: 0 }));
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(4);
		expect(std.stderr()).toContain("WARN: HEAD~1 was green — no regression demonstrated");
	});

	it("returns 5 when HEAD does not pass its own test", async () => {
		process.env.TEST_CMD = "make test";
		mockedSh.mockImplementation(gitAndBashPlan({ headMinusOneRc: 1, headRc: 2 }));
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(5);
		expect(std.stderr()).toContain("WARN: HEAD was not green — fix does not pass its own test");
	});

	it("returns 0 when red→green as expected; writes both logs + sidecars", async () => {
		process.env.TEST_CMD = "make test";
		mockedSh.mockImplementation(
			gitAndBashPlan({
				headMinusOneRc: 1,
				headRc: 0,
				redStdout: "assertion failed",
				greenStdout: "PASS",
			}),
		);
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(0);
		const destDir = join(scratch, "discovery/proof/t");
		const files = readdirSync(destDir);
		expect(files.some((f) => f.endsWith("-red.log"))).toBe(true);
		expect(files.some((f) => f.endsWith("-green.log"))).toBe(true);
		expect(files.some((f) => f.endsWith("-red.log.sha256"))).toBe(true);
		expect(files.some((f) => f.endsWith("-green.log.sha256"))).toBe(true);
		const redLog = files.find((f) => f.endsWith("-red.log"))!;
		const greenLog = files.find((f) => f.endsWith("-green.log"))!;
		expect(readFileSync(join(destDir, redLog), "utf8")).toContain("assertion failed");
		expect(readFileSync(join(destDir, greenLog), "utf8")).toContain("PASS");
	});

	it("stashes uncommitted work when git diff reports dirty state", async () => {
		process.env.TEST_CMD = "make test";
		const gitCalls: Array<readonly string[]> = [];
		mockedSh.mockImplementation(
			gitAndBashPlan({
				headMinusOneRc: 1,
				headRc: 0,
				workingDirty: true,
				gitCalls,
			}),
		);
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(0);
		// Stashing invokes `git stash push`; restoration invokes `git stash pop`.
		const stashPush = gitCalls.find((a) => a[0] === "stash" && a[1] === "push");
		const stashPop = gitCalls.find((a) => a[0] === "stash" && a[1] === "pop");
		expect(stashPush).toBeDefined();
		expect(stashPop).toBeDefined();
	});

	it("stashes when only staged changes are present (workingClean, stagedDirty)", async () => {
		process.env.TEST_CMD = "make test";
		const gitCalls: Array<readonly string[]> = [];
		mockedSh.mockImplementation(
			gitAndBashPlan({
				headMinusOneRc: 1,
				headRc: 0,
				stagedDirty: true,
				gitCalls,
			}),
		);
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(0);
		expect(gitCalls.some((a) => a[0] === "stash" && a[1] === "push")).toBe(true);
	});

	it("does not stash when working tree and index are both clean", async () => {
		process.env.TEST_CMD = "make test";
		const gitCalls: Array<readonly string[]> = [];
		mockedSh.mockImplementation(
			gitAndBashPlan({
				headMinusOneRc: 1,
				headRc: 0,
				gitCalls,
			}),
		);
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(0);
		expect(gitCalls.some((a) => a[0] === "stash")).toBe(false);
	});

	it("falls back to the raw HEAD sha when HEAD is detached", async () => {
		process.env.TEST_CMD = "make test";
		const gitCalls: Array<readonly string[]> = [];
		mockedSh.mockImplementation(
			gitAndBashPlan({
				headMinusOneRc: 1,
				headRc: 0,
				abbrevRef: "HEAD",
				rawSha: "0123abcd",
				gitCalls,
			}),
		);
		expect(await main(["--task", "T", "--modality", "bugfix-red-green"])).toBe(0);
		// Post-run checkout returns to the raw sha, not the string "HEAD".
		const checkoutBack = gitCalls.findLast?.((a) => a[0] === "checkout" && a[2] === "0123abcd");
		expect(checkoutBack).toBeDefined();
	});
});

// ─── sha256 detection fallback (shasum branch) ─────────────────────

describe("sha256 detection falls back to shasum when sha256sum probe throws", () => {
	// The module caches the probe result at module scope on first call, so
	// vi.resetModules() + dynamic import gets a fresh cache to hit the catch
	// branch where `sh("sha256sum", ["--version"])` rejects.
	let scratch: string;
	let originalCwd: string;
	let std: ReturnType<typeof captureStd>;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "proof-recorder-shasum-"));
		process.chdir(scratch);
		std = captureStd();
	});

	afterEach(() => {
		std.restore();
		process.chdir(originalCwd);
		try {
			rmSync(scratch, { recursive: true, force: true });
		} catch {
			// noop
		}
	});

	it("uses `shasum -a 256` when the sha256sum probe rejects", async () => {
		vi.resetModules();
		let shasumCalled = false;
		let sha256sumCalled = false;
		vi.doMock("@foundation/shell", () => ({
			sh: vi.fn(async (cmd: string, args: readonly string[] = []) => {
				if (cmd === "sha256sum" && args[0] === "--version") {
					sha256sumCalled = true;
					throw new Error("ENOENT: sha256sum");
				}
				if (cmd === "shasum") {
					shasumCalled = true;
					return shResult(0, "shabadash  file\n");
				}
				if (cmd === "docker" || cmd === "terraform") {
					return shResult(0);
				}
				return shResult(0);
			}),
		}));
		const mod = (await import("./proof-recorder.ts")) as { main: typeof main };
		expect(await mod.main(["--task", "T", "--modality", "iac"])).toBe(0);
		expect(sha256sumCalled).toBe(true);
		expect(shasumCalled).toBe(true);
		vi.doUnmock("@foundation/shell");
	});
});

// gitAndBashPlan — a driver for the mocked-`sh` calls the bugfix-red-green
// modality issues. The impl calls `git --version`, `git rev-parse
// --abbrev-ref HEAD` (or `rev-parse HEAD` when detached), `git diff
// --quiet`, `git diff --cached --quiet`, optionally `git stash push`, then
// `git checkout HEAD~1`, `bash -c TEST_CMD`, `git checkout <ref>`, `bash -c
// TEST_CMD`, cleanup `git checkout <ref>`, optionally `git stash pop`, plus
// two `sha256sum` invocations for the sidecars.
type GitAndBashPlanOpts = {
	headMinusOneRc: number;
	headRc: number;
	redStdout?: string;
	greenStdout?: string;
	abbrevRef?: string;
	rawSha?: string;
	workingDirty?: boolean;
	stagedDirty?: boolean;
	gitCalls?: Array<readonly string[]>;
};

function gitAndBashPlan(opts: GitAndBashPlanOpts) {
	const {
		headMinusOneRc,
		headRc,
		redStdout = "",
		greenStdout = "",
		abbrevRef = "main",
		rawSha = "deadbeef",
		workingDirty = false,
		stagedDirty = false,
		gitCalls,
	} = opts;
	let bashCall = 0;
	return async (cmd: string, args: readonly string[] = []) => {
		if (cmd === "sha256sum" && args[0] === "--version") {
			return shResult(0);
		}
		if (cmd === "sha256sum") {
			return shResult(0, `h  ${args[0] ?? ""}\n`);
		}
		if (cmd === "shasum") {
			return shResult(0, `h  ${args[2] ?? ""}\n`);
		}
		if (cmd === "git") {
			gitCalls?.push(args);
			if (args[0] === "--version") {
				return shResult(0);
			}
			if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
				return shResult(0, `${abbrevRef}\n`);
			}
			if (args[0] === "rev-parse" && args[1] === "HEAD") {
				return shResult(0, `${rawSha}\n`);
			}
			if (args[0] === "diff" && args[1] === "--quiet" && args[2] !== "--cached") {
				return shResult(workingDirty ? 1 : 0);
			}
			if (args[0] === "diff" && args[1] === "--cached") {
				return shResult(stagedDirty ? 1 : 0);
			}
			return shResult(0);
		}
		if (cmd === "bash" && args[0] === "-c") {
			bashCall += 1;
			// First bash invocation is HEAD~1 (red), second is HEAD (green).
			if (bashCall === 1) {
				return shResult(headMinusOneRc, redStdout);
			}
			return shResult(headRc, greenStdout);
		}
		return shResult(0);
	};
}
