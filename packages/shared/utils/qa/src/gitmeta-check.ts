#!/usr/bin/env node
/**
 * Validates the CONTENTS of the repo's git-metadata files — `.gitignore`,
 * `.gitattributes`, and `.npmrc` — by asking git's own plumbing what it would
 * do, rather than pattern-matching the files by hand. A single tool in the
 * `qa:lint` pipeline (registry id `gitmeta`), it exits non-zero with a clear
 * message on the first failed assertion.
 *
 * What it asserts:
 *  - `.gitignore` ignores build/dependency junk but NOT the governance records
 *    tree, the schema, templates, owners, the lockfile, or `bin/mise`. The
 *    `records/build/` case is a regression guard for a past bug where the
 *    generic `build/` rule clobbered the `records/build/` domain directory.
 *  - `.gitattributes` classifies text/binary + line endings correctly.
 *  - No tracked file is git-ignored, and the tree has no line-ending
 *    renormalisation drift (beyond files already modified in the working tree).
 *  - `.npmrc` is well-formed (pnpm can parse it).
 *  - Neither `.gitignore` nor `.gitattributes` has an exact-duplicate content
 *    line, and git emits no parse warning/error over sample paths.
 *
 * It NEVER leaves staged or renormalised changes behind.
 *
 * @module
 */

import { miseExec, repoRoot } from "@foundation/core";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = repoRoot();

const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

// Run a git command in the repo root, returning status + raw stdout + stderr.
function git(args: readonly string[]): { status: number; stdout: string; stderr: string } {
	const r = spawnSync("git", [...args], { cwd: ROOT, encoding: "utf8" });
	return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr ?? "" };
}

// ── .gitignore via `git check-ignore` ────────────────────────────────

// `git check-ignore -q <path>` exits 0 when the path is ignored, 1 otherwise.
function isIgnored(path: string): boolean {
	return git(["check-ignore", "-q", path]).status === 0;
}

const MUST_IGNORE: readonly string[] = [
	"node_modules/x",
	"dist/x",
	".env",
	"foo.log",
	".mise/x",
	".turbo/x",
	"coverage/x",
	"build/x",
];

// The nine governance record domains — each MUST stay tracked. `build` is the
// regression guard: the generic `build/` ignore rule must not swallow it.
const RECORD_DOMAINS: readonly string[] = [
	"governance",
	"build",
	"design",
	"frontend",
	"backend",
	"infra",
	"security",
	"data",
	"observability",
];

const MUST_NOT_IGNORE: readonly string[] = [
	"packages/products/registry/records/",
	...RECORD_DOMAINS.map((d) => `packages/products/registry/records/${d}/x.md`),
	"packages/products/registry/schema/record.schema.json",
	"packages/products/registry/templates/prd.template.md",
	"packages/products/registry/owners.yaml",
	"pnpm-lock.yaml",
	"bin/mise",
];

function checkGitignore(): void {
	for (const path of MUST_IGNORE) {
		if (!isIgnored(path)) {
			fail(`.gitignore: "${path}" MUST be ignored but is not.`);
		}
	}
	for (const path of MUST_NOT_IGNORE) {
		if (isIgnored(path)) {
			const guard = path.startsWith("packages/products/registry/records/build/")
				? " (records/build/ regression — the `!packages/products/registry/records/build/` un-ignore is missing)"
				: "";
			fail(`.gitignore: "${path}" MUST NOT be ignored but is${guard}.`);
		}
	}
}

// ── .gitattributes via `git check-attr` ──────────────────────────────

// Parse `git check-attr <attrs> -- <path>` output into an attr→value map. Each
// line has the form `<path>: <attr>: <value>`.
function checkAttr(attrs: readonly string[], path: string): Record<string, string> {
	const { stdout } = git(["check-attr", ...attrs, "--", path]);
	const map: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const m = /^.*?: (?<attr>[^:]+): (?<value>.+)$/u.exec(line);
		const attr = m?.groups?.["attr"];
		const value = m?.groups?.["value"];
		if (attr !== undefined && value !== undefined) {
			map[attr] = value;
		}
	}
	return map;
}

