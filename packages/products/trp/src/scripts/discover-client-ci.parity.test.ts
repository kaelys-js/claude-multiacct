// Parity test for `discover-client-ci.ts` against the byte-for-byte fixture
// captured from `trp/scripts/discover-client-ci.py`.
//
// WHY it matters: discover-client-ci is the Stage F preparation step. The
// driver (`scripts/fix-task.sh`) shells to whichever executable is on PATH,
// and downstream — the workflow's Preflight phase and the driver's parallel
// cheap group — read the classified TSV plus the legacy `$OUT_PATH` command
// list. A drift between .py and .ts (a regex tweak, a filter ordering
// change, the wrapper short-circuit skipping a script it should keep) means
// the two runtimes discover different verifier sets, which shows up as a
// hallucinated CI failure or a silently-skipped gate depending on which
// language ran. A single-runtime test can't catch that.
//
// Output shape: (c) filesystem write. The observable oracle is the two
// files the script writes:
//   - `$OUT_PATH` — one discovered command per line, discovery order
//   - `discovery/<task-id-slug>-ci-commands.tsv` — the classified TSV
// Both are inspected here. `stdout` wording is NOT asserted — the driver
// does not grep script logs, and the two implementations already diverge
// on trivial punctuation (`WARN` prefix, log-line indentation) that would
// over-constrain the port without protecting any downstream reader.
//
// Comparator: snapshot the union of the two write targets into a sorted
// `{relpath: content}` map rooted at `workDir`, and diff against the
// same-shape snapshot of `expected-tree/`. Byte-for-byte on file content;
// a divergence in ordering, class assignment, source labels, or the TSV
// header surfaces here. sanitize-manifest.json is intentionally empty —
// the fixture uses a synthesized tempdir so nothing needs relaxation.
//
// Failure diagnostic: on mismatch we print the pretty-printed diff of the
// projected tree next to the expected. A driver-log reader inspecting the
// vitest failure sees exactly which output diverged (missing / extra /
// content diff) without having to re-derive the tree state from stdout.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./discover-client-ci.ts";

const HERE = import.meta.dirname;
const FIXTURE_DIR = resolve(HERE, "..", "..", "tests", "fixtures", "scripts", "discover-client-ci");

// Recursively snapshot a directory into a sorted `{relpath: content}` map.
// Matches the shape used by apply-bundle.parity.test.ts: only files, POSIX-
// shaped relpaths, UTF-8 bytes. Directories with no files vanish from the
// snapshot — a `discovery/` mkdir with no TSV would still fail parity when
// the expected snapshot names the TSV.
function snapshotTree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	function walk(dir: string): void {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const st = statSync(full);
			if (st.isDirectory()) {
				walk(full);
			} else if (st.isFile()) {
				const rel = relative(root, full);
				out[rel] = readFileSync(full, "utf8");
			}
		}
	}
	walk(root);
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(out).toSorted()) {
		sorted[k] = out[k] as string;
	}
	return sorted;
}

type Input = {
	readonly env: Readonly<Record<string, string>>;
	readonly tree: Readonly<Record<string, string>>;
};

// Materialize the synthesized fix-src from the fixture manifest. Path keys
// are POSIX-shaped; parent dirs are mkdirp'd on demand so the manifest
// stays flat (one key per file, no directory sentinels).
function materializeTree(root: string, tree: Readonly<Record<string, string>>): void {
	for (const [relPath, body] of Object.entries(tree)) {
		const abs = join(root, relPath);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, body);
	}
}

// Rule 12: fail loud. Print both sides so the vitest failure names the
// divergent path without a re-derivation from the log. Lives outside the
// `it()` block so the conditional doesn't trip vitest's no-conditional-in-test.
function logMismatch(actualStr: string, expectedStr: string): void {
	if (actualStr !== expectedStr) {
		// eslint-disable-next-line no-console
		console.error(`[discover-client-ci parity] actual:\n${actualStr}\n\nexpected:\n${expectedStr}`);
	}
}

describe("discover-client-ci — parity against trp/scripts/discover-client-ci.py", () => {
	let scratch: string;
	let fixSrc: string;
	let workDir: string;
	// Save + restore process.env / process.cwd. main() reads FIX_SRC, OUT_PATH,
	// TASK_ID_SLUG from env when config is omitted, and writes the classified
	// TSV under cwd. A leaked mutation would corrupt sibling tests.
	const savedEnv = {
		FIX_SRC: process.env["FIX_SRC"],
		OUT_PATH: process.env["OUT_PATH"],
		TASK_ID_SLUG: process.env["TASK_ID_SLUG"],
	};
	const savedCwd = process.cwd();

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "discover-client-ci-parity-"));
		fixSrc = join(scratch, "fix-src");
		workDir = join(scratch, "work");
		mkdirSync(fixSrc, { recursive: true });
		mkdirSync(workDir, { recursive: true });

		const input = JSON.parse(readFileSync(join(FIXTURE_DIR, "input.json"), "utf8")) as Input;
		materializeTree(fixSrc, input.tree);

		process.env["FIX_SRC"] = fixSrc;
		process.env["OUT_PATH"] = join(workDir, "out.txt");
		process.env["TASK_ID_SLUG"] = input.env["TASK_ID_SLUG"] ?? "default";
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(savedCwd);
		process.env["FIX_SRC"] = savedEnv.FIX_SRC;
		process.env["OUT_PATH"] = savedEnv.OUT_PATH;
		process.env["TASK_ID_SLUG"] = savedEnv.TASK_ID_SLUG;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("produces the recorded OUT_PATH + discovery TSV byte-for-byte", async () => {
		await main();

		const actual = snapshotTree(workDir);
		const expected = snapshotTree(join(FIXTURE_DIR, "expected-tree"));

		const actualStr = JSON.stringify(actual, null, 2);
		const expectedStr = JSON.stringify(expected, null, 2);

		logMismatch(actualStr, expectedStr);
		expect(actualStr).toBe(expectedStr);
	});
});
