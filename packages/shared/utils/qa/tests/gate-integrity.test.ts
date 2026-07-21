// Meta-tests for the QA gates themselves: lint, format, schema-check, coverage.
//
// Every other test in this suite proves a gate does the right thing on a KNOWN
// input. This file proves the gates still FAIL CLOSED — that each one exits
// non-zero when handed a genuine violation, and exits zero on a clean control.
// A gate that always passes (a mis-wired exit code, a swallowed child status, a
// threshold that never bites) is worse than no gate: it turns every downstream
// green into a lie. Rule 9 — the guarantee under test is the discrimination
// itself, so each gate is exercised twice, once red and once green, and a
// same-shaped pair that both passed would mean the gate stopped discriminating.
//
// The lint/format/schema gates are their real entrypoints (src/lint.ts,
// src/format.ts, src/schema-check.ts), imported fresh inside a throwaway git
// fixture the way schema-check.test.ts drives schema-check: a stub `bin/mise`
// forwards `exec -- <tool>` to the REAL tool on PATH, so oxlint/oxfmt/
// check-jsonschema run for real, not mocked. The coverage gate is vitest's own
// per-file threshold exit code, which no in-process import can reproduce — it
// only exists in a full `vitest run --coverage` — so that one forks a real child
// vitest against a fixture project and asserts the child's exit code.

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real repo root, captured ONCE before any test chdirs into a fixture. The
// coverage child and the config copies below are read from here.
const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

// A stub `bin/mise` that drops the leading `exec --` and execs the rest, so a
// gate's `bin/mise exec -- <tool> …` reaches the real tool on PATH (identical to
// schema-check.test.ts). Inside `pnpm run qa:gates` that PATH is mise's, so
// oxlint / oxfmt / check-jsonschema are all present.
const MISE_STUB = '#!/bin/sh\n# args: exec -- <cmd...>\nshift 2\nexec "$@"\n';

// A minimal draft-07 schema requiring an integer `n`; the green schema fixture
// declares and satisfies it. check-jsonschema resolves draft-07 from its bundled
// metaschemas, so this validates offline.
const SCHEMA = JSON.stringify({
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "object",
	properties: { n: { type: "integer" } },
	required: ["n"],
});

type FixtureFile = { readonly path: string; readonly content: string };

// A throwaway git repo carrying a `bin/mise` stub plus the given files, committed
// so `git ls-files`-based discovery sees them. Mirrors schema-check.test.ts.
function makeFixture(files: readonly FixtureFile[]): string {
	const dir = mkdtempSync(join(tmpdir(), "gate-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "bin", "mise"), MISE_STUB);
	chmodSync(join(dir, "bin", "mise"), 0o755);
	for (const f of files) {
		const full = join(dir, f.path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, f.content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}

// The authoritative tool config a fixture needs so oxlint / oxfmt run with the
// same rules as the repo (not their built-in defaults), read from source so the
// fixture never drifts from the real config.
function repoConfig(rel: string): FixtureFile {
	return { path: rel, content: readFileSync(join(REPO_ROOT, rel), "utf8") };
}

// Run a gate entrypoint (lint.ts / format.ts / schema-check.ts) exactly as the
// hook would: chdir into the fixture so its git root is discovered, set argv,
// import the module FRESH so its top-level `process.exit(...)` fires, and capture
// the code via a spied exit. Returns the exit code the gate resolved to.
async function runGate(
	modulePath: string,
	argv: readonly string[],
	root: string,
): Promise<number | null> {
	process.chdir(root);
	vi.resetModules();
	process.argv = ["node", "gate", ...argv];
	let code: number | null = null;
	vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
		code = c ?? 0;
		throw new Error("EXIT");
	}) as never);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await import(modulePath);
	} catch (error) {
		if ((error as Error).message !== "EXIT") {
			throw error;
		}
	}
	return code;
}

// A standalone vitest project whose coverage gate we can trigger for real. It
// symlinks the repo's node_modules so `vitest`, `vitest/config`, and the v8
// coverage provider all resolve, ships a config with the same per-file 90%
// thresholds the repo uses, and carries one `src` module. When `covered` is
// false a passing-but-unrelated test leaves that module at 0% — the coverage
// gate must then fail; when true the test exercises it to 100% and the gate
// passes.
function makeCoverageFixture(covered: boolean): string {
	const dir = mkdtempSync(join(tmpdir(), "gate-cov-"));
	symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
	writeFileSync(
		join(dir, "vitest.config.ts"),
		[
			'import { defineConfig } from "vitest/config";',
			"",
			"export default defineConfig({",
			"\ttest: {",
			'\t\tinclude: ["**/*.test.ts"],',
			"\t\tcoverage: {",
			'\t\t\tprovider: "v8",',
			"\t\t\tall: true,",
			'\t\t\tinclude: ["src/**/*.ts"],',
			"\t\t\tthresholds: { lines: 90, functions: 90, branches: 90, statements: 90, perFile: true },",
			"\t\t},",
			"\t},",
			"});",
			"",
		].join("\n"),
	);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(
		join(dir, "src", "widget.ts"),
		"export function widget(n: number): number {\n\treturn n * 2;\n}\n",
	);
	const test = covered
		? [
				'import { test, expect } from "vitest";',
				'import { widget } from "./src/widget.ts";',
				'test("widget doubles its input", () => {',
				"\texpect(widget(2)).toBe(4);",
				"});",
				"",
			]
		: [
				'import { test, expect } from "vitest";',
				'test("passes without touching widget.ts", () => {',
				"\texpect(1).toBe(1);",
				"});",
				"",
			];
	writeFileSync(join(dir, "widget.test.ts"), test.join("\n"));
	return dir;
}

