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
 *
 * It NEVER leaves staged or renormalised changes behind.
 *
 * @module
 */

import { spawnSync } from "node:child_process";

const ROOT = ((): string => {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	return r.stdout.trim() || process.cwd();
})();

const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

// Run a git command in the repo root, returning status + trimmed stdout.
function git(args: readonly string[]): { status: number; stdout: string } {
	const r = spawnSync("git", [...args], { cwd: ROOT, encoding: "utf8" });
	return { status: r.status ?? 1, stdout: r.stdout };
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
	"records/",
	...RECORD_DOMAINS.map((d) => `records/${d}/x.md`),
	"schema/record.schema.json",
	"templates/prd.template.md",
	"owners.yaml",
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
			const guard = path.startsWith("records/build/")
				? " (records/build/ regression — the `!records/build/` un-ignore is missing)"
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
// The index is always reset afterwards so nothing is left staged.
function checkRenormalize(): void {
	const preDirty = new Set(git(["diff", "--name-only", "HEAD"]).stdout.split("\n").filter(Boolean));
	git(["add", "--renormalize", "."]);
	const staged = git(["diff", "--cached", "--name-only"]).stdout.split("\n").filter(Boolean);
	git(["reset", "-q"]);
	const drift = staged.filter((f) => !preDirty.has(f));
	if (drift.length > 0) {
		fail(`git: line-ending renormalisation drift in: ${drift.join(", ")}.`);
	}
}

// ── .npmrc: pnpm can parse it ─────────────────────────────────────────

function checkNpmrc(): void {
	const r = spawnSync(`${ROOT}/bin/mise`, ["exec", "--", "pnpm", "config", "list"], {
		cwd: ROOT,
		stdio: ["ignore", "ignore", "inherit"],
	});
	if (r.status !== 0) {
		fail(".npmrc: `pnpm config list` exited non-zero (malformed .npmrc).");
	}
}

checkGitignore();
checkGitattributes();
checkTrackedNotIgnored();
checkRenormalize();
checkNpmrc();

if (failures.length > 0) {
	process.stderr.write(`gitmeta-check: ${String(failures.length)} assertion(s) failed:\n`);
	for (const f of failures) {
		process.stderr.write(`  ✗ ${f}\n`);
	}
	process.exit(1);
}

process.stdout.write("gitmeta-check: all assertions passed.\n");
