// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Behavior tests for `fix-task.ts` — the TRP driver / mirror of
// scripts/find-to-poc.sh. The module ships one public entrypoint, `main()`,
// wrapping a 12-stage pipeline (stage 0 bootstrap → stage 14 poll). These
// tests cover the branches a Claude session can hit deterministically without
// a real client checkout: argv parsing, env-file preflight, task-mode
// validation, and the support-mode stage-0 short-circuit.
//
// WHY these branches matter:
//   - `main()` is the sole entry point the wrapper (`trp-run-loop`), the
//     REVISE loop (`prep-revise-input` → workflow → re-invoke), and the
//     interactive operator share. Every early-exit branch is a contract:
//     exit code 2 means "pre-flight config error, stop the loop"; exit 0
//     out of support mode means "payload landed, tracker gets a comment,
//     no PR needed". A drift silently ships wrong bytes to a client.
//   - The support-mode short-circuit is the only full stage-0 walk-through
//     that never touches bin/mise, git, gh, or docker, so it's the cleanest
//     integration surface a unit test can drive. It also anchors the
//     TRP-J auto-repair loop's "did we mean to loop?" gate: support never
//     participates in the loop, and this test proves that even when the
//     wrapper passes --attempt=N (up to and past the loop cap) support
//     still returns 0 without invoking the failure emitter.
//
// The 12 auto-repair fixtures under
// `tests/fixtures/scripts/fix-task/<name>/` describe the (stage, attempt)
// matrix at the driver's pre-pipeline layer — the layer the wrapper and the
// REVISE loop actually address. Each fixture pins:
//     input.json    → { argv, env, files, task_mode }
//     expected.json → { exit_code, stdout_contains[], stderr_contains[],
//                       files_present[], files_absent[], payload_shape? }
// The parity `describe` block iterates them, spins a scratch cwd, writes
// the files, chdir's in, runs `main()` under captured stdio, and asserts
// the recorded contract. Payload byte content is spot-checked via the
// `payload_shape` key so the fixture stays readable without embedding a
// full JSON blob.
//
// Not covered here (out of scope for a driver-only unit test; each has its
// own dedicated harness):
//   - Stage 2+ (git clone / checkout) — real gh + git subprocesses
//   - Stage 4b/4c (bundle checks) — see bundle-cross-file-check.test.ts /
//     bundle-schema-check.test.ts
//   - Stage 5 (apply-bundle) — see apply-bundle.test.ts / .parity.test.ts
//   - Stage 6 (docker CI) — needs a live docker daemon
//   - Stage 8+ (git commit, gh pr create, ClickUp writes) — gated behind
//     TRP_ALLOW_REMOTE_MUTATE and remote services
//   - The composed-run wrapper→driver→trailer flow — see
//     tests/composed-run/hand-itc-308.parity.test.ts
//
// Lint disables — parity-test mock closures branch on args + loop-body
// closures are needed to feed the driver's stage machinery deterministically;
// the vitest/no-conditional-* + eslint/no-loop-func rules fire on legitimate
// patterns.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect, vitest/require-mock-type-parameters, eslint/no-unused-vars, eslint/no-loop-func */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";

// Hoisted mock: replace `@foundation/shell` before the module under test is
// evaluated. Every subprocess call the driver makes (time-tracker, mise,
// git, gh, curl, docker) is routed through this mock so no real binary
// runs during the test suite. Each test that drives sh() steers behavior
// via `mockedSh.mockResolvedValue*`.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
	stdioJournal: vi.fn(),
}));

const mockedSh = vi.mocked(sh);

type ShResult = Awaited<ReturnType<typeof sh>>;

