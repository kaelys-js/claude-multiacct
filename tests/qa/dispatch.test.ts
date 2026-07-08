// Tests for the QA dispatcher (scripts/qa/dispatch.ts).
//
// Two layers:
//  1. The PURE selection/expansion helpers (selectByExt / selectByRegex /
//     expandArgv) — asserted directly against inputs.
//  2. The IO `run()` orchestrator — driven with real subprocess execution. To
//     control ROOT and the candidate file set deterministically, the run() tests
//     chdir into a throwaway git fixture and re-import dispatch fresh (its ROOT is
//     captured at import from `git rev-parse`). The fixture ships a stub
//     `bin/mise` so the mise wrapper is exercised for real: a stub that exits 0
//     makes a tool "pass", one that exits 1 makes it "fail" — that is how the
//     exit-code aggregation and the wholeRepoOnly / project / fullRepoDot branches
//     are pinned.
//
// Rule 9 — these encode WHY dispatch matters: it decides WHICH files each tool
// sees and WHETHER the run as a whole passes. A regression in file selection
// would lint the wrong set; a regression in aggregation would report green while
// a tool failed. Each test fixes one of those guarantees.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectByExt, selectByRegex, expandArgv } from "../../scripts/qa/dispatch.ts";
import type * as DispatchModule from "../../scripts/qa/dispatch.ts";
import { FILES } from "../../scripts/qa/registry.ts";

// ── pure helpers ─────────────────────────────────────────────────────

describe("selectByExt", () => {
	it("keeps files whose extension is in the allowed set, case-insensitively", () => {
		// Tools are matched by extension; the case-fold is why a `.TS` or `.JsX`
		// file is still linted rather than silently skipped.
		const files = ["a.ts", "b.TSX", "c.md", "d.JSON", "noext", "e.tsx"];
		expect(selectByExt(files, ["ts", "tsx", "json"])).toEqual(["a.ts", "b.TSX", "d.JSON", "e.tsx"]);
	});

	it("returns nothing for a file with no dot", () => {
		expect(selectByExt(["Makefile"], ["ts"])).toEqual([]);
	});

	it("does not treat a leading-dot dotfile as an extension", () => {
		// `.gitignore` has its dot at index 0; `slice(dot+1)` would be "gitignore",
		// which must only match if "gitignore" is literally an allowed ext.
		expect(selectByExt([".gitignore"], ["gitignore"])).toEqual([".gitignore"]);
		expect(selectByExt([".gitignore"], ["ts"])).toEqual([]);
	});
});

describe("selectByRegex", () => {
	it("keeps only paths matching the pattern", () => {
		const files = ["a.schema.json", "b.json", "nested/c.schema.json"];
		expect(selectByRegex(files, String.raw`\.schema\.json$`)).toEqual([
			"a.schema.json",
			"nested/c.schema.json",
		]);
	});

	it("matches case-insensitively (the 'i' flag)", () => {
		expect(selectByRegex(["REUSE.toml"], String.raw`reuse\.toml$`)).toEqual(["REUSE.toml"]);
	});
});

describe("expandArgv", () => {
	it("substitutes the FILES token with the file list", () => {
		expect(
			expandArgv(["oxlint", FILES], ["a.ts", "b.ts"], { wholeRepo: false, fullRepoDot: false }),
		).toEqual(["oxlint", "a.ts", "b.ts"]);
	});

	it("substitutes '.' for the files in whole-repo + fullRepoDot mode", () => {
		// oxlint/oxfmt scan the whole tree via "." in a whole-repo pass; this is the
		// branch that keeps them from being handed thousands of explicit paths.
		expect(
			expandArgv(["oxlint", FILES], ["a.ts", "b.ts"], { wholeRepo: true, fullRepoDot: true }),
		).toEqual(["oxlint", "."]);
	});

	it("keeps the file list when whole-repo but not fullRepoDot", () => {
		expect(
			expandArgv(["yamllint", FILES], ["a.yaml"], { wholeRepo: true, fullRepoDot: false }),
		).toEqual(["yamllint", "a.yaml"]);
	});

	it("leaves non-FILES args untouched and only replaces the token", () => {
		expect(
			expandArgv(["taplo", "fmt", "--check", FILES], ["x.toml"], {
				wholeRepo: false,
				fullRepoDot: false,
			}),
		).toEqual(["taplo", "fmt", "--check", "x.toml"]);
	});
});

