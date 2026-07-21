// Parity test for `apply-bundle.ts` against the byte-for-byte fixture captured
// from `trp/scripts/apply-bundle.py`.
//
// WHY it matters: `apply-bundle` is the driver stage that turns a workflow's
// bundle into files on disk under $FIX_SRC. The TS port ships as a
// `@foundation/shell` consumer; the driver (`scripts/fix-task.sh`) shells to
// whichever executable is on PATH. A drift in the full-content fast path
// (Path Y in the source's comments) means the driver silently ships different
// bytes to the client PR depending on which language ran — a bug that never
// surfaces in a single-runtime test.
//
// Output shape: (c) filesystem write. The observable oracle is the tree the
// script writes under $FIX_SRC. Both `stdout` and the `discovery/patches/*`
// side-effect file are inspected in this run but neither is asserted on:
// - stdout wording is not part of the driver contract (fix-task.sh does not
//   grep it) and both scripts already diverge on the leading whitespace of
//   log lines when path names change. Locking it byte-for-byte would over-
//   constrain the port.
// - `discovery/patches/<slug>.patch` is not written on the Path Y fast path
//   this fixture exercises. A separate parity fixture can cover the patch-
//   mode branch when the git/patch binaries become available in CI; the
//   current fixture stays hermetic so it runs without either.
//
// Comparator: snapshot the resulting $FIX_SRC tree into a `{relpath: content}`
// map, sort keys, and compare to `expected-tree.json`. Byte-for-byte on file
// content; a divergence in `full_content` write, mkdirp behaviour, or the
// SRP-GG test_additions fold surfaces here.
//
// Failure diagnostic: on mismatch we print the pretty-printed diff of the
// projected tree next to the expected. A driver-log reader inspecting the
// vitest failure sees exactly which path drifted (missing / extra / content
// diff) without having to re-derive the tree state from the log.

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
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./apply-bundle.ts";

const HERE = import.meta.dirname;
const FIXTURE_DIR = resolve(HERE, "..", "..", "tests", "fixtures", "scripts", "apply-bundle");

// Recursively snapshot a directory into a sorted `{relpath: content}` map.
// Mirrors the Python fixture generator's `snapshot_tree` byte-for-byte:
// - only files, no directory entries
// - POSIX-shaped relative paths (join uses `/` on darwin/linux; Windows CI
//   would need `.replaceAll(sep, '/')` but this repo runs on POSIX only)
// - reads bytes as UTF-8, same encoding the script wrote them in
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
	// Return a key-sorted view so JSON.stringify emits deterministic bytes.
	const sorted: Record<string, string> = {};
	for (const k of Object.keys(out).toSorted()) {
		sorted[k] = out[k] as string;
	}
	return sorted;
}

// Failure diagnostic (Rule 12: fail loud). Prints both sides so a driver-log
// reader sees exactly which relpath drifted and by how much without diffing
// the fixture by hand. Lives outside `it()`: vitest/no-conditional-in-test
// flags an `if` written directly inside a test callback.
function logDiffOnMismatch(actualStr: string, expectedStr: string): void {
	if (actualStr !== expectedStr) {
		// eslint-disable-next-line no-console
		console.error(`[apply-bundle parity] actual:\n${actualStr}\n\nexpected:\n${expectedStr}`);
	}
}

describe("apply-bundle — parity against trp/scripts/apply-bundle.py", () => {
	let scratch: string;
	let fixSrc: string;
	let workDir: string;
	// Save and restore process.env / process.cwd — the script reads BUNDLE_JSON,
	// FIX_SRC, TASK_ID_SLUG from env and writes discovery/patches relative to
	// cwd. A leaked mutation would corrupt sibling tests.
	const savedEnv = {
		BUNDLE_JSON: process.env["BUNDLE_JSON"],
		FIX_SRC: process.env["FIX_SRC"],
		TASK_ID_SLUG: process.env["TASK_ID_SLUG"],
	};
	const savedCwd = process.cwd();

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "apply-bundle-parity-"));
		fixSrc = join(scratch, "fix-src");
		workDir = join(scratch, "workdir");
		mkdirSync(fixSrc, { recursive: true });
		mkdirSync(workDir, { recursive: true });
		// Copy the fixture bundle into the scratch so the script's read path
		// is isolated from the tests/ tree (a bug that wrote back to
		// $BUNDLE_JSON would silently corrupt the fixture in-place).
		const bundleSrc = readFileSync(join(FIXTURE_DIR, "input.json"), "utf8");
		const bundleCopy = join(scratch, "bundle.json");
		writeFileSync(bundleCopy, bundleSrc);

		process.env["BUNDLE_JSON"] = bundleCopy;
		process.env["FIX_SRC"] = fixSrc;
		process.env["TASK_ID_SLUG"] = "parity-fixture-01";
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(savedCwd);
		process.env["BUNDLE_JSON"] = savedEnv.BUNDLE_JSON;
		process.env["FIX_SRC"] = savedEnv.FIX_SRC;
		process.env["TASK_ID_SLUG"] = savedEnv.TASK_ID_SLUG;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("produces the recorded $FIX_SRC tree byte-for-byte", async () => {
		const rc = await main();
		expect(rc).toBe(0);

		const actual = snapshotTree(fixSrc);
		const expected = JSON.parse(
			readFileSync(join(FIXTURE_DIR, "expected-tree.json"), "utf8"),
		) as Record<string, string>;

		const actualStr = JSON.stringify(actual, null, 2);
		const expectedStr = JSON.stringify(expected, null, 2);

		logDiffOnMismatch(actualStr, expectedStr);
		expect(actualStr).toBe(expectedStr);
	});
});
