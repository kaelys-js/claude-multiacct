// Parity test for `bundle-schema-check.ts` against the Python original
// `trp/scripts/bundle-schema-check.py` (SRP-X). Both scripts read a bundle
// JSON, walk `FIX_SRC` for every `schema.prisma`, parse model + field
// definitions, then scan every `full_content` in the bundle for Prisma
// accessors and raw-SQL identifiers that don't line up with the parsed
// schema — flagging missing-prisma-model, missing-prisma-field, and
// raw-sql-unknown-table findings. Result lands in
// `discovery/bundle-schema-<task_id_slug>.json`.
//
// WHY it matters: the SRP-J revise loop consumes this JSON as one of the
// signals that lets the workflow rewrite a bundle without a human in the
// loop (SEC-02 InternalUser.entraOid hallucination class). A byte-for-byte
// drift in the report schema (a renamed key, a reordered locations map, a
// severity string case flip, an evidence-slice length change) silently
// corrupts the failure JSON that main context hands the workflow — the
// fix loop stalls or regresses instead of converging. The Python original
// is the contract the loop was built against; this parity test pins the
// TS port to the same output bytes.
//
// Output shape: (d) side-effect JSON file written to
// `discovery/bundle-schema-<task_id_slug>.json`. Stdout carries the
// human-readable summary line and per-finding tail; exit code is 5 when
// findings exist, 0 on clean. The driver's revise loop only reads the
// side-effect JSON, so that is the parity oracle. Stdout is asserted on
// exit code only — bytes are not compared, since the driver never parses
// them.
//
// Comparator: byte-for-byte string equality between the file the TS
// port writes and `expected-side.json` (captured from a subprocess
// invocation of the Python original against the same `input.json` +
// `fix-src/prisma/schema.prisma`). Both `json.dumps(..., indent=2)`
// (Python) and `JSON.stringify(..., null, 2)` (Node) produce identical
// bytes for the finding schema in use — no key sorting, no trailing
// newline, and the fixture is scoped to ASCII-only summaries so
// Python's `ensure_ascii=True` vs Node's raw-UTF-8 output cannot
// diverge (see `sanitize-manifest.json` notes). A drift in either half
// surfaces immediately as a diff diagnostic.
//
// Fixture: `tests/fixtures/scripts/bundle-schema-check/input.json` is a
// fully synthesized 3-file bundle. `fix-src/prisma/schema.prisma`
// declares two models (`User`, `Session`). The bundle triggers one
// missing-prisma-field (`User.entraOid`) and one missing-prisma-model
// (`prisma.audit`). The third file (`prisma.session.findUnique`) is
// clean and pins the negative case — a schema-conforming access must
// not produce a finding. The fixture carries no client source and no
// secrets; `sanitize-manifest.json` records zero replacements.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a driver-log reader sees exactly which finding
// drifted without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./bundle-schema-check.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"bundle-schema-check",
);

const TASK_ID_SLUG = "fixture-parity";
const REPORT_REL_PATH = `discovery/bundle-schema-${TASK_ID_SLUG}.json`;

// The Python original's `report_path` is a relative path
// (`discovery/bundle-schema-<slug>.json`) — the file lands under the
// process's cwd. The TS port preserves that behaviour exactly. To keep
// the test hermetic, we chdir into a fresh temp dir per case,
// pre-create the `discovery/` subdir the script expects, run `main()`,
// then restore cwd + prune the temp dir. The fixture's `input.json` and
// `fix-src/` paths are absolute, so the chdir does not perturb the read
// side.
describe("bundle-schema-check.ts — parity against Python original", () => {
	let originalCwd: string;
	let tempDir: string;
	let originalBundleJson: string | undefined;
	let originalFixSrc: string | undefined;
	let originalTaskIdSlug: string | undefined;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalBundleJson = process.env.BUNDLE_JSON;
		originalFixSrc = process.env.FIX_SRC;
		originalTaskIdSlug = process.env.TASK_ID_SLUG;
		tempDir = mkdtempSync(join(tmpdir(), "bundle-schema-parity-"));
		// Pre-create the `discovery/` subdir the script writes into.
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
		if (originalFixSrc === undefined) {
			delete process.env.FIX_SRC;
		} else {
			process.env.FIX_SRC = originalFixSrc;
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
		const fixSrcPath = resolve(FIXTURE_DIR, "fix-src");
		// Touch the fixture so a missing file fails loudly here rather
		// than later inside the script's own read line.
		JSON.parse(readFileSync(inputPath, "utf8"));

		process.env.BUNDLE_JSON = inputPath;
		process.env.FIX_SRC = fixSrcPath;
		process.env.TASK_ID_SLUG = TASK_ID_SLUG;

		const code = await main();

		// Exit code is part of the contract: findings present → code 5,
		// clean scan or skip-condition → code 0. The fixture triggers a
		// missing-prisma-field and a missing-prisma-model, so 5.
		expect(code).toBe(5);

		const actualBytes = readFileSync(join(tempDir, REPORT_REL_PATH), "utf8");
		const expectedBytes = readFileSync(resolve(FIXTURE_DIR, "expected-side.json"), "utf8");

		if (actualBytes !== expectedBytes) {
			// Rule 12: fail loud. Print both sides so the diff is on
			// screen when a CI reader hits the failing case, without
			// having to re-run the test locally to see what drifted.
			// eslint-disable-next-line no-console
			console.error(
				`[parity:bundle-schema-check] actual=\n${actualBytes}\nexpected=\n${expectedBytes}`,
			);
		}
		expect(actualBytes).toBe(expectedBytes);
	});
});