// ── IO orchestrator: run() against a git fixture ─────────────────────

// A stub `bin/mise` that records nothing and exits with a fixed code. Real
// subprocess execution through spawnSync, so the mise() wrapper lines run.
function writeMiseStub(root: string, exitCode: number): void {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const mise = join(bin, "mise");
	// Exit `exitCode` regardless of args, so a tool invocation deterministically
	// passes (0) or fails (non-0).
	writeFileSync(mise, `#!/bin/sh\nexit ${String(exitCode)}\n`);
	chmodSync(mise, 0o755);
}

type FixtureFile = { path: string; content: string };

function makeFixtureRepo(files: readonly FixtureFile[], miseExit: number): string {
	const dir = mkdtempSync(join(tmpdir(), "dispatch-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	for (const f of files) {
		const full = join(dir, f.path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, f.content);
	}
	writeMiseStub(dir, miseExit);
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}

// Import a FRESH dispatch bound to `root` as its ROOT (captured at import).
async function importDispatch(root: string): Promise<typeof DispatchModule> {
	process.chdir(root);
	vi.resetModules();
	return await import("../../scripts/qa/dispatch.ts");
}

describe("run() — IO orchestration", () => {
	const orig = process.cwd();
	const repos: string[] = [];

	beforeEach(() => {
		// Silence the note()/hygiene stdout so test output stays readable.
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		process.chdir(orig);
		vi.restoreAllMocks();
		vi.resetModules();
		while (repos.length > 0) {
			const r = repos.pop();
			if (r !== undefined) {
				rmSync(r, { recursive: true, force: true });
			}
		}
	});

	function fixture(files: readonly FixtureFile[], miseExit: number): string {
		const dir = makeFixtureRepo(files, miseExit);
		repos.push(dir);
		return dir;
	}

	it("passes when the selected tool's mise invocation exits 0 (ext selection)", async () => {
		// A staged .ts file selects oxlint; the stub mise exits 0, so run() is true.
		const root = fixture([{ path: "a.ts", content: "const x = 1;\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], "oxlint")).toBe(true);
	});

	it("fails when the selected tool's mise invocation exits non-zero", async () => {
		// Same selection, stub mise exits 1: the failure must propagate to run()=false.
		const root = fixture([{ path: "a.ts", content: "const x = 1;\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], "oxlint")).toBe(false);
	});

	it("skips a tool when no candidate file matches its extension", async () => {
		// A staged .md file does not match oxlint's ext set → selectFiles empty →
		// the tool is a no-op (returns null), so run() stays true (nothing failed).
		const root = fixture([{ path: "a.md", content: "# hi\n" }], 1);
		const { run } = await importDispatch(root);
		// mise exits 1, but oxlint should never be invoked (no matching files).
		expect(run("lint", ["a.md"], "oxlint")).toBe(true);
	});

	it("aggregates: a passing tool and a failing hygiene guard yield false", async () => {
		// Hygiene (merge markers) runs alongside tools when only===null. A staged
		// file carrying a conflict marker makes hygiene fail even though oxlint would
		// pass — proving run() ANDs every outcome, not just the last.
		const root = fixture([{ path: "a.ts", content: "const x = 1;\n<<<<<<< HEAD\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], null)).toBe(false);
	});

	it("runs the merge-marker hygiene guard in isolation via --only hygiene", async () => {
		const root = fixture([{ path: "clean.ts", content: "ok\n" }], 0);
		const { run } = await importDispatch(root);
		// Clean file, hygiene-only: passes.
		expect(run("lint", ["clean.ts"], "hygiene")).toBe(true);
	});

	it("flags an oversized file (>1 MiB) in the large-file hygiene guard", async () => {
		// The large-file guard is the other half of hygiene; a >1 MiB staged file
		// must fail it. Content is generated, not committed as a real blob.
		const big = "x".repeat(1_048_576 + 1);
		const root = fixture([{ path: "big.bin", content: big }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["big.bin"], "hygiene")).toBe(false);
	});

	it("tolerates a staged path that does not exist on disk (hygiene read guard)", async () => {
		// candidateFiles trusts the staged list; a path that was deleted must be
		// skipped by the try/catch guards, not crash the run.
		const root = fixture([{ path: "real.ts", content: "ok\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["ghost.ts"], "hygiene")).toBe(true);
	});

	it("runs a project-mode tool gated on ≥1 matched file (typescript)", async () => {
		// typescript is mode:"project" — it runs its argv verbatim (no FILES) once a
		// single .ts file matches. Stub mise exits 0 → pass.
		const root = fixture([{ path: "a.ts", content: "const x = 1;\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], "typescript")).toBe(true);
	});

	it("skips a project-mode tool when no file matches (staged run touched none)", async () => {
		// No .ts staged → typescript's gate (≥1 matched file) fails → it is skipped,
		// so run() stays true. This is the staged-run skip the registry comment cites.
		const root = fixture([{ path: "a.md", content: "# hi\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.md"], "typescript")).toBe(true);
	});

	it("skips a wholeRepoOnly tool in staged mode", async () => {
		// `schema` is wholeRepoOnly; in staged mode (staged !== null) it is filtered
		// out, so even with mise exiting 1 the run does not fail on it.
		const root = fixture([{ path: "package.json", content: "{}\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", ["package.json"], "schema")).toBe(true);
	});

	it("runs a wholeRepoOnly tool in whole-repo mode (staged === null)", async () => {
		// In a whole-repo pass, `schema` is NOT filtered out; it runs and fails when
		// mise exits 1 — the complement of the staged-skip above.
		const root = fixture([{ path: "package.json", content: "{}\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", null, "schema")).toBe(false);
	});

	it("runs a staged-aware tool with its staged argv in staged mode (gitleaks)", async () => {
		// gitleaks selects ALL candidates (secrets kind) and uses its stagedArgv in
		// staged mode; stub mise exits 0 → pass.
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], "gitleaks")).toBe(true);
	});

	it("uses the whole-repo (fullArgv) branch for a staged-aware tool in whole-repo mode", async () => {
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", null, "gitleaks")).toBe(false);
	});

	it("runs format-write over matched files (oxfmt)", async () => {
		// mode:"format-write" exercises runFormat's write template with fullRepoDot
		// resolution; stub mise exits 0.
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("format-write", ["a.ts"], "oxfmt")).toBe(true);
	});

	it("runs format-check and propagates a formatter failure", async () => {
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("format-check", ["a.ts"], "oxfmt")).toBe(false);
	});

	it("uses the fullRepoDot '.' branch for oxfmt in a whole-repo format pass", async () => {
		// Whole-repo (staged===null) + oxfmt.fullRepoDot=true → expandArgv yields "."
		// This drives the wholeRepo && fullRepoDot arm of runFormat.
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 0);
		const { run } = await importDispatch(root);
		expect(run("format-write", null, "oxfmt")).toBe(true);
	});

	it("skips a format-only run when no file matches the formatter", async () => {
		// oxfmt's ext set excludes .bin; selectFiles empty → runFormat returns null →
		// nothing fails. Guards the `files.length === 0` early return in runFormat.
		const root = fixture([{ path: "a.bin", content: "ok\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("format-write", ["a.bin"], "oxfmt")).toBe(true);
	});

	it("returns null (skips) a lint on a tool with no lint command in format mode selection", async () => {
		// `--only oxfmt` in LINT mode: oxfmt has no `lint`, so runLint returns null
		// (the `if (!lint) return null` guard) and the run stays true.
		const root = fixture([{ path: "a.ts", content: "ok\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("lint", ["a.ts"], "oxfmt")).toBe(true);
	});

	it("returns null (skips) a format on a lint-only tool", async () => {
		// `--only yamllint` in FORMAT mode: yamllint has no `format`, so runFormat's
		// `if (!format) return null` guard skips it.
		const root = fixture([{ path: "a.yaml", content: "a: 1\n" }], 1);
		const { run } = await importDispatch(root);
		expect(run("format-write", ["a.yaml"], "yamllint")).toBe(true);
	});
});