// Fork a real `vitest run --coverage` against the fixture project and return its
// exit code — the coverage gate is that exit code and nothing else.
function runCoverageGate(dir: string): number {
	const bin = join(dir, "node_modules", ".bin", "vitest");
	const result = spawnSync(bin, ["run", "--coverage"], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env },
	});
	return result.status ?? 1;
}

describe("gate integrity — every gate fails closed on a real violation", () => {
	const dirs: string[] = [];

	function fixture(files: readonly FixtureFile[]): string {
		const dir = makeFixture(files);
		dirs.push(dir);
		return dir;
	}

	function coverageFixture(covered: boolean): string {
		const dir = makeCoverageFixture(covered);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		process.chdir(REPO_ROOT);
		vi.restoreAllMocks();
		vi.resetModules();
		while (dirs.length > 0) {
			const d = dirs.pop();
			if (d !== undefined) {
				rmSync(d, { recursive: true, force: true });
			}
		}
	});

	it("lint gate exits non-zero on an oxlint violation", async () => {
		// `no-debugger` is an error in the repo oxlint config; a file with a
		// `debugger` statement must drive the lint gate to exit 1.
		const root = fixture([
			repoConfig("packages/shared/config/oxlint.json"),
			{ path: "bad.ts", content: "debugger;\n" },
		]);
		const code = await runGate("../src/lint.ts", ["--only", "oxlint", "bad.ts"], root);
		expect(code).toBe(1);
	});

	it("lint gate exits zero on a clean file (control)", async () => {
		const root = fixture([
			repoConfig("packages/shared/config/oxlint.json"),
			{ path: "clean.ts", content: "export const answer = 42;\n" },
		]);
		const code = await runGate("../src/lint.ts", ["--only", "oxlint", "clean.ts"], root);
		expect(code).toBe(0);
	});

	it("format gate exits non-zero on an unformatted file", async () => {
		// Extra spaces and a missing semicolon: oxfmt --check reports a diff and the
		// format gate exits 1 rather than silently rewriting in a verify pass.
		const root = fixture([
			repoConfig("packages/shared/config/oxfmt.json"),
			{ path: "bad.ts", content: "export const   answer=42\n" },
		]);
		const code = await runGate("../src/format.ts", ["--only", "oxfmt", "--check", "bad.ts"], root);
		expect(code).toBe(1);
	});

	it("format gate exits zero on a formatted file (control)", async () => {
		const root = fixture([
			repoConfig("packages/shared/config/oxfmt.json"),
			{ path: "clean.ts", content: "export const answer = 42;\n" },
		]);
		const code = await runGate(
			"../src/format.ts",
			["--only", "oxfmt", "--check", "clean.ts"],
			root,
		);
		expect(code).toBe(0);
	});

	it("schema gate exits non-zero when a config file declares no schema marker", async () => {
		// `orphan.yaml` is a gate-eligible config with no marker: the coverage half
		// of schema-check must hard-fail (exit 1), not skip it.
		const root = fixture([{ path: "orphan.yaml", content: "n: 1\n" }]);
		const code = await runGate("../src/schema-check.ts", [], root);
		expect(code).toBe(1);
	});

	it("schema gate exits zero when every config declares and satisfies its schema (control)", async () => {
		// A local schema plus a config that declares and satisfies it: coverage gate
		// green, instance validation green, all offline.
		const root = fixture([
			{ path: "schema.json", content: SCHEMA },
			{ path: "a.json", content: '{"$schema":"./schema.json","n":1}\n' },
		]);
		const code = await runGate("../src/schema-check.ts", [], root);
		expect(code).toBe(0);
	});

	it("coverage gate exits non-zero when a source file is undertested", () => {
		// widget.ts is never imported by the fixture's test → 0% coverage → below the
		// 90% per-file floor → the child vitest exits non-zero.
		const code = runCoverageGate(coverageFixture(false));
		expect(code).not.toBe(0);
	});

	it("coverage gate exits zero when the source file is fully covered (control)", () => {
		// The same project with a test that exercises widget.ts to 100% clears the
		// floor and the child vitest exits zero — proving the gate reds on the debt,
		// not on the harness.
		const code = runCoverageGate(coverageFixture(true));
		expect(code).toBe(0);
	});
});
