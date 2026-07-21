// Parity test for `tracker-tag-task.ts` against a fixture pair captured from
// the Python source at `security-pocs/repos/trp/scripts/tracker-tag-task.py`.
//
// WHY it matters: the TS port is a byte-for-byte re-implementation of the
// operator-facing CLI. The dry-run wording is what an operator scans in a
// terminal transcript when reviewing a queued tag mutation; the deterministic
// sha256-index colour picker is what keeps `sec-02` painting the same slot on
// every operator's screen, forever. Any drift in the palette table, the hash
// formula, the argparse shape, or the DRY-RUN string wording would silently
// diverge from the Python source and break cross-operator reproducibility.
//
// Output shape: (b) stdout text — the CLI writes a single line via
// `process.stdout.write` and returns exit code 0. The fixture ships
// `input.json` (argv + env) and `expected.txt` (the recorded stdout line the
// Python source produced under identical argv). The test spies on
// `process.stdout.write`, invokes `main(argv)`, and asserts byte-for-byte
// equality against `expected.txt`. `sanitize-manifest.json` records zero
// replacements — the fixture uses synthetic space + tag ids and no real
// tokens or paths, nothing to scrub.
//
// The `--action=create --dry-run` path is chosen because it exercises the
// most cross-cutting surface in one invocation: argparse (`--action` /
// `--space-id` / `--tag-name` / `--dry-run` all parsed together), the
// deterministic colour picker (sha256("sec-02")[0] % 10 == 5, hitting the
// sky-blue palette slot), the DRY-RUN string wording, and the gate bypass
// (dry-run skips the TRP_ALLOW_REMOTE_MUTATE refusal). No token file is
// touched; no network is reached.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./tracker-tag-task.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"tracker-tag-task",
);

type Fixture = {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string>>;
};

// Rule 12 — surface both sides in JSON form so any invisible whitespace or
// Unicode difference (a smart quote around the tag name is the classic
// culprit) is legible in the failure log. Hoisted to module scope (rather
// than inlined in the test body) so the mismatch check isn't a conditional
// inside the `it()` callback.
function logParityMismatch(
	code: number,
	actual: string,
	expected: string,
	stderrText: string,
): void {
	if (actual === expected && code === 0 && stderrText.length === 0) {
		return;
	}
	// eslint-disable-next-line no-console
	console.error(
		`[parity:tracker-tag-task] code=${code} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} stderr=${JSON.stringify(stderrText)}`,
	);
}

describe("tracker-tag-task.ts — parity against Python source", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		// Fresh env each run so no stray CLICKUP_TEAM_ID / TRP_ALLOW_REMOTE_MUTATE
		// from the test runner changes the code path.
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	it("reproduces the recorded dry-run stdout byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(resolve(FIXTURE_DIR, "expected.txt"), "utf8");

		// Fully replace process.env so any stray operator env (real token file
		// paths, real team ids) can't alter the impl's control flow.
		process.env = { ...fixture.env };

		// Capture every `process.stdout.write` chunk in emission order. The impl
		// writes the whole line in a single call; concatenation still matches
		// the byte layout of expected.txt.
		const stdoutChunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
		// Fail loud (Rule 12) if any stderr slipped through — the parity
		// invocation is expected to be clean.
		const stderrChunks: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrChunks.push(String(chunk));
			return true;
		});

		const code = await main(fixture.argv);

		const actual = stdoutChunks.join("");
		logParityMismatch(code, actual, expected, stderrChunks.join(""));
		expect(code).toBe(0);
		expect(stderrChunks.join("")).toBe("");
		expect(actual).toBe(expected);
	});
});
