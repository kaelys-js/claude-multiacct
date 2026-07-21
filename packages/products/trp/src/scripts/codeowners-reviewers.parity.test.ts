// Parity test for `codeowners-reviewers.ts` against a fixture pair captured
// from the Python source at
// `security-pocs/repos/trp/scripts/codeowners-reviewers.py`.
//
// WHY it matters: the TS port is a byte-for-byte re-implementation; the
// downstream driver feeds its stdout straight into
// `gh pr edit --add-reviewer`. A silent divergence in glob translation, the
// last-matching-rule pass, or the team-owner filter reroutes a security PR to
// the wrong humans. The other test file pins individual helpers; this one
// pins the whole `main()` glue against an output the Python source actually
// produced, so a refactor that keeps unit tests green but breaks the end-to-
// end stdout still trips the gate.
//
// Output shape: (b) stdout text — one `@`-prefixed reviewer per line. The
// fixture ships `input.json` (CODEOWNERS text + bundle) and `expected.txt`
// (recorded stdout). The test stages the CODEOWNERS into a temp `FIX_SRC`
// tree, writes the bundle to a temp file, spies on `process.stdout.write` to
// capture what `main()` emits, and asserts byte-for-byte equality against
// `expected.txt`. `sanitize-manifest.json` records the applied replacement
// counts — zero across the board here because every string in the fixture
// fits under the sanitize threshold.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./codeowners-reviewers.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"codeowners-reviewers",
);

type Fixture = {
	readonly codeowners_relpath: string;
	readonly codeowners_text: string;
	readonly bundle: { readonly files_to_modify: ReadonlyArray<{ readonly path: string }> };
};

// Rule 12 — fail loud. Print both sides in JSON form so any invisible
// whitespace difference is legible in the failure log. Lives outside the
// `it()` block so the conditional doesn't trip vitest's no-conditional-in-test.
function logMismatch(actual: string, expected: string): void {
	if (actual !== expected) {
		// eslint-disable-next-line no-console
		console.error(
			`[parity:codeowners-reviewers] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
		);
	}
}

describe("codeowners-reviewers.ts — parity against Python source", () => {
	let scratch: string;
	let bundlePath: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "codeowners-reviewers-parity-"));
		bundlePath = join(scratch, "bundle.json");
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("reproduces the recorded stdout byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(join(FIXTURE_DIR, "expected.txt"), "utf8");

		// Stage the CODEOWNERS file at the recorded relpath so `main()` walks
		// its search order and lands on the same file the Python source did.
		const coPath = join(scratch, fixture.codeowners_relpath);
		mkdirSync(dirname(coPath), { recursive: true });
		writeFileSync(coPath, fixture.codeowners_text);

		writeFileSync(bundlePath, JSON.stringify(fixture.bundle));

		process.env.FIX_SRC = scratch;
		process.env.BUNDLE_JSON = bundlePath;

		// Capture every `process.stdout.write` chunk in emission order. The
		// impl writes one owner per call ending in `\n`; concatenation
		// preserves that order and matches the byte layout of expected.txt.
		const chunks: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			chunks.push(String(chunk));
			return true;
		});

		await expect(main()).resolves.toBe(0);

		const actual = chunks.join("");
		logMismatch(actual, expected);
		expect(actual).toBe(expected);
	});
});