function shResult(exitCode: number, stdout = "", stderr = ""): ShResult {
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

// Silence process.stdout / process.stderr writes and return accessors so a
// failing test doesn't drown the vitest reporter in the driver's log lines.
// Kept out of `describe` — the closure captures the spy handles per-test.
type StdioCapture = { stdout: () => string; stderr: () => string };

function captureStdio(): StdioCapture {
	const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return {
		stdout: () => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
		stderr: () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(""),
	};
}

// Fixture manifest shape. The `payload_shape` block is optional; when set it
// spot-checks fields inside a JSON side-effect file the driver wrote (support
// mode's comment-payload.json is the current sole consumer).
type FixtureInput = {
	readonly argv: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly files?: Readonly<Record<string, string>>;
	readonly task_mode?: string | null;
};

type PayloadShape = {
	readonly path: string;
	readonly expect: Readonly<Record<string, string>>;
	readonly expect_comment_contains?: string;
};

type FixtureExpected = {
	readonly exit_code: number;
	readonly stdout_contains?: readonly string[];
	readonly stderr_contains?: readonly string[];
	readonly files_present?: readonly string[];
	readonly files_absent?: readonly string[];
	readonly payload_shape?: PayloadShape;
};

const FIXTURE_ROOT = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"fix-task",
);

// The list is exact: exactly 12 auto-repair (stage × attempt) fixtures. Any
// drift here (add/remove a fixture, rename a directory) breaks the loop
// intentionally — the caller is expected to update this list in the same PR
// that adds the fixture, so the "which fixtures ran?" question is answerable
// from source without listing the tree.
const FIXTURES: readonly string[] = [
	// argv layer — no cwd state required
	"help",
	"missing-task",
	"invalid-mode",
	"unknown-arg",
	// env-file preflight — cwd holds partial state
	"missing-sfp-env",
	"missing-trp-env",
	// support-mode short-circuit across the loop cap
	"support-a1",
	"support-a2",
	"support-a5",
	"support-with-metadata",
	"support-repo-filter",
	"support-mode-attempt-boundary",
];

function readFixture(name: string): { input: FixtureInput; expected: FixtureExpected } {
	const dir = join(FIXTURE_ROOT, name);
	const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) as FixtureInput;
	const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as FixtureExpected;
	return { input, expected };
}

// Read a dotted-path field out of a parsed JSON object. Small helper so the
// fixture's `expect` map stays flat ({"source.title": "..."}) instead of
// forcing a full nested-JSON copy per fixture.
function readDotted(obj: unknown, path: string): unknown {
	const parts = path.split(".");
	let cur: unknown = obj;
	for (const p of parts) {
		if (cur === null || typeof cur !== "object") {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[p];
	}
	return cur;
}

// Materialize a fixture's `files` map under a scratch dir. Path keys are
// POSIX-shaped; parent directories are mkdir'd on demand.
function materializeFiles(root: string, files: Readonly<Record<string, string>>): void {
	for (const [rel, body] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
}

// ------- describe: fixture-driven parity walk (the 12-file matrix) ---------

describe("fix-task main() — auto-repair (stage × attempt) fixtures", () => {
	let scratch: string;
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};
	// Which env keys the fixtures may touch. Reset each one around every case
	// so a stray env leak from the harness (or a prior test) can't drift the
	// fixture's exit code.
	const ENV_KEYS = [
		"TRP_TASK_MODE",
		"TRP_FIX_LOOP_ENABLED",
		"TRP_FIX_LOOP_MAX_ATTEMPTS",
		"TRP_ALLOW_REMOTE_MUTATE",
		"TRP_ALLOW_INLINE_SPIKE",
		"TRP_ALLOW_CHILD_TICKET_CREATE",
		"TRP_PARALLEL_SAFE",
		"MISE_TRUSTED_CONFIG_PATHS",
	] as const;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "fix-task-fixture-"));
		originalCwd = process.cwd();
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		// Default sh mock: succeed silently. Individual fixtures don't reach
		// any real subprocess call because they all short-circuit at or
		// before stage 1's bin/mise check; even if one did, a green result
		// keeps the test deterministic.
		mockedSh.mockResolvedValue(shResult(0));
		vi.resetModules();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = v;
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("has exactly 12 fixture directories under the fix-task fixtures root", () => {
		// Rule 12: fail loud on drift. If someone deletes a fixture the loop
		// silently loses coverage; if they add one, this test names the
		// missing entry in `FIXTURES`. Either way the fail message points at
		// the fix.
		expect(FIXTURES.length).toBe(12);
		for (const name of FIXTURES) {
			expect(existsSync(join(FIXTURE_ROOT, name, "input.json"))).toBe(true);
			expect(existsSync(join(FIXTURE_ROOT, name, "expected.json"))).toBe(true);
		}
	});

	// One `it` per fixture so vitest's reporter names the failing fixture
	// directly rather than a single mega-test that runs 12 assertions.
	for (const name of FIXTURES) {
		it(`fixture: ${name}`, async () => {
			const { input, expected } = readFixture(name);

			// Materialize files into scratch cwd and chdir in.
			materializeFiles(scratch, input.files ?? {});
			process.chdir(scratch);

			// Apply fixture env vars on top of the wiped baseline.
			for (const [k, v] of Object.entries(input.env ?? {})) {
				process.env[k] = v;
			}

			// parseArgs() calls `process.exit(2)` directly for unknown-arg
			// and a handful of other malformed-argv branches; intercept it
			// with a throwing spy so vitest doesn't tear the worker down
			// and the fixture's exit_code assertion can catch either the
			// returned rc OR the exit-code smuggled through the throw.
			let exitCaught: number | null = null;
			const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				exitCaught = code ?? 0;
				throw new Error(`__FIXTURE_EXIT_${exitCaught}__`);
			}) as never);

			const stdio = captureStdio();
			// Import fresh per fixture so any top-level module state (there
			// is none today, but a future maintainer could add caching) does
			// not carry between cases.
			const { main } = await import("./fix-task.ts");
			let rc: number | null = null;
			try {
				rc = await main(input.argv);
			} catch (error) {
				if (exitCaught === null) {
					throw error;
				}
			}
			exitSpy.mockRestore();
			const observed = rc ?? exitCaught ?? -1;
			expect(observed).toBe(expected.exit_code);

			const stdout = stdio.stdout();
			const stderr = stdio.stderr();
			for (const needle of expected.stdout_contains ?? []) {
				expect(stdout).toContain(needle);
			}
			for (const needle of expected.stderr_contains ?? []) {
				expect(stderr).toContain(needle);
			}
			for (const rel of expected.files_present ?? []) {
				expect(existsSync(join(scratch, rel))).toBe(true);
			}
			for (const rel of expected.files_absent ?? []) {
				expect(existsSync(join(scratch, rel))).toBe(false);
			}

			if (expected.payload_shape) {
				const path = join(scratch, expected.payload_shape.path);
				const bytes = readFileSync(path, "utf8");
				const parsed = JSON.parse(bytes) as unknown;
				for (const [dotted, want] of Object.entries(expected.payload_shape.expect)) {
					expect(readDotted(parsed, dotted)).toBe(want);
				}
				if (expected.payload_shape.expect_comment_contains) {
					const cb = readDotted(parsed, "comment_body");
					expect(typeof cb).toBe("string");
					expect(cb as string).toContain(expected.payload_shape.expect_comment_contains);
				}
			}
		});
	}
});

