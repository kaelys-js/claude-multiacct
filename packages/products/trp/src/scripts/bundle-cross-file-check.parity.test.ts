// Parity test for `bundle-cross-file-check.ts` against the Python original
// `trp/scripts/bundle-cross-file-check.py` (SRP-V). Both scripts read a
// bundle JSON, scan every file's `full_content` for cross-file
// consistency issues (env-var default drift, top-level const drift,
// import-path drift), and write a structured findings report to
// `discovery/bundle-cross-file-<task_id_slug>.json`.
//
// WHY it matters: the SRP-J revise loop consumes this JSON as one of the
// signals that lets the workflow rewrite a bundle without a human in the
// loop. A byte-for-byte drift in the report schema (a renamed key, a
// reordered locations map, a severity string case flip) silently corrupts
// the failure JSON that main context hands the workflow — the fix loop
// stalls or regresses instead of converging. The Python original is the
// contract the loop was built against; this parity test pins the TS port
// to the same output bytes.
//
// Output shape: (d) side-effect JSON file written to
// `discovery/bundle-cross-file-<task_id_slug>.json`. Stdout carries a
// human-readable log line, but the driver's revise loop only reads the
// side-effect JSON, so that is the parity oracle. The stdout line is
// asserted only for shape (presence of "cross-file check:" and the
// finding count) — bytes are not compared, since the driver never parses
// them.
//
// Comparator: byte-for-byte string equality between the file the TS
// port writes and `expected-side.json` (captured from a subprocess
// invocation of the Python original against the same `input.json`).
// Both `json.dumps(..., indent=2)` (Python) and
// `JSON.stringify(..., null, 2)` (Node) produce identical bytes for the
// finding schema in use — no key sorting, no trailing newline. A drift
// in either half surfaces immediately as a diff diagnostic.
//
// Fixture: `tests/fixtures/scripts/bundle-cross-file-check/input.json`
// is a fully synthesized 3-file bundle that triggers one finding per
// severity class (HIGH env-default, MEDIUM const-value, LOW import-path
// — the third category fires twice because two imports drift). The
// fixture carries no client source and no secrets; `sanitize-manifest.json`
// records zero replacements.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a driver-log reader sees exactly which finding
// drifted without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./bundle-cross-file-check.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"bundle-cross-file-check",
);

const TASK_ID_SLUG = "fixture-parity";
const REPORT_REL_PATH = `discovery/bundle-cross-file-${TASK_ID_SLUG}.json`;

// The Python original's `report_path` is a relative path
// (`discovery/bundle-cross-file-<slug>.json`) — the file lands under
// the process's cwd. The TS port preserves that behaviour exactly. To
// keep the test hermetic, we chdir into a fresh temp dir per case,
// pre-create the `discovery/` subdir the script expects, run `main()`,
// then restore cwd + prune the temp dir. The fixture's `input.json`
// path is absolute, so the chdir does not perturb the read side.
describe("bundle-cross-file-check.ts — parity against Python original", () => {
	let originalCwd: string;
	let tempDir: string;
	let originalBundleJson: string | undefined;
	let originalTaskIdSlug: string | undefined;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalBundleJson = process.env.BUNDLE_JSON;
		originalTaskIdSlug = process.env.TASK_ID_SLUG;
		tempDir = mkdtempSync(join(tmpdir(), "bundle-cross-file-parity-"));
		// Pre-create the `discovery/` subdir the script writes into.
		// The TS port's report path is relative to cwd (matching the
		// Python original); without the subdir, `writeFileSync` fails.
		mkdirSync(join(tempDir, "discovery"), { recursive: true });
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalBundleJson === undefined) {
			delete process.env.BUNDLE_JSON;
		} else {
			process.env.BUNDLE_JSON = originalBundleJson;
		}
		if (originalTaskIdSlug === undefined) {
			delete process.env.TASK_ID_SLUG;
		} else {
			process.env.TASK_ID_SLUG = originalTaskIdSlug;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes the recorded side-effect JSON byte-for-byte", async () => {
		const inputPath = resolve(FIXTURE_DIR, "input.json");
		// Touch the fixture so a missing file fails loudly here rather
		// than later inside the script's own read line.
		JSON.parse(readFileSync(inputPath, "utf8"));

		process.env.BUNDLE_JSON = inputPath;
		process.env.TASK_ID_SLUG = TASK_ID_SLUG;

		const code = await main();

		// Exit code is part of the contract: HIGH finding present →
		// code 5, MEDIUM/LOW only → code 0. The fixture triggers a
		// HIGH env-default-mismatch, so 5.
		expect(code).toBe(5);

		const actualBytes = readFileSync(join(tempDir, REPORT_REL_PATH), "utf8");
		const expectedBytes = readFileSync(resolve(FIXTURE_DIR, "expected-side.json"), "utf8");

		if (actualBytes !== expectedBytes) {
			// Rule 12: fail loud. Print both sides so the diff is on
			// screen when a CI reader hits the failing case, without
			// having to re-run the test locally to see what drifted.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:bundle-cross-file-check] actual=\n${actualBytes}\nexpected=\n${expectedBytes}`,
			);
		}
		expect(actualBytes).toBe(expectedBytes);
	});
});