// Assert one attribute resolves to the expected value for a path.
function expectAttr(path: string, attr: string, want: string, attrs: readonly string[]): void {
	const got = checkAttr(attrs, path)[attr];
	if (got !== want) {
		fail(`.gitattributes: ${path} → ${attr} is "${got ?? "unset"}", expected "${want}".`);
	}
}

function checkGitattributes(): void {
	// Markdown: normalised text with LF endings.
	expectAttr("x.md", "text", "set", ["text", "eol"]);
	expectAttr("x.md", "eol", "lf", ["text", "eol"]);
	// TypeScript / JSON: normalised text.
	expectAttr("x.ts", "text", "set", ["text"]);
	expectAttr("x.json", "text", "set", ["text"]);
	// The lockfile: linguist-generated, diff suppressed (`-diff`).
	expectAttr("pnpm-lock.yaml", "linguist-generated", "true", ["linguist-generated", "diff"]);
	expectAttr("pnpm-lock.yaml", "diff", "unset", ["linguist-generated", "diff"]);
	// PNG: the `binary` macro expands to `-text -diff` (with `binary` itself set).
	// Assert via `-a` so we observe the expanded text/diff attrs, not just the macro.
	expectAttr("x.png", "text", "unset", ["-a"]);
	expectAttr("x.png", "diff", "unset", ["-a"]);
}

// ── guards: no ignored-but-tracked files, no renormalisation drift ────

function checkTrackedNotIgnored(): void {
	const { stdout } = git(["ls-files", "--cached", "-i", "--exclude-standard"]);
	const tracked = stdout.split("\n").filter(Boolean);
	if (tracked.length > 0) {
		fail(`git: ${String(tracked.length)} tracked file(s) match .gitignore: ${tracked.join(", ")}.`);
	}
}

// `git add --renormalize .` re-stages any file whose normalised blob differs
// from the index. We compare the resulting staged set against the files ALREADY
// modified in the working tree — anything extra is genuine line-ending drift.
//
// The renormalize runs against a THROWAWAY COPY of the index (via GIT_INDEX_FILE),
// so the real index is never touched. `git add --renormalize .` + `git reset` on
// the real index would clobber whatever the caller had staged (a real hazard on
// the pre-push path, and the source of cross-test index races).
function checkRenormalize(): void {
	const preDirty = new Set(git(["diff", "--name-only", "HEAD"]).stdout.split("\n").filter(Boolean));
	const gitDir = git(["rev-parse", "--absolute-git-dir"]);
	if (gitDir.status !== 0) {
		return; // not inside a git repo — nothing to renormalise (a silent no-op, as before)
	}
	const tmpIndex = join(tmpdir(), `gitmeta-index-${String(process.pid)}`);
	let staged: string[] = [];
	try {
		copyFileSync(join(gitDir.stdout.trim(), "index"), tmpIndex);
		const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
		spawnSync("git", ["add", "--renormalize", "."], { cwd: ROOT, encoding: "utf8", env });
		const out = spawnSync("git", ["diff", "--cached", "--name-only"], {
			cwd: ROOT,
			encoding: "utf8",
			env,
		}).stdout;
		staged = out.split("\n").filter(Boolean);
	} finally {
		rmSync(tmpIndex, { force: true });
	}
	const drift = staged.filter((f) => !preDirty.has(f));
	if (drift.length > 0) {
		fail(`git: line-ending renormalisation drift in: ${drift.join(", ")}.`);
	}
}

// ── .npmrc: pnpm can parse it ─────────────────────────────────────────

