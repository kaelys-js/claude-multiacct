// Integration tests for the schema instance validator (scripts/qa/schema-check.ts).
//
// schema-check auto-discovers every tracked config file (json/jsonc/json5/yaml/
// yml/toml), reads the schema reference the file itself declares, and validates
// the file against it — plus a COVERAGE GATE asserting every gate-eligible config
// file declares a marker at all. It is a top-level script binding ROOT from
// `git rev-parse` (cwd-based), so tests chdir into throwaway git fixtures and
// import it fresh.
//
// Each fixture ships a stub `bin/mise` that forwards `exec -- <cmd> …` straight to
// the REAL `check-jsonschema` (on PATH inside the mise-exec'd test process), so
// validation outcomes are genuine, not mocked: a file that satisfies its schema
// PASSES, one that violates it FAILS, one whose remote schema won't resolve WARNS.
//
// Rule 9 — the validator's value is twofold and both halves are pinned here: an
// unvalidated config file can never merge (coverage gate → hard fail), and a
// config file that violates its declared schema can never merge (instance
// validation → hard fail), while a transient network outage on a REMOTE schema is
// a warning, not a false failure.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = "../../scripts/qa/schema-check.ts";

// A stub `bin/mise` that drops the leading `exec --` and execs the rest, so the
// script's `bin/mise exec -- check-jsonschema …` reaches the real tool on PATH.
const MISE_STUB = '#!/bin/sh\n# args: exec -- <cmd...>\nshift 2\nexec "$@"\n';

// A permissive-but-typed JSON Schema: requires an integer `n`. A file with a
// string `n` fails validation; one with an integer `n` passes.
const SCHEMA = JSON.stringify({
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "object",
	properties: { n: { type: "integer" } },
	required: ["n"],
});

type FixtureFile = { path: string; content: string };

function makeRepo(files: readonly FixtureFile[]): string {
	const dir = mkdtempSync(join(tmpdir(), "schema-"));
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

async function runCheck(root: string): Promise<{ code: number | null; out: string; err: string }> {
	process.chdir(root);
	vi.resetModules();
	let code: number | null = null;
	let out = "";
	let err = "";
	vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
		code = c ?? 0;
		throw new Error("EXIT");
	}) as never);
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
		out += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		err += String(chunk);
		return true;
	});
	try {
		await import(MODULE);
	} catch (error) {
		if ((error as Error).message !== "EXIT") {
			throw error;
		}
	}
	return { code, out, err };
}

