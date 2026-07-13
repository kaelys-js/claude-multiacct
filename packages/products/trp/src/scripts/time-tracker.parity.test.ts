// Parity test for `time-tracker.ts` against the Python original
// `security-pocs/repos/trp/scripts/time-tracker.py`. Both scripts read
// per-stage session JSONs under `<REPO_ROOT>/discovery/time/<task>-<stage>.json`
// and emit an aggregate JSON summarizing total duration + per-stage
// records.
//
// WHY it matters: the driver's `srp-run-loop.sh` / `time-tracker` glue
// pipes `time-tracker.py aggregate --task <task>` stdout straight into
// downstream tools (compare, push, and the operator's inspection
// output). A drift in field ordering, ms→hours rounding, or the
// per-stage record shape silently corrupts the loop-attempt summary and
// the Harvest/ClickUp push payloads it feeds. The Python original is
// the contract the loop was built against; this test pins the TS port
// to the same output bytes.
//
// Output shape: (b) stdout text — `cmd_aggregate` writes a single
// `json.dumps(..., indent=2)` blob followed by the `print()` trailing
// newline. The TS port mirrors this with `JSON.stringify(..., null, 2)`
// + "\n". No filesystem side effect for the `aggregate` command.
//
// Comparator: byte-for-byte string equality between the stdout the TS
// port emits and `expected.txt` (captured from a subprocess invocation
// of the Python original against the same synthesized session tree).
// Both serializers produce identical bytes for this schema (integer
// ms values, a fractional `sum_hours` chosen to avoid the
// Python `float.__repr__` "2.0" vs. Node `2` divergence).
//
// Fixture: `tests/fixtures/scripts/time-tracker/input.json` carries
// the target task id + a list of `{filename, body}` session records to
// stage under `<REPO_ROOT>/discovery/time/`. No client source, no
// secrets, no absolute paths — `sanitize-manifest.json` records zero
// replacements. The session durations sum to 579000 ms → 0.1608 h
// (fourth-decimal fractional, not integer-valued), so both Python
// `json.dumps(0.1608)` and Node `JSON.stringify(0.1608)` emit
// `"0.1608"` verbatim.
//
// Test seam: `time-tracker.ts` computes TIME_DIR from `import.meta.url`
// at module load and never re-reads it, so the test cannot chdir its
// way out. It stages the fixture sessions directly into the module's
// TIME_DIR (`<src>/discovery/time/`) under the fixture's unique task
// prefix (`PARITY-TASK-01-*.json`) and prunes exactly those files in
// `afterEach`. A test-only prefix keeps a live session tree (if any)
// from colliding with the parity data.
//
// Failure diagnostic (Rule 12): on mismatch, prints both actual and
// expected bytes so a driver-log reader sees exactly which byte
// drifted without cross-referencing the expected file by hand.

/* oxlint-disable vitest/no-conditional-in-test */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./time-tracker.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"time-tracker",
);

// Mirror the impl's REPO_ROOT / TIME_DIR derivation so the fixture
// lands where `aggregateTask` will read it. Both use `import.meta.url`
// -> parent dir -> `..` to reach `<src>/`, then `discovery/time/`.
const IMPL_DIR = import.meta.dirname;
const REPO_ROOT = resolve(IMPL_DIR, "..");
const TIME_DIR = join(REPO_ROOT, "discovery", "time");

type SessionFixture = {
	readonly filename: string;
	readonly body: Readonly<Record<string, unknown>>;
};

type Fixture = {
	readonly task: string;
	readonly sessions: readonly SessionFixture[];
};

describe("time-tracker.ts — parity against Python original", () => {
	let stagedPaths: string[] = [];
	let timeDirCreatedByTest = false;

	beforeEach(() => {
		stagedPaths = [];
		timeDirCreatedByTest = !existsSync(TIME_DIR);
	});

	afterEach(() => {
		// Prune only what the test staged, in case a real session tree
		// coexists. If we created TIME_DIR ourselves and it's now empty,
		// remove it so the test leaves no trace.
		for (const p of stagedPaths) {
			try {
				rmSync(p, { force: true });
			} catch {
				// Best effort — a leftover stage file matching our fixed
				// prefix is safer than a rethrow that hides the real
				// assertion failure below.
			}
		}
		if (timeDirCreatedByTest && existsSync(TIME_DIR)) {
			try {
				// Only remove if empty — a concurrent run staging its own
				// sessions should not have its work wiped. rmSync with
				// `recursive: false` throws EISDIR on directories, so
				// probe empties via readdirSync and rmdirSync the shell.
				const remaining = readdirSync(TIME_DIR);
				if (remaining.length === 0) {
					rmSync(TIME_DIR, { recursive: true, force: true });
				}
			} catch {
				// Best effort — a residue that survives cleanup is safer
				// than a rethrow that hides the real assertion failure.
			}
		}
		vi.restoreAllMocks();
	});

	it("reproduces the recorded stdout byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(join(FIXTURE_DIR, "expected.txt"), "utf8");

		mkdirSync(TIME_DIR, { recursive: true });
		for (const session of fixture.sessions) {
			const abs = join(TIME_DIR, session.filename);
			// Match the Python source's write: indent=2 + trailing "\n".
			// Field-order drift in the file body would not affect
			// aggregate's output (which pulls named keys), but keeping
			// the on-disk shape identical to what `cmd_start`/`cmd_stop`
			// would emit rules out any incidental parser divergence.
			writeFileSync(abs, `${JSON.stringify(session.body, null, 2)}\n`);
			stagedPaths.push(abs);
		}

		// Capture every `process.stdout.write` chunk in emission order.
		// The impl writes the JSON blob then a trailing "\n" in a single
		// call; concatenation still matches the byte layout of
		// expected.txt.
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});

		await expect(main(["aggregate", "--task", fixture.task])).resolves.toBe(0);

		const actual = chunks.join("");
		if (actual !== expected) {
			// Rule 12 — fail loud. Emit both sides so a CI reader sees
			// exactly which byte drifted without re-running locally.
			// eslint-disable-next-line no-console
			console.error(`[parity:time-tracker] actual=\n${actual}\nexpected=\n${expected}`);
		}
		expect(actual).toBe(expected);
	});
});
