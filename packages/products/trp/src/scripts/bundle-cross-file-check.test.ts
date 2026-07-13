// Behavior tests for `bundle-cross-file-check.ts` (SRP-V). The TS port of the
// python original is a pure function of BUNDLE_JSON + TASK_ID_SLUG env vars +
// the working directory (the report gets written under `discovery/`), so every
// test writes a synthetic bundle to a scratch dir, chdirs there, sets the two
// env vars, then invokes `main()` in-process. Stdout/stderr writes are spied
// so per-test buffers capture the exact operator-visible output, and the
// return code + on-disk report are asserted for structural findings.
//
// WHY it matters: this checker is Stage F's pre-flight for semantic
// inconsistencies lint can't see (mismatched env-var defaults across
// setupFiles + globalSetup, drifted top-level constants, forked import
// paths). If a HIGH finding stops firing silently, the SRP-J revise loop
// never runs and a broken fix lands on the client PR. These tests fix the
// contract on every regex branch, every severity mapping, and every exit
// code path so a byte-shift in the regex or the exit-code arithmetic trips.
//
// External calls: none — the impl uses only node:fs + node:path. No sh(),
// no fetch. Nothing to mock.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bundle-cross-file-check.ts";

const HERE = import.meta.dirname;
const TS_SCRIPT = resolve(HERE, "bundle-cross-file-check.ts");

// Minimal bundle shape the impl parses.
type BundleFile = {
	path: string;
	full_content?: string;
};

// Writes a bundle JSON to the scratch dir at the standard TASK_ID_SLUG-agnostic
// location the tests use, and returns its absolute path so the caller can set
// BUNDLE_JSON.
function writeBundle(dir: string, files: BundleFile[]): string {
	const bundlePath = join(dir, "bundle.json");
	writeFileSync(bundlePath, JSON.stringify({ files_to_modify: files }));
	return bundlePath;
}

// `process.env` with the given keys removed — used to spawn the child process
// without BUNDLE_JSON / TASK_ID_SLUG set. Lives outside `it()` blocks because
// vitest/no-conditional-in-test flags the `!==`/`&&` filter predicate when
// it's written inline inside a test callback.
function envWithout(...keys: readonly string[]): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !keys.includes(k)));
}