describe("schema-check", () => {
	const orig = process.cwd();
	const repos: string[] = [];
	// A real schema file at an ABSOLUTE path outside any fixture, so a config file
	// can declare `"$schema":"<abs>"` and drive resolveRef's isAbsolute branch.
	const absSchemaDir = mkdtempSync(join(tmpdir(), "schema-abs-"));
	const absSchema = join(absSchemaDir, "abs.schema.json");
	writeFileSync(absSchema, SCHEMA);

	beforeEach(() => {
		vi.resetModules();
	});

	afterAll(() => {
		rmSync(absSchemaDir, { recursive: true, force: true });
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

	function fixture(files: readonly FixtureFile[]): string {
		const dir = makeRepo(files);
		repos.push(dir);
		return dir;
	}

	it("passes when every discovered config file satisfies its declared schema", async () => {
		// A broad all-green fixture: one file per supported format, each declaring a
		// LOCAL schema it satisfies. Excluded/refless/non-config files are present too
		// so the discovery filters (excluded prefix, .schema.json, .lock, non-config
		// ext) all run. Exit 0 proves the whole discover→validate pipeline is green.
		const root = fixture([
			// Local schema, referenced by the config files below.
			{ path: "schema.json", content: SCHEMA },
			// json with a relative `./`-prefixed $schema → resolveRef strips the `./`.
			{ path: "a.json", content: '{"$schema":"./schema.json","n":1}\n' },
			// jsonc with comments + $schema → dataFileFor writes a stripped temp copy,
			// exercising json5ToJson (line/block comments, trailing comma).
			{
				path: "b.jsonc",
				content:
					'{\n  // leading comment\n  "$schema": "schema.json",\n  /* block */\n  "n": 2, // trailing\n}\n',
			},
			// json5 with an unquoted key, single-quoted string, a backslash escape and
			// an embedded double-quote in a single-quoted value — exercises json5ToJson's
			// escape handling and the "embedded `\"` inside a single-quoted string" arm.
			{
				path: "c.json5",
				content: "{\n  $schema: 'schema.json',\n  desc: 'a\\\\b and a \"quote\"',\n  n: 3,\n}\n",
			},
			// yaml via the yaml-language-server marker.
			{
				path: "d.yaml",
				content: "# yaml-language-server: $schema=schema.json\nn: 4\n",
			},
			// toml via the #:schema marker.
			{ path: "e.toml", content: "#:schema schema.json\nn = 5\n" },
			// json declaring its schema by ABSOLUTE path → resolveRef's isAbsolute arm
			// passes it through verbatim (no repo-root join). `absSchema` is a real
			// schema file at an absolute path outside the fixture.
			{ path: "abs.json", content: `{"$schema":"${absSchema}","n":6}\n` },
			// A refless JSON/TOML under dist/ and build/: NOT excluded from DISCOVERY
			// (those prefixes aren't in EXCLUDED_PREFIXES), so refForFile reads them and
			// the JSON / TOML extractors run and return null (→ skipped from discovery).
			// They ARE coverage-excluded (dist/, build/ prefixes), so the gate stays
			// green. This keeps the extractor null-return arms covered.
			{ path: "dist/refless.json", content: '{"just":"data"}\n' },
			{ path: "build/refless.toml", content: "just = 1\n" },
			// ── files that must be DISCOVERED-but-skipped or COVERAGE-excluded ──
			// A schema file itself: excluded from the coverage gate (.schema.json).
			{ path: "thing.schema.json", content: SCHEMA },
			// Under .schemas/ : EXCLUDED_PREFIXES (discovery) + prefix (coverage).
			{ path: ".schemas/x.json", content: '{"$schema":"./schema.json","n":1}\n' },
			// Under coverage/ : coverage-excluded prefix; refless yet not flagged.
			{ path: "coverage/report.yaml", content: "n: 9\n" },
			// A .lock file: coverage-excluded by suffix.
			{ path: "foo.lock", content: "whatever\n" },
			// The lockfile: coverage-excluded exact match.
			{ path: "pnpm-lock.yaml", content: "lockfileVersion: 1\n" },
			// A non-config file: wrong extension → never discovered nor gated.
			{ path: "README.md", content: "# hi\n" },
			// A config file with NO marker but under an excluded prefix: not flagged.
			{ path: ".mise/conf.toml", content: "x = 1\n" },
		]);
		const { code, out } = await runCheck(root);
		expect(code).toBe(0);
		// The discovered set should list the five marker-bearing config files.
		expect(out).toContain("a.json → ");
		expect(out).toContain("e.toml → ");
		expect(out).toContain("every tracked config file declares a schema marker");
	});

	it("resolves a relative schema ref against the REFERENCING FILE's directory", async () => {
		// A config file in a SUBDIRECTORY declaring `$schema=../myschema.json` must
		// resolve against its OWN dir (sub/) not the repo root — reaching the parent's
		// schema — matching yaml-language-server / $schema semantics. Exit 0 proves the
		// new `join(ROOT, dirname(file), rel)` resolution walks up correctly.
		const root = fixture([
			// Schema in the parent (repo root); the subdir file reaches it via `../`.
			{ path: "myschema.json", content: SCHEMA },
			{
				path: "sub/foo.yaml",
				content: "# yaml-language-server: $schema=../myschema.json\nn: 5\n",
			},
		]);
		const { code, out } = await runCheck(root);
		expect(code).toBe(0);
		// The ref is echoed verbatim as the file declared it (relative to sub/).
		expect(out).toContain("sub/foo.yaml → ../myschema.json");
	});

	it("fails when a subdir file's relative ref points nowhere (file-relative miss)", async () => {
		// The complement: a subdir file whose `../` ref resolves to a non-existent
		// schema path fails to build a validator → a genuine (non-remote) `fail`, exit
		// 1. This pins that file-relative resolution can still MISS and is not silently
		// treated as a pass.
		const root = fixture([
			{ path: "myschema.json", content: SCHEMA },
			{
				path: "sub/bad.yaml",
				content: "# yaml-language-server: $schema=../nonexistent.json\nn: 5\n",
			},
		]);
		const { code } = await runCheck(root);
		expect(code).toBe(1);
	});

	it("hard-fails the coverage gate for a refless templates/ config (templates now gated)", async () => {
		// `templates/` was REMOVED from the coverage exclusions: a refless
		// `templates/*.yaml` is now a gate MISS, listed by name and exiting 1. This is
		// the guarantee that a template config can no longer slip in unvalidated.
		const root = fixture([{ path: "templates/orphan.yaml", content: "n: 1\n" }]);
		const { code, out, err } = await runCheck(root);
		expect(code).toBe(1);
		const combined = `${out}${err}`;
		expect(combined).toContain("declare NO schema marker");
		expect(combined).toContain("templates/orphan.yaml");
	});

	it("falls back to process.cwd() for ROOT outside a git repo (empty discovery)", async () => {
		// Outside a git repo, `git rev-parse --show-toplevel` yields empty stdout and
		// ROOT falls back to process.cwd() (the `|| process.cwd()` arm). `git ls-files`
		// then lists nothing → no config to validate, coverage gate trivially green →
		// exit 0. Exercises the ROOT fallback the other check scripts share.
		const bare = mkdtempSync(join(tmpdir(), "schema-notrepo-"));
		repos.push(bare);
		const { code } = await runCheck(bare);
		expect(code).toBe(0);
	});

	it("fails when a discovered file VIOLATES its declared schema", async () => {
		// `bad.json` declares the integer-`n` schema but sets n to a string → genuine
		// validation failure → the `fail` outcome increments `failed` → exit 1. This
		// is the guarantee a schema-violating config cannot merge.
		const root = fixture([
			{ path: "schema.json", content: SCHEMA },
			{ path: "bad.json", content: '{"$schema":"./schema.json","n":"not-an-int"}\n' },
		]);
		const { code, out, err } = await runCheck(root);
		expect(code).toBe(1);
		expect(`${out}${err}`).toContain("bad.json");
	});

	it("fails the coverage gate when a config file declares NO schema marker", async () => {
		// `orphan.yaml` is a gate-eligible config file with no marker and no exclusion
		// → missingSchemaRefs flags it → hard fail (exit 1), listing it by name.
		const root = fixture([{ path: "orphan.yaml", content: "n: 1\n" }]);
		const { code, out, err } = await runCheck(root);
		expect(code).toBe(1);
		const combined = `${out}${err}`;
		expect(combined).toContain("declare NO schema marker");
		expect(combined).toContain("orphan.yaml");
	});

	it("WARNS (not fails) when a REMOTE schema can't be downloaded", async () => {
		// A remote `$schema` at an unresolvable host → check-jsonschema emits a
		// download-failure signature → outcome `warn-unreachable`, NOT `fail`. With no
		// other errors and a full coverage gate, the run still exits 0 — network
		// resilience, mirroring sync:schemas.
		const root = fixture([
			{
				path: "remote.json",
				content: '{"$schema":"https://nonexistent.invalid.example/s.json","n":1}\n',
			},
		]);
		const { code, err } = await runCheck(root);
		expect(code).toBe(0);
		expect(err).toContain("unreachable");
	});

	it("treats a tracked-but-deleted config file as compliant/refless (unreadable guards)", async () => {
		// `git ls-files` lists a committed file even after it is deleted on disk; both
		// refForFile (discovery) and lacksSchemaMarker (coverage gate) then hit their
		// readFileSync catch. The contract: a file the gate can't READ is trusted, not
		// crashed on — so the run completes and exits 0.
		const root = fixture([
			{ path: "schema.json", content: SCHEMA },
			{ path: "gone.json", content: '{"$schema":"./schema.json","n":1}\n' },
		]);
		rmSync(join(root, "gone.json"), { force: true });
		const { code } = await runCheck(root);
		expect(code).toBe(0);
	});

	it("skips a config file whose declared reference is unreadable/absent (refless)", async () => {
		// A json file with no `$schema` is refless: refForFile returns null, so it is
		// neither validated nor (being coverage-excluded here via .schemas/) flagged.
		// Guards the `extractRef(...) === null` skip in discovery.
		const root = fixture([
			{ path: ".schemas/noref.json", content: '{"just":"data"}\n' },
			{ path: "schema.json", content: SCHEMA },
			{ path: "ok.json", content: '{"$schema":"./schema.json","n":1}\n' },
		]);
		const { code } = await runCheck(root);
		expect(code).toBe(0);
	});
});
