// Unit tests for the QA-runner argv parser (packages/shared/utils/qa/src/parse-args.ts).
//
// Rule 9 — these assert WHY the parser matters: the lint/format entrypoints rely
// on it to distinguish the three run modes (whole-repo, `--only <id>`, staged
// file list) and the format `--check` flag. A parser that mis-split any of these
// would silently run the wrong tools over the wrong files, so each test pins one
// discrimination the entrypoints depend on.

import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/parse-args.ts";

describe("parseArgs", () => {
	it("returns the empty-flag default for no args (whole-repo pass)", () => {
		// No flags, no files: dispatch treats this as the whole-repo run.
		expect(parseArgs([])).toEqual({ check: false, only: null, files: [] });
	});

	it("recognises --check so format runs in verify mode", () => {
		// `--check` is the only signal that separates format-check from format-write;
		// a miss here would rewrite files during a CI verification pass.
		expect(parseArgs(["--check"])).toEqual({ check: true, only: null, files: [] });
	});

	it("captures --only <id> as the single-tool restriction", () => {
		// The per-tool turbo tasks pass `--only <id>`; the id must land in `only`,
		// not the positional file list, or the tool filter would select nothing.
		expect(parseArgs(["--only", "oxlint"])).toEqual({
			check: false,
			only: "oxlint",
			files: [],
		});
	});

	it("treats residual positionals as staged file paths", () => {
		// lefthook passes staged paths positionally; they must all reach `files`
		// (order preserved) so the staged subset is what gets linted.
		expect(parseArgs(["a.ts", "b/c.md"])).toEqual({
			check: false,
			only: null,
			files: ["a.ts", "b/c.md"],
		});
	});

	it("combines --check, --only and files in one argv", () => {
		// A realistic mixed invocation: flags in any position must not swallow the
		// trailing file paths, and vice versa.
		expect(parseArgs(["--check", "--only", "taplo", "x.toml", "y.toml"])).toEqual({
			check: true,
			only: "taplo",
			files: ["x.toml", "y.toml"],
		});
	});

	it("yields only=null when --only is the final arg with no value", () => {
		// A dangling `--only` (no following id) must degrade to the all-tools run
		// rather than crash or capture a phantom id — `argv[i] ?? null` covers this.
		expect(parseArgs(["--only"])).toEqual({ check: false, only: null, files: [] });
	});

	it("keeps a file that follows --check without a leading flag", () => {
		// Guards the `arg !== undefined` positional branch after a recognised flag.
		expect(parseArgs(["--check", "only-a-file.ts"])).toEqual({
			check: true,
			only: null,
			files: ["only-a-file.ts"],
		});
	});

	it("skips a hole in the argv (undefined slot) without pushing it as a file", () => {
		// `noUncheckedIndexedAccess` types argv[i] as `string | undefined`; the
		// `arg !== undefined` guard exists so a sparse slot is dropped, not pushed as
		// a phantom "undefined" file path. A sparse array reads `undefined` at the
		// hole, exercising that guard's false branch.
		const sparse: string[] = ["a.ts"];
		sparse[2] = "b.ts"; // leaves index 1 as a hole → argv[1] === undefined
		expect(parseArgs(sparse)).toEqual({ check: false, only: null, files: ["a.ts", "b.ts"] });
	});
});