describe("bundle-cross-file-check", () => {
	let originalCwd: string;
	let scratchDir: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	function stdout(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}
	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	beforeEach(() => {
		originalCwd = process.cwd();
		for (const key of ["BUNDLE_JSON", "TASK_ID_SLUG"] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		scratchDir = mkdtempSync(join(tmpdir(), "bundle-cross-file-check-"));
		// The impl writes the structured report to `discovery/...`, so the CWD
		// needs that directory to exist.
		mkdirSync(join(scratchDir, "discovery"), { recursive: true });
		process.chdir(scratchDir);
		stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
		stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		process.chdir(originalCwd);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		try {
			rmSync(scratchDir, { recursive: true, force: true });
		} catch {
			// mkdtemp dirs get GC'd by the OS eventually.
		}
	});

	// ── argument / env handling ─────────────────────────────────────────
	describe("env-var handling", () => {
		it("throws when BUNDLE_JSON is unset", async () => {
			process.env.TASK_ID_SLUG = "slug";
			// Deliberately do NOT set BUNDLE_JSON. The impl's first branch throws.
			await expect(main()).rejects.toThrow("BUNDLE_JSON, TASK_ID_SLUG must both be set");
		});

		it("throws when TASK_ID_SLUG is unset", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, []);
			// TASK_ID_SLUG missing — same error message covers both.
			await expect(main()).rejects.toThrow("BUNDLE_JSON, TASK_ID_SLUG must both be set");
		});

		it("throws when both env vars are unset", async () => {
			await expect(main()).rejects.toThrow("BUNDLE_JSON, TASK_ID_SLUG must both be set");
		});

		it("propagates JSON.parse errors on a malformed bundle", async () => {
			const bundlePath = join(scratchDir, "bad.json");
			writeFileSync(bundlePath, "{not: valid json");
			process.env.BUNDLE_JSON = bundlePath;
			process.env.TASK_ID_SLUG = "slug";
			// The impl calls JSON.parse without a try/catch — malformed input
			// must surface as a SyntaxError to the caller, not be silently
			// swallowed into a PASS.
			await expect(main()).rejects.toThrow(SyntaxError);
		});
	});

	// ── empty / trivial inputs ──────────────────────────────────────────
	describe("empty and trivial bundles", () => {
		it("PASSes with return 0 on an empty files_to_modify array", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, []);
			process.env.TASK_ID_SLUG = "empty-slug";
			const code = await main();
			expect(code).toBe(0);
			// The PASS line is the load-bearing operator signal — a regression
			// that swaps in a different string trips this.
			expect(stdout()).toContain("cross-file check: PASS (no consistency issues)");
			// No report file on a PASS.
			expect(existsSync(join(scratchDir, "discovery", "bundle-cross-file-empty-slug.json"))).toBe(
				false,
			);
		});

		it("PASSes on a file with no full_content (undefined coerces to empty string)", async () => {
			// A files_to_modify entry with no full_content is legal in the schema;
			// the impl treats it as empty content via `?? ""`. That branch must
			// not throw and must not create phantom findings.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [{ path: "a.ts" }]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("PASSes on a single file that contains all three patterns consistently", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: 'process.env.FOO = "bar"\nconst BAZ = "quux"\nimport { X } from "./mod"',
				},
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// Same var in the same file cannot mismatch itself — every value
			// map has size 1. PASS.
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});
	});

	// ── env-var default mismatch (HIGH → exit 5) ───────────────────────
	describe("env-var default mismatches", () => {
		it("flags a plain assignment mismatch across two files as HIGH and exits 5", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "setup.ts", full_content: 'process.env.TOKEN = "aaa"' },
				{ path: "global.ts", full_content: 'process.env.TOKEN = "bbb"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(5);
			// Report gets written to disk with the structured finding.
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-slug.json");
			expect(existsSync(reportPath)).toBe(true);
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{
					kind: string;
					severity: string;
					summary: string;
					locations: Record<string, string[]>;
				}>;
			};
			expect(report.findings).toHaveLength(1);
			const finding = report.findings[0]!;
			expect(finding.kind).toBe("env-default-mismatch");
			expect(finding.severity).toBe("high");
			expect(finding.summary).toBe("env var TOKEN has different defaults across files");
			expect(finding.locations).toEqual({ aaa: ["setup.ts"], bbb: ["global.ts"] });
			// Stdout carries the summary line + a per-value in: block, both
			// upper-cased severity per the impl.
			const out = stdout();
			expect(out).toContain("[HIGH] env var TOKEN has different defaults across files");
			expect(out).toContain('"aaa" in: setup.ts');
			expect(out).toContain('"bbb" in: global.ts');
		});

		it("matches the ??= operator form", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.SECRET ??= "one"' },
				{ path: "b.ts", full_content: 'process.env.SECRET ??= "two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(5);
			expect(stdout()).toContain("[HIGH] env var SECRET");
		});

		it('matches the `= process.env.X ?? "default"` idiom via the backreference branch', async () => {
			// This branch requires the backreference `\1` in the regex — the var
			// name after `??` must match the one on the LHS. A regression that
			// drops the backreference would over-match unrelated env reads.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.API = process.env.API ?? "prod"' },
				{ path: "b.ts", full_content: 'process.env.API = process.env.API ?? "dev"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(5);
			expect(stdout()).toContain("[HIGH] env var API");
		});

		it("does NOT flag when both files agree on the same default", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.TOKEN = "same"' },
				{ path: "b.ts", full_content: 'process.env.TOKEN = "same"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// val_map has size 1; no finding.
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("does NOT match the backreference form when the referenced var differs", async () => {
			// process.env.FOO = process.env.BAR ?? "x" — the backreference \1
			// requires the `??` var to be FOO. A regression that drops \1
			// would falsely count this as a FOO default of "x".
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: 'process.env.FOO = process.env.BAR ?? "wrong"',
				},
				{ path: "b.ts", full_content: 'process.env.FOO = "right"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// Only file b matches; a's line doesn't match because BAR != FOO.
			// So env_values[FOO] has only { "right": [b] } → size 1 → no finding.
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("ignores env-var names that don't match [A-Z_][A-Z0-9_]* (lower-case skipped)", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.lowercase = "x"' },
				{ path: "b.ts", full_content: 'process.env.lowercase = "y"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// Lower-case name doesn't match [A-Z_][A-Z0-9_]*. No finding.
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("appends to an existing value list on repeated matches within one file (inner has-branch)", async () => {
			// Two matches for the same env var + same value inside ONE file
			// exercise the `if (!valMap.has(value))` false branch — the map
			// already has the value, so the second hit only appends to the
			// existing list.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: 'process.env.DUP = "same"\n// another line\nprocess.env.DUP = "same"',
				},
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// One value → no finding, but the append-branch fires internally.
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("collapses identical values to one entry with both file paths (locations grouping)", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.TOKEN = "aaa"' },
				{ path: "b.ts", full_content: 'process.env.TOKEN = "aaa"' },
				{ path: "c.ts", full_content: 'process.env.TOKEN = "bbb"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(5);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-slug.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{ locations: Record<string, string[]> }>;
			};
			// Two paths under "aaa", one under "bbb". Proves the append-into-list
			// behaviour groups by value, not by file.
			expect(report.findings[0]!.locations).toEqual({
				aaa: ["a.ts", "b.ts"],
				bbb: ["c.ts"],
			});
		});
	});

	// ── const-value mismatch (MEDIUM → exit 0) ─────────────────────────
	describe("top-level const mismatches", () => {
		it("flags a plain top-level const mismatch as MEDIUM and exits 0", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'const API_URL = "https://a.com"' },
				{ path: "b.ts", full_content: 'const API_URL = "https://b.com"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			// MEDIUM does NOT block. Exit 0.
			expect(code).toBe(0);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-slug.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{ kind: string; severity: string; summary: string }>;
			};
			expect(report.findings).toHaveLength(1);
			expect(report.findings[0]!.severity).toBe("medium");
			expect(report.findings[0]!.kind).toBe("const-value-mismatch");
			expect(report.findings[0]!.summary).toBe(
				"const API_URL has different string values across files",
			);
			expect(stdout()).toContain("[MEDIUM] const API_URL");
		});

		it("matches an `export const` prefix", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'export const TAG = "v1"' },
				{ path: "b.ts", full_content: 'export const TAG = "v2"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("[MEDIUM] const TAG");
		});

		it("does NOT match an indented const (must be at column 0 per ^ anchor + multiline flag)", async () => {
			// const at indent-0 in a and indented-4 in b — the `^` anchor with
			// the multiline flag requires column-0. Only file a matches; size-1
			// value map → no finding.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'const NAME = "top"' },
				{ path: "b.ts", full_content: '    const NAME = "indented"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("catches a const mismatch on the second line of a multi-line file (multiline flag)", async () => {
			// Two lines in one file; the second-line const still matches thanks
			// to the /m flag on CONST_PATTERN. Together with a differing value
			// in a second file, this trips the mismatch branch.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: '// header comment\nconst KEY = "first"',
				},
				{ path: "b.ts", full_content: 'const KEY = "second"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("[MEDIUM] const KEY");
		});
	});

	// ── import-path mismatch (LOW → exit 0) ────────────────────────────
	describe("import path mismatches", () => {
		it("flags LOW when the same named import comes from truly different paths", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import { helper } from "./utils"' },
				{ path: "b.ts", full_content: 'import { helper } from "../lib/other"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-slug.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{
					kind: string;
					severity: string;
					summary: string;
					locations: Record<string, string[]>;
				}>;
			};
			expect(report.findings).toHaveLength(1);
			expect(report.findings[0]!.kind).toBe("import-path-mismatch");
			expect(report.findings[0]!.severity).toBe("low");
			expect(report.findings[0]!.summary).toBe("helper imported from different paths across files");
			expect(report.findings[0]!.locations).toEqual({
				"./utils": ["a.ts"],
				"../lib/other": ["b.ts"],
			});
			expect(stdout()).toContain("[LOW] helper imported from different paths");
		});

		it("does NOT flag when the only difference is .js suffix + leading ./ vs bare (normalization)", async () => {
			// "./utils.js" and "utils" normalise to the same key after stripping
			// .js and leading ./. norm size 1 → skip finding.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import { helper } from "./utils.js"' },
				{ path: "b.ts", full_content: 'import { helper } from "utils"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("normalises leading ../ (all leading dots and slashes stripped)", async () => {
			// The impl's replace(/^[./u]+/) strips any run of leading . and /
			// characters, so "../a" and "./a" and "a" all collapse to key "a".
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "x.ts", full_content: 'import { foo } from "../mod"' },
				{ path: "y.ts", full_content: 'import { foo } from "./mod"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("does NOT flag a single-source import (size-1 path_map short-circuits)", async () => {
			// Two files importing helper from the same "./utils" — path_map has
			// size 1, no finding. Also exercises the norm-size-1 short-circuit
			// via the outer path_map.size > 1 guard.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import { helper } from "./utils"' },
				{ path: "b.ts", full_content: 'import { helper } from "./utils"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("splits a multi-name named-import list on comma-with-spaces", async () => {
			// import { a, b, c } from "..." — each name lands in importPaths.
			// A conflicting import of any one name from a different path fires.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import { alpha, beta, gamma } from "./mod-one"' },
				{ path: "b.ts", full_content: 'import { beta } from "./mod-two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			// Only beta appears in both, so exactly one finding.
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-slug.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{ summary: string }>;
			};
			expect(report.findings).toHaveLength(1);
			expect(report.findings[0]!.summary).toBe("beta imported from different paths across files");
		});

		it("handles named + default combined form: `import def, { named } from ...`", async () => {
			// The IMPORT_PATTERN third group (m[3]) captures the default binding
			// and m[4] captures the trailing named group. Both should be tracked.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import def, { named } from "./one"' },
				{ path: "b.ts", full_content: 'import def, { named } from "./two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			// The named import gets tracked from the m[4] branch (`?? m[4]`).
			// A finding for "named" fires because the two paths are different.
			expect(stdout()).toContain("[LOW] named imported from different paths");
		});

		it("strips an `as` alias to the source name in a named import", async () => {
			// `import { helper as h }` — the impl splits on " as " and keeps the
			// left side. Two files aliasing helper differently on both ends but
			// with different source paths still flag "helper" (not "h", not "j").
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import { helper as h } from "./one"' },
				{ path: "b.ts", full_content: 'import { helper as j } from "./two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("[LOW] helper imported from different paths");
		});

		it("handles `import * as ns from ...` (m[2] branch — no name tracked)", async () => {
			// Namespace imports set m[2] but leave m[1] and m[4] undefined, so
			// namesGroup collapses to "" and no name gets tracked. Two files
			// with different paths produce no finding.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import * as ns from "./one"' },
				{ path: "b.ts", full_content: 'import * as ns from "./two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});

		it("skips empty tokens in a name list without throwing (n === '' short-circuit)", async () => {
			// The impl continues when the trimmed token is empty. This shape
			// only matters for the `* as` and default-only branches, where
			// names_group is empty (no {...}) — a regression that indexed into
			// the first character of an empty string would trip it. Two default-
			// only imports of X from different paths — the impl's default-only
			// branch tracks the default binding via m[3].
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'import Def from "./one"' },
				{ path: "b.ts", full_content: 'import Def from "./two"' },
			]);
			process.env.TASK_ID_SLUG = "slug";
			// Impl gates namesGroup on m[1] ?? m[4]; m[3] (default-only) is NOT
			// picked up as a name. So this default-only import doesn't track
			// "Def" at all → no finding.
			const code = await main();
			expect(code).toBe(0);
			expect(stdout()).toContain("PASS");
		});
	});

	// ── multiple findings + exit-code arithmetic ───────────────────────
	describe("mixed severities", () => {
		it("reports MEDIUM + LOW without HIGH → exit 0, but still writes the report", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: 'const TAG = "v1"\nimport { helper } from "./one"',
				},
				{
					path: "b.ts",
					full_content: 'const TAG = "v2"\nimport { helper } from "./two"',
				},
			]);
			process.env.TASK_ID_SLUG = "mixed";
			const code = await main();
			// No HIGH → exit 0.
			expect(code).toBe(0);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-mixed.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{ severity: string; kind: string }>;
			};
			expect(report.findings).toHaveLength(2);
			const severities = report.findings.map((f) => f.severity).toSorted();
			expect(severities).toEqual(["low", "medium"]);
			// Header count line matches the number of findings.
			expect(stdout()).toContain("cross-file check: 2 finding(s) →");
		});

		it("reports HIGH alongside lesser findings → exit 5 (any HIGH blocks)", async () => {
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{
					path: "a.ts",
					full_content: 'process.env.SECRET = "one"\nconst TAG = "v1"',
				},
				{
					path: "b.ts",
					full_content: 'process.env.SECRET = "two"\nconst TAG = "v2"',
				},
			]);
			process.env.TASK_ID_SLUG = "combo";
			const code = await main();
			expect(code).toBe(5);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-combo.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{ severity: string }>;
			};
			// One HIGH + one MEDIUM, sorted by insertion order (HIGH first per
			// the impl's processing order).
			expect(report.findings.map((f) => f.severity)).toEqual(["high", "medium"]);
		});

		it("truncates long values in the stdout preview to the first 60 chars", async () => {
			// The impl slices value.slice(0, 60) in the per-value line. Feed a
			// 100-char value and assert the printed prefix is exactly 60 chars,
			// with the tail dropped.
			const longVal = "x".repeat(100);
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: `process.env.LONG = "${longVal}"` },
				{ path: "b.ts", full_content: `process.env.LONG = "different"` },
			]);
			process.env.TASK_ID_SLUG = "slug";
			await main();
			const out = stdout();
			// The 60-char prefix appears; the full 100-char value does not.
			expect(out).toContain(`"${"x".repeat(60)}"`);
			expect(out).not.toContain(`"${longVal}"`);
		});

		it("writes the report to the TASK_ID_SLUG-templated path exactly", async () => {
			// A regression that swapped the template string would still pass
			// most other tests. This one pins the exact filename shape so the
			// SRP-J loop's failure-JSON reader finds the report.
			process.env.BUNDLE_JSON = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.X = "1"' },
				{ path: "b.ts", full_content: 'process.env.X = "2"' },
			]);
			process.env.TASK_ID_SLUG = "task-123_slug";
			const code = await main();
			expect(code).toBe(5);
			expect(
				existsSync(join(scratchDir, "discovery", "bundle-cross-file-task-123_slug.json")),
			).toBe(true);
			// And the header line names the exact path.
			expect(stdout()).toContain("→ discovery/bundle-cross-file-task-123_slug.json");
		});
	});

	// ── CLI entrypoint (subprocess) ────────────────────────────────────
	// The impl's tail conditionally runs `main().then(...).catch(...)` when
	// invoked directly. These tests spawn `node <script>` in a child process
	// so the `if (invokedDirectly)` true branch, the `.then` success callback,
	// and the `.catch` failure callback each fire — none of which are reachable
	// from an import-based test.
	describe("CLI entrypoint via subprocess", () => {
		it("invoked directly with a valid bundle exits with the resolved code (0 on PASS)", () => {
			const bundlePath = writeBundle(scratchDir, []);
			const result = spawnSync(process.execPath, ["--experimental-strip-types", TS_SCRIPT], {
				cwd: scratchDir,
				env: {
					...process.env,
					BUNDLE_JSON: bundlePath,
					TASK_ID_SLUG: "cli-slug",
				},
				encoding: "utf8",
				timeout: 15_000,
			});
			expect(result.status).toBe(0);
			// The success path runs main().then((code) => process.exit(code)).
			// A PASS bundle prints the pass line.
			expect(result.stdout).toContain("cross-file check: PASS");
		});

		it("invoked directly on a HIGH finding exits 5 (the `.then` propagates the return code)", () => {
			const bundlePath = writeBundle(scratchDir, [
				{ path: "a.ts", full_content: 'process.env.X = "1"' },
				{ path: "b.ts", full_content: 'process.env.X = "2"' },
			]);
			const result = spawnSync(process.execPath, ["--experimental-strip-types", TS_SCRIPT], {
				cwd: scratchDir,
				env: {
					...process.env,
					BUNDLE_JSON: bundlePath,
					TASK_ID_SLUG: "cli-fail",
				},
				encoding: "utf8",
				timeout: 15_000,
			});
			// `.then((code) => process.exit(code))` maps the 5 return from main
			// to the child's exit status. A regression that swallowed the code
			// or returned 0 unconditionally trips this.
			expect(result.status).toBe(5);
			expect(result.stdout).toContain("[HIGH]");
		});

		it("invoked directly without env vars exits 1 via the `.catch` failure handler", () => {
			// The impl throws when BUNDLE_JSON / TASK_ID_SLUG are unset. The
			// `.catch` handler writes to stderr and exits 1. This is the ONLY
			// path that exercises the failure callback and the error-formatting
			// branch (`err instanceof Error ? err.stack ?? err.message : String(err)`).
			const result = spawnSync(process.execPath, ["--experimental-strip-types", TS_SCRIPT], {
				cwd: scratchDir,
				env: envWithout("BUNDLE_JSON", "TASK_ID_SLUG"),
				encoding: "utf8",
				timeout: 15_000,
			});
			expect(result.status).toBe(1);
			// The Error's stack (or fallback message) lands on stderr.
			expect(result.stderr).toContain("BUNDLE_JSON, TASK_ID_SLUG must both be set");
		});
	});

	// ── integration: the full main() story on a multi-file synthesized fixture ──
	describe("main() integration on a synthesized fixture", () => {
		it("processes a 3-file bundle with one finding per category and returns 5 (HIGH present)", async () => {
			// Fixture: three files that together stress every category. The
			// impl walks all three, aggregates findings from each layer, then
			// picks exit 5 because the env-var layer produced a HIGH.
			const bundle: BundleFile[] = [
				{
					path: "src/setup.ts",
					full_content: [
						"// setup file for tests",
						'process.env.TENANT_ID = "aaaa-bbbb"',
						'const TAG = "v1"',
						'import { verify } from "./verify"',
					].join("\n"),
				},
				{
					path: "src/global.ts",
					full_content: [
						"// global setup — differs from setup.ts",
						'process.env.TENANT_ID = "cccc-dddd"',
						'const TAG = "v2"',
						'import { verify } from "../lib/verify"',
					].join("\n"),
				},
				{
					// Bystander file that agrees with setup.ts on all axes — its
					// paths must land alongside setup.ts's under each locations
					// entry, not as their own value bucket.
					path: "src/agree.ts",
					full_content: [
						'process.env.TENANT_ID = "aaaa-bbbb"',
						'const TAG = "v1"',
						'import { verify } from "./verify"',
					].join("\n"),
				},
			];
			process.env.BUNDLE_JSON = writeBundle(scratchDir, bundle);
			process.env.TASK_ID_SLUG = "integration";
			const code = await main();
			expect(code).toBe(5);
			const reportPath = join(scratchDir, "discovery", "bundle-cross-file-integration.json");
			const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
				findings: Array<{
					kind: string;
					severity: string;
					summary: string;
					locations: Record<string, string[]>;
				}>;
			};
			// One finding per category, in impl order: env → const → import.
			expect(report.findings.map((f) => f.kind)).toEqual([
				"env-default-mismatch",
				"const-value-mismatch",
				"import-path-mismatch",
			]);
			expect(report.findings.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
			// setup.ts and agree.ts share every value; global.ts stands alone.
			expect(report.findings[0]!.locations).toEqual({
				"aaaa-bbbb": ["src/setup.ts", "src/agree.ts"],
				"cccc-dddd": ["src/global.ts"],
			});
			expect(report.findings[1]!.locations).toEqual({
				v1: ["src/setup.ts", "src/agree.ts"],
				v2: ["src/global.ts"],
			});
			expect(report.findings[2]!.locations).toEqual({
				"./verify": ["src/setup.ts", "src/agree.ts"],
				"../lib/verify": ["src/global.ts"],
			});
			// Stdout carries the per-severity summary lines in the same order.
			const out = stdout();
			const highIdx = out.indexOf("[HIGH]");
			const medIdx = out.indexOf("[MEDIUM]");
			const lowIdx = out.indexOf("[LOW]");
			expect(highIdx).toBeGreaterThan(-1);
			expect(medIdx).toBeGreaterThan(highIdx);
			expect(lowIdx).toBeGreaterThan(medIdx);
			// Nothing lands on stderr — the impl uses stdout for everything.
			expect(stderr()).toBe("");
		});
	});
});
