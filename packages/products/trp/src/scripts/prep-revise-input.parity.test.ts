// Parity test for `prep-revise-input.ts` against a fixture pair captured from
// the Python source at `security-pocs/repos/trp/scripts/prep-revise-input.py`.
//
// WHY it matters: the TS port is a byte-for-byte re-implementation. The
// driver's REVISE loop pipes this script's stdout straight into the
// Workflow() args object — every field name, every truncation length, every
// character of the `revise_directive` string (Python list-repr with
// single-quoted ids and Unicode em-dash) has to match, or the workflow
// silently sees a different prompt and either drops the gap directive or
// blows the prompt budget. The unit tests exercise individual helpers; this
// pins the whole `main()` glue against an output the Python source actually
// produced under the same input tree.
//
// Output shape: (b) stdout text — a single JSON blob written by
// `process.stdout.write(JSON.stringify(base))`. The fixture ships
// `input.json` (a manifest describing the files that must be staged under
// `discovery/`, plus env vars) and `expected.txt` (the recorded stdout, one
// long JSON line). The test stages the three JSONs into a scratch dir,
// chdir's into it so the impl's cwd-relative reads land on them, spies on
// `process.stdout.write` to capture what `main()` emits, and asserts
// byte-for-byte equality against `expected.txt`. `sanitize-manifest.json`
// records zero replacements — the fixture uses synthetic ids and repeated
// characters, nothing to scrub.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./prep-revise-input.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"scripts",
	"prep-revise-input",
);

type Fixture = {
	readonly task_id_slug: string;
	readonly fail_json_relpath: string;
	readonly fail_json_body: unknown;
	readonly input_json_relpath: string;
	readonly input_json_body: unknown;
	readonly bundle_json_relpath: string;
	readonly bundle_json_body: unknown;
	readonly env: Readonly<Record<string, string>>;
};

// Rule 12 — fail loud. Print both sides in JSON form so any invisible
// whitespace or Unicode difference (the em-dash in `revise_directive` is a
// common culprit) is legible in the failure log. Lives outside the `it()`
// block so the conditional doesn't trip vitest's no-conditional-in-test.
function logMismatch(actual: string, expected: string): void {
	if (actual !== expected) {
		// eslint-disable-next-line no-console
		console.error(
			`[parity:prep-revise-input] actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
		);
	}
}

describe("prep-revise-input.ts — parity against Python source", () => {
	let scratch: string;
	let priorCwd: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "prep-revise-input-parity-"));
		priorCwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(priorCwd);
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("reproduces the recorded stdout byte-for-byte", async () => {
		const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Fixture;
		const expected = readFileSync(join(FIXTURE_DIR, "expected.txt"), "utf8");

		// Stage each JSON at its recorded relpath under `scratch/discovery/`
		// so the impl's cwd-relative reads (`discovery/trp-input-...json`,
		// `discovery/trp-bundle-...json`, `discovery/trp-fail-...json`) land
		// on the same bytes the Python source read.
		for (const [relpath, body] of [
			[fixture.fail_json_relpath, fixture.fail_json_body] as const,
			[fixture.input_json_relpath, fixture.input_json_body] as const,
			[fixture.bundle_json_relpath, fixture.bundle_json_body] as const,
		]) {
			const abs = join(scratch, relpath);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, JSON.stringify(body));
		}

		// The impl reads `discovery/…` off the cwd, so chdir into the scratch
		// tree rather than threading a base path through the module.
		process.chdir(scratch);

		// Fully replace process.env so no stray REPO_SLUG from the runner
		// changes the pattern-search order.
		process.env = { ...fixture.env };

		// Capture every `process.stdout.write` chunk in emission order. The
		// impl writes the whole JSON blob in a single call; concatenation
		// still matches the byte layout of expected.txt.
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