function checkNpmrc(): void {
	const r = miseExec(["pnpm", "config", "list"], {
		cwd: ROOT,
		stdio: ["ignore", "ignore", "inherit"],
	});
	if (r.status !== 0) {
		fail(".npmrc: `pnpm config list` exited non-zero (malformed .npmrc).");
	}
}

// ── duplicate content lines in .gitignore / .gitattributes ────────────

// The exact content lines of a git-metadata file, dropping blank lines and
// full-line `#` comments (a repeated comment or blank line is not a defect).
// Content is compared verbatim otherwise — trailing whitespace is significant to
// git, so we do NOT trim it away.
function contentLines(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(ROOT, file), "utf8");
	} catch {
		return [];
	}
	return text.split("\n").filter((line) => {
		const trimmed = line.trim();
		return trimmed !== "" && !trimmed.startsWith("#");
	});
}

// Flag any exact-duplicate content line in a git-metadata file. Duplicate
// patterns are dead weight at best and a sign of a merge/edit mistake at worst.
//
// NOTE: we deliberately do NOT implement dead-negation detection (a `!pat` whose
// pattern nothing prior ignores). This repo carries INTENTIONAL defensive
// negations — `!pnpm-lock.yaml`, `!bin/mise` — that nothing earlier ignores, and
// flagging them would be a false positive.
function checkDuplicateLines(file: string): void {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const line of contentLines(file)) {
		if (seen.has(line)) {
			dupes.add(line);
		}
		seen.add(line);
	}
	if (dupes.size > 0) {
		fail(`${file}: duplicate content line(s): ${[...dupes].map((d) => `"${d}"`).join(", ")}.`);
	}
}

// ── git parse warnings on .gitattributes / .gitignore ─────────────────

// Ask git to exercise `.gitattributes` and `.gitignore` over a few sample paths
// and fail if git emits any parse diagnostic about those files. A malformed line
// makes git print to stderr while still exiting 0 (e.g. `warning: … .gitattributes …`,
// or `foo!bad is not a valid attribute name: .gitattributes:N`), so — like the
// editorconfig gate — the diagnostic itself must be promoted to a failure.
// `core.attributesfile=/dev/null` isolates the repo's own `.gitattributes` from
// any global attributes file. `check-attr`/`check-ignore` write nothing to stderr
// on a clean run, so we treat BOTH the explicit `warning:`/`error:`/`fatal:`
// prefixes AND any stderr that names `.gitattributes`/`.gitignore` (git's parse
// diagnostics cite the offending file+line) as a defect.
const GITMETA_WARN = /^(?:warning|error|fatal):|\.git(?:attributes|ignore)\b/imu;
const SAMPLE_PATHS: readonly string[] = ["x.md", "x.ts", "x.json", "pnpm-lock.yaml", "x.png"];

function checkGitParseWarnings(): void {
	const attr = git([
		"-c",
		"core.attributesfile=/dev/null",
		"check-attr",
		"--all",
		"--",
		...SAMPLE_PATHS,
	]);
	if (GITMETA_WARN.test(attr.stderr)) {
		fail(`.gitattributes: git emitted a parse diagnostic: ${attr.stderr.trim()}`);
	}
	for (const path of SAMPLE_PATHS) {
		const ignore = git(["check-ignore", "-q", path]);
		if (GITMETA_WARN.test(ignore.stderr)) {
			fail(`.gitignore: git emitted a parse diagnostic: ${ignore.stderr.trim()}`);
		}
	}
}

checkGitignore();
checkGitattributes();
checkTrackedNotIgnored();
checkRenormalize();
checkNpmrc();
checkDuplicateLines(".gitignore");
checkDuplicateLines(".gitattributes");
checkGitParseWarnings();

if (failures.length > 0) {
	process.stderr.write(`gitmeta-check: ${String(failures.length)} assertion(s) failed:\n`);
	for (const f of failures) {
		process.stderr.write(`  ✗ ${f}\n`);
	}
	process.exit(1);
}

process.stdout.write("gitmeta-check: all assertions passed.\n");