// ------- describe: behavior tests for the unit-testable branches -----------

describe("fix-task main() — argv + preflight behavior", () => {
	let scratch: string;
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"TRP_TASK_MODE",
		"TRP_FIX_LOOP_ENABLED",
		"TRP_FIX_LOOP_MAX_ATTEMPTS",
		"TRP_ALLOW_REMOTE_MUTATE",
		"TRP_ALLOW_INLINE_SPIKE",
		"TRP_PARALLEL_SAFE",
		"MISE_TRUSTED_CONFIG_PATHS",
	] as const;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "fix-task-behavior-"));
		originalCwd = process.cwd();
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		mockedSh.mockResolvedValue(shResult(0));
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = v;
			}
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	// ---- argv-only branches -------------------------------------------------

	it("returns 0 and prints the usage block on --help", async () => {
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["--help"]);
		expect(rc).toBe(0);
		expect(stdio.stdout()).toContain("fix-task.sh — TRP driver");
		expect(stdio.stdout()).toContain("Exit code legend");
	});

	it("returns 0 and prints the usage block on -h", async () => {
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["-h"]);
		expect(rc).toBe(0);
		expect(stdio.stdout()).toContain("fix-task.sh — TRP driver");
	});

	it("returns 2 with a stable stderr line when no <TRACKER>:<TASK_ID> is passed", async () => {
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main([]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("pass <TRACKER>:<TASK_ID>");
	});

	it("rejects an unknown flag with exit 2 and a stderr echo of the arg", async () => {
		const stdio = captureStdio();
		// parseArgs calls process.exit(2) on unknown args. We must intercept
		// process.exit so the vitest worker survives the assertion.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`__EXIT_${code ?? 0}__`);
		}) as never);
		const { main } = await import("./fix-task.ts");
		await expect(main(["--bogus-flag"])).rejects.toThrow("__EXIT_2__");
		expect(stdio.stderr()).toContain("unknown arg: --bogus-flag");
		exitSpy.mockRestore();
	});

	it("rejects --mode=<not-in-VALID_TASK_MODES> with exit 2 and the valid-modes list", async () => {
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-1", "--mode=totally-invented"]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("invalid TRP_TASK_MODE=totally-invented");
		// The valid-modes list must be reproduced verbatim so the operator can
		// copy-paste a correction; drift in ordering here would break scripts
		// that grep the stderr for the acceptable set.
		expect(stdio.stderr()).toContain(
			"spike-writeup|spike-solve|spike-full|solve|reproduce|support",
		);
	});

	// ---- env-file preflight -------------------------------------------------

	it("returns 2 when sfp.env is missing in cwd", async () => {
		process.chdir(scratch);
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-2"]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("sfp.env missing");
	});

	it("returns 2 when sfp.env exists but trp.env is missing", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_HAND=handled:o/r:main\n");
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-3"]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("trp.env missing");
	});

	// ---- support-mode short-circuit ----------------------------------------

	it("support mode writes a comment payload and exits 0 without any subprocess call", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_HAND=handled:o/r:main\n");
		writeFileSync(join(scratch, "trp.env"), "");
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:SUPPORT-BEHAVIOR", "--mode=support"]);
		expect(rc).toBe(0);
		// Slug uses lowercase; the raw task id keeps its case.
		const payloadPath = join(
			scratch,
			"discovery/proof/clickup_support-behavior/comment-payload.json",
		);
		expect(existsSync(payloadPath)).toBe(true);
		const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<string, unknown>;
		expect(payload.task_id).toBe("clickup:SUPPORT-BEHAVIOR");
		expect(payload.task_id_slug).toBe("clickup_support-behavior");
		expect(payload.mode).toBe("support");
		expect(String(payload.comment_body)).toContain("TRP support-mode response");
		// stdout logs the payload write + the done marker; both are contract
		// with the composed-run parity fixture, so lock them here too.
		expect(stdio.stdout()).toContain("wrote discovery/proof/clickup_support-behavior");
		expect(stdio.stdout()).toContain("done (mode=support");

		// Rule 12 witness: support mode must NOT invoke sh() (no time-tracker,
		// no mise, no git). If a maintainer accidentally moves ttStart above
		// the mode gate this assertion catches it — the auto-repair loop
		// would otherwise burn a subprocess turn per support ticket.
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("support mode reads title/description from discovery/task-<slug>.json when present", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_HAND=handled:o/r:main\n");
		writeFileSync(join(scratch, "trp.env"), "");
		mkdirSync(join(scratch, "discovery"), { recursive: true });
		writeFileSync(
			join(scratch, "discovery/task-clickup_support-mem.json"),
			JSON.stringify({
				name: "Firebase quota exhaustion",
				text_content: "Auth requests are 429ing since Tuesday.",
			}),
		);
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:SUPPORT-MEM", "--mode=support"]);
		expect(rc).toBe(0);
		const payload = JSON.parse(
			readFileSync(
				join(scratch, "discovery/proof/clickup_support-mem/comment-payload.json"),
				"utf8",
			),
		) as { source: { title: string; description_excerpt: string }; comment_body: string };
		expect(payload.source.title).toBe("Firebase quota exhaustion");
		expect(payload.source.description_excerpt).toBe("Auth requests are 429ing since Tuesday.");
		expect(payload.comment_body).toContain("Firebase quota exhaustion");
	});

	it("support mode falls back to empty title/description on malformed task JSON", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_HAND=handled:o/r:main\n");
		writeFileSync(join(scratch, "trp.env"), "");
		mkdirSync(join(scratch, "discovery"), { recursive: true });
		writeFileSync(join(scratch, "discovery/task-clickup_support-bad.json"), "{ not-json");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:SUPPORT-BAD", "--mode=support"]);
		// Must not crash on JSON parse error — the on-disk task JSON can
		// be corrupt (partial download, cancelled tracker-fetch) and the
		// support path is expected to degrade to an empty payload, not fail.
		expect(rc).toBe(0);
		const payload = JSON.parse(
			readFileSync(
				join(scratch, "discovery/proof/clickup_support-bad/comment-payload.json"),
				"utf8",
			),
		) as { source: { title: string; description_excerpt: string } };
		expect(payload.source.title).toBe("");
		expect(payload.source.description_excerpt).toBe("");
	});

	it("support mode truncates a long description at 400 chars for the excerpt", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_HAND=handled:o/r:main\n");
		writeFileSync(join(scratch, "trp.env"), "");
		mkdirSync(join(scratch, "discovery"), { recursive: true });
		const bigDesc = "A".repeat(1200);
		writeFileSync(
			join(scratch, "discovery/task-clickup_support-long.json"),
			JSON.stringify({ name: "T", text_content: bigDesc }),
		);
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:SUPPORT-LONG", "--mode=support"]);
		expect(rc).toBe(0);
		const payload = JSON.parse(
			readFileSync(
				join(scratch, "discovery/proof/clickup_support-long/comment-payload.json"),
				"utf8",
			),
		) as { source: { description_excerpt: string } };
		expect(payload.source.description_excerpt.length).toBe(400);
		expect(payload.source.description_excerpt).toBe("A".repeat(400));
	});

	// ---- argv → slug interplay ---------------------------------------------

	it("preserves dashes in the slug (HAND_ITC-308 → hand_itc-308), lowercases colon side", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND_ITC-308", "--mode=support"]);
		expect(rc).toBe(0);
		// The slug preserves the meaningful dash between ITC and 308 — a
		// regression that stripped it would break the wrapper's file naming
		// and every downstream fail-JSON path.
		expect(
			existsSync(join(scratch, "discovery/proof/clickup_hand_itc-308/comment-payload.json")),
		).toBe(true);
		expect(existsSync(join(scratch, "discovery/fix-log-clickup_hand_itc-308.txt"))).toBe(true);
	});

	it("collapses characters outside [a-z0-9_-] to underscore in the slug", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		// The task id "clickup:foo@bar!baz" carries chars the slug rule must
		// rewrite to `_`; the leading `_` from the `:` collapse is stripped.
		const rc = await main(["clickup:foo@bar!baz", "--mode=support"]);
		expect(rc).toBe(0);
		expect(
			existsSync(join(scratch, "discovery/proof/clickup_foo_bar_baz/comment-payload.json")),
		).toBe(true);
	});

	it("--attempt=abc parses to 1 (fallback) — no exception, support still exits 0", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main([
			"clickup:HAND-ABC",
			"--mode=support",
			"--attempt=abc",
			"--after-workflow=discovery/nope.json",
		]);
		// support wins; parseArgs's `Math.trunc(Number('abc')) || 1` must
		// not throw even though the value is NaN.
		expect(rc).toBe(0);
	});

	it("--push and --push-force both flip allowPush; --push-force additionally flips allowPushForce (support wins over both)", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-PUSH", "--mode=support", "--push", "--push-force"]);
		expect(rc).toBe(0);
		expect(
			existsSync(join(scratch, "discovery/proof/clickup_hand-push/comment-payload.json")),
		).toBe(true);
		// Support short-circuits before either flag has any observable effect,
		// so no remote-mutation subprocess should have fired (mockedSh not
		// called at all — verified in the earlier support test).
	});

	// ---- env sourcing behavior ---------------------------------------------

	it("sources sfp.env values into process.env (KEY=VALUE lines, comments stripped, quotes trimmed)", async () => {
		process.chdir(scratch);
		writeFileSync(
			join(scratch, "sfp.env"),
			[
				"# comment line skipped",
				"",
				"SFP_REPO_HAND=handled:o/r:main",
				'SFP_QUOTED="quoted-value"',
				"export SFP_EXPORTED='exported-value'",
				"badline-no-equals",
			].join("\n"),
		);
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-ENV", "--mode=support"]);
		expect(rc).toBe(0);
		expect(process.env.SFP_REPO_HAND).toBe("handled:o/r:main");
		expect(process.env.SFP_QUOTED).toBe("quoted-value");
		expect(process.env.SFP_EXPORTED).toBe("exported-value");
		// Explicit non-effect: leading comment must not become a key, and
		// "badline-no-equals" is silently ignored (no `SFP_` prefix, no `=`).
		expect(process.env["# comment line skipped"]).toBeUndefined();
	});

	it("also sources sfp.env.local and trp.env.local when present (later wins)", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "SFP_MODE=base\n");
		writeFileSync(join(scratch, "sfp.env.local"), "SFP_MODE=override\n");
		writeFileSync(join(scratch, "trp.env"), "TRP_MODE=base\n");
		writeFileSync(join(scratch, "trp.env.local"), "TRP_MODE=override\n");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-LOCAL", "--mode=support"]);
		expect(rc).toBe(0);
		expect(process.env.SFP_MODE).toBe("override");
		expect(process.env.TRP_MODE).toBe("override");
	});

	// ---- mise-trust-path preservation --------------------------------------

	it("prepends the cwd's mise.toml onto MISE_TRUSTED_CONFIG_PATHS, preserving any prior value", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		process.env.MISE_TRUSTED_CONFIG_PATHS = "/prior/path";
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-MISE", "--mode=support"]);
		expect(rc).toBe(0);
		// Trust path must carry both the scratch cwd's mise.toml AND the
		// previously-trusted "/prior/path", separated by `:`. A drift here
		// silently un-trusts operator-configured trees. cwd is compared
		// against realpath(scratch) because macOS's mkdtemp lives under
		// /var/folders but process.cwd() resolves via /private/var/folders.
		const trusted = process.env.MISE_TRUSTED_CONFIG_PATHS ?? "";
		const expectedMise = join(realpathSync(scratch), "mise.toml");
		expect(trusted.startsWith(expectedMise)).toBe(true);
		expect(trusted).toContain("/prior/path");
	});

	it("sets MISE_TRUSTED_CONFIG_PATHS to just the cwd's mise.toml when no prior value exists", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-MISE-NEW", "--mode=support"]);
		expect(rc).toBe(0);
		expect(process.env.MISE_TRUSTED_CONFIG_PATHS).toBe(join(realpathSync(scratch), "mise.toml"));
	});

	// ---- TRP_TASK_MODE env fallback ----------------------------------------

	it("honors TRP_TASK_MODE=support from env when --mode is absent", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		process.env.TRP_TASK_MODE = "support";
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-ENV-MODE"]);
		expect(rc).toBe(0);
		expect(
			existsSync(join(scratch, "discovery/proof/clickup_hand-env-mode/comment-payload.json")),
		).toBe(true);
	});

	it("defaults task_mode to 'solve' when neither --mode nor TRP_TASK_MODE is set", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		const stdio = captureStdio();
		// Solve mode continues into stage 0's bin/mise check, which we haven't
		// staged in scratch — so the driver returns 2 with a stable stderr.
		// This is the exact "unset mode → solve" branch under test.
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-DEFAULT"]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("bin/mise missing");
	});

	it("--mode=<value> takes precedence over TRP_TASK_MODE env", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		// Env says solve; argv says support. Support must win — otherwise
		// a stale env from a prior loop iteration would drag the driver
		// into a stage-2+ path it shouldn't take.
		process.env.TRP_TASK_MODE = "solve";
		captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-OVER", "--mode=support"]);
		expect(rc).toBe(0);
		// The env var must also be normalized to the chosen mode so
		// downstream stages read a consistent value.
		expect(process.env.TRP_TASK_MODE).toBe("support");
	});

	// ---- stage 0 bootstrap error path (non-support) -------------------------

	it("returns 2 with 'bin/mise missing' stderr when bin/mise is absent in cwd (non-support)", async () => {
		process.chdir(scratch);
		writeFileSync(join(scratch, "sfp.env"), "");
		writeFileSync(join(scratch, "trp.env"), "");
		// solve mode = does NOT short-circuit at stage 0's support branch,
		// so the driver falls through to the `isExecutable("bin/mise")`
		// check and returns 2. This is the canonical "stage 0 bootstrap
		// failed" branch the auto-repair loop must treat as "human decides".
		const stdio = captureStdio();
		const { main } = await import("./fix-task.ts");
		const rc = await main(["clickup:HAND-MISE-MISSING", "--mode=solve"]);
		expect(rc).toBe(2);
		expect(stdio.stderr()).toContain("bin/mise missing");
	});
});
