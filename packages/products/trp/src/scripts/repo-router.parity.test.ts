// Parity test for `repo-router.ts` against the Python original
// `trp/scripts/repo-router.py`. Both scripts read `sfp.env` + `trp.env`
// at REPO_ROOT, walk the `SFP_REPO_<slug>=<slug>:<owner>/<repo>:<default_branch>`
// registry, pick the best match for `--intent-hint`, and emit a single
// JSON object on stdout carrying `{slug, owner, repo, default_branch,
// fix_src_path}`. `fix_src_path` folds the `--task` id when
// `TRP_PARALLEL_SAFE=true`.
//
// WHY it matters: main context reads that JSON verbatim via `JSON.parse`
// to route every downstream driver invocation — the wrong slug picks the
// wrong client repo, the wrong fix_src_path collides two concurrent runs
// into the same tree. The Python original is the contract every caller
// was built against; this parity test pins the TS port to the same
// return value.
//
// Output shape: (a) pure return value serialized as a single JSON line
// on stdout. The comparator is byte-for-byte string equality after one
// sanitize pass — replace the runtime scratch REPO_ROOT prefix in
// `fix_src_path` with the literal token `<REPO_ROOT>`. The expected.txt
// bytes were generated from a subprocess run of the Python original
// against `input.json`, re-serialized via Node `JSON.stringify` (no
// indent, no key sort) so the compare targets the shape-(a) contract
// (the JSON value) rather than one serializer's whitespace convention.
// sanitize-manifest.json records one path_leak replacement.
//
// Module load anchor: `repo-router.ts` resolves REPO_ROOT at module
// load — `TRP_REPO_ROOT` when set, otherwise file-anchored two levels
// up from the module. The test sets `process.env.TRP_REPO_ROOT` to a
// per-case scratch dir where the fixture's sfp.env + trp.env are
// staged, calls `vi.resetModules()` so the next dynamic import re-
// evaluates the module against the new override, then reads `main()`
// off the freshly imported namespace. Without the reset the top-level
// constants would stick to whatever the previous import captured.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a CI reader sees exactly which byte drifted
// without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"repo-router",
);

type Fixture = {
	readonly sfp_env_text: string;
	readonly trp_env_text: string;
	readonly argv: readonly string[];
};

describe("repo-router.ts — parity against Python original", () => {
	let scratch: string;
	let prevRepoRoot: string | undefined;

	beforeEach(() => {
		prevRepoRoot = process.env.TRP_REPO_ROOT;
		// macOS symlinks /tmp -> /private/tmp and /var/folders ->
		// /private/var/folders. The env var is passed through verbatim,
		// but the fs reads inside `main()` will resolve symlinks — align
		// the scratch prefix with the realpath form so the sanitize
		// replaceAll() matches the exact string the module captured.
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "repo-router-parity-")));
		process.env.TRP_REPO_ROOT = scratch;
		// Force a fresh module evaluation so REPO_ROOT reads the new
		// env-var override, not whatever value the previous import
		// captured.
		vi.resetModules();
	});

	afterEach(() => {
		if (prevRepoRoot === undefined) {
			delete process.env.TRP_REPO_ROOT;
		} else {
			process.env.TRP_REPO_ROOT = prevRepoRoot;
		}
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("reproduces the recorded stdout byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(join(FIXTURE_DIR, "expected.txt"), "utf8");

		// Stage the env files at the scratch REPO_ROOT so both the
		// registry parse and the TRP_PARALLEL_SAFE lookup land on the
		// fixture bytes.
		writeFileSync(join(scratch, "sfp.env"), fixture.sfp_env_text);
		writeFileSync(join(scratch, "trp.env"), fixture.trp_env_text);

		// Capture every stdout write chunk in emission order. `main()`
		// writes the JSON body + a trailing `\n` as two separate writes;
		// concatenation preserves both.
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});

		// Dynamic import AFTER chdir + resetModules so REPO_ROOT is the
		// scratch dir. Static top-of-file import would freeze REPO_ROOT
		// at Vitest's boot cwd and every env-file read would miss the
		// fixture bytes.
		const mod = (await import("./repo-router.ts")) as {
			main: (argv?: readonly string[]) => number;
		};
		const code = mod.main(fixture.argv);
		expect(code).toBe(0);

		const raw = chunks.join("");
		// Sanitize step (see sanitize-manifest.json): the runtime
		// REPO_ROOT prefix in fix_src_path leaks the operator's scratch
		// path. Replace with a stable placeholder so the compare is
		// hermetic across machines.
		const actual = raw.replaceAll(scratch, "<REPO_ROOT>");

		if (actual !== expected) {
			// Rule 12: fail loud. Print both sides in JSON form so any
			// invisible whitespace difference is legible in the CI log.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:repo-router] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
			);
		}
		expect(actual).toBe(expected);
	});
});
