// Parity test for `tracker-post-proof.ts` against a fixture pair captured
// from the Python source at `security-pocs/repos/trp/scripts/tracker-post-proof.py`.
//
// WHY it matters: the TS port is a byte-for-byte re-implementation. The
// driver's [SW] stage and the operator both read this script's stdout to
// confirm what would be posted to ClickUp before flipping the safety gate.
// Every artefact line, the "Proof bundle attached" summary, and the
// speedup-suffix block (rendered from `time-comparison.json` when present)
// have to match the Python source — a drift in wording or ordering silently
// changes what a reviewer sees while the [SW] stage still thinks the plan
// is correct. The unit tests cover the markdown-to-ClickUp-blocks converter
// and the ledger renderer in isolation; this test pins the whole `main()`
// glue against an output the Python source actually produced under the
// same argv + env + on-disk file tree.
//
// Output shape: (b) stdout text — the dry-run comment-plan path writes a
// deterministic block of lines. The Python source uses `print(...)`; the
// TS port uses `console.log(...)`. Vitest intercepts `console.log` before
// it reaches `process.stdout.write`, so we spy on `console.log` itself and
// reassemble the byte stream by joining args with `' '` and appending `\n`
// per call (the shape both `print` and `console.log` emit for single-arg
// calls, which is what every call site here does). The fixture ships
// `input.json` (argv, env, and the files to stage under a scratch cwd) and
// `expected.txt` (the recorded stdout). The test stages each file at its
// recorded relpath, chdirs into the scratch tree so the impl's relative
// `--proof-dir` resolves to the same on-disk layout the Python source
// read, patches `process.argv` + `process.env`, captures every
// `console.log` call, and asserts byte-for-byte equality against
// `expected.txt`. `sanitize-manifest.json` records zero replacements —
// the fixture uses a synthetic task id and file names, nothing to scrub.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./tracker-post-proof.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"tracker-post-proof",
);

type Fixture = {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly files: ReadonlyArray<{
		readonly relpath: string;
		readonly content: string;
	}>;
};

/**
 * Rule 12 — fail loud. On mismatch, print both sides in JSON form so any
 * invisible whitespace or Unicode difference is legible in the failure log.
 * No-op when `actual` matches `expected`.
 *
 * @param {string} actual - the stdout the TS port produced
 * @param {string} expected - the stdout recorded from the Python source
 * @returns {void} nothing; writes a diagnostic to the console on mismatch
 */
function logMismatch(actual: string, expected: string): void {
	if (actual !== expected) {
		// eslint-disable-next-line no-console
		console.error(
			`[parity:tracker-post-proof] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
		);
	}
}

describe("tracker-post-proof.ts — parity against Python source", () => {
	let scratch: string;
	let priorCwd: string;
	let priorArgv: string[];
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "tracker-post-proof-parity-"));
		priorCwd = process.cwd();
		priorArgv = process.argv;
	});

	afterEach(() => {
		process.chdir(priorCwd);
		process.argv = priorArgv;
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("reproduces the recorded dry-run comment plan byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(join(FIXTURE_DIR, "expected.txt"), "utf8");

		// Stage each file at its recorded relpath under the scratch cwd so
		// the impl's relative `--proof-dir proof-dir` resolves to the same
		// on-disk tree the Python source walked when we captured expected.txt.
		for (const { relpath, content } of fixture.files) {
			const abs = join(scratch, relpath);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		}

		// The impl reads `--proof-dir` off cwd, so chdir into the scratch
		// tree rather than threading a base path through the module.
		process.chdir(scratch);

		// `main()` reads argv via `process.argv.slice(2)` — mirror the shape
		// argparse consumes so argv[0]/[1] look like a normal Node invocation.
		process.argv = ["node", "tracker-post-proof.ts", ...fixture.argv];

		// Fully replace process.env so no stray `TRP_ALLOW_REMOTE_MUTATE`
		// or `CLICKUP_*` from the runner alters the safety-gate decision.
		process.env = { ...fixture.env, TRP_ALLOW_REMOTE_MUTATE: "true" };

		// Capture every `console.log` call. Vitest intercepts console.log
		// before it reaches process.stdout.write, so spying on stdout would
		// see nothing; the spy has to sit on console.log itself. Every call
		// site in the impl passes a single string, matching what Python's
		// `print(...)` emits — join args with ' ' to be safe and append the
		// trailing '\n' each call would produce.
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			chunks.push(String(chunk));
			return true;
		});

		await expect(main()).resolves.toBe(0);

		const actual = chunks.join("");
		logMismatch(actual, expected);
		expect(actual).toBe(expected);
	});
});
