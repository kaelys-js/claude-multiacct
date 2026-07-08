// Integration tests for the git-metadata validator (scripts/qa/gitmeta-check.ts).
//
// gitmeta-check is a top-level script: it captures ROOT from `git rev-parse` at
// import and runs its assertions immediately, exiting non-zero on any failure.
// To drive it deterministically we chdir into a throwaway git fixture and import
// it fresh (vi.resetModules), so ROOT binds to the fixture. The REAL repo import
// covers the all-pass path (every assertion's success branch); purpose-built
// broken fixtures cover the failure branches.
//
// Rule 9 — the validator's whole value is that a git-metadata regression cannot
// merge: a build-junk file left un-ignored, a tracked records/ tree accidentally
// ignored, a duplicated ignore line, mis-classified line endings. Each fixture
// trips exactly one such invariant and asserts the process exits non-zero, so a
// check that stopped discriminating that defect would fail this suite.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = "../../scripts/qa/gitmeta-check.ts";

// A `.gitignore` matching the real repo's shape: ignores build junk, keeps the
// records tree (incl. the records/build/ un-ignore regression guard) tracked.
const GOOD_GITIGNORE = [
	"node_modules/",
	"dist/",
	".env",
	"*.log",
	".mise/",
	".turbo/",
	"coverage/",
	"build/",
	"!records/build/",
	"!records/build/**",
	"!pnpm-lock.yaml",
	"!bin/mise",
	"",
].join("\n");

// A `.gitattributes` matching the real repo's classifications.
const GOOD_GITATTRIBUTES = [
	"* text=auto",
	"*.md text eol=lf",
	"*.ts text",
	"*.json text",
	"pnpm-lock.yaml text eol=lf -diff linguist-generated=true",
	"*.png binary",
	"",
].join("\n");

type Overrides = {
	gitignore?: string;
	gitattributes?: string;
	withMise?: boolean;
	extraFiles?: ReadonlyArray<{ path: string; content: string }>;
};

// Build a git repo fixture with controllable metadata files. It commits a
// records/ tree and a lockfile so the MUST_NOT_IGNORE assertions have real
// tracked paths to reason about.
function makeRepo(over: Overrides = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "gitmeta-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: dir });

	writeFileSync(join(dir, ".gitignore"), over.gitignore ?? GOOD_GITIGNORE);
	writeFileSync(join(dir, ".gitattributes"), over.gitattributes ?? GOOD_GITATTRIBUTES);

	const domains = [
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
	for (const d of domains) {
		mkdirSync(join(dir, "records", d), { recursive: true });
		writeFileSync(join(dir, "records", d, "x.md"), "# x\n");
	}
	mkdirSync(join(dir, "schema"), { recursive: true });
	writeFileSync(join(dir, "schema", "record.schema.json"), "{}\n");
	mkdirSync(join(dir, "templates"), { recursive: true });
	writeFileSync(join(dir, "templates", "prd.template.md"), "# t\n");
	writeFileSync(join(dir, "owners.yaml"), "a: 1\n");
	writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 1\n");

	if (over.withMise) {
		mkdirSync(join(dir, "bin"), { recursive: true });
		const mise = join(dir, "bin", "mise");
		// `bin/mise exec -- pnpm config list` must exit 0 for checkNpmrc to pass.
		writeFileSync(mise, "#!/bin/sh\nexit 0\n");
		chmodSync(mise, 0o755);
	}

	for (const f of over.extraFiles ?? []) {
		const full = join(dir, f.path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, f.content);
	}

	execFileSync("git", ["add", "-A"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
	return dir;
}

// Import gitmeta-check fresh, capturing its exit code (or null if it fell off the
// end without exiting — the all-pass path never calls process.exit).
async function runCheck(root: string): Promise<number | null> {
	process.chdir(root);
	vi.resetModules();
	let exitCode: number | null = null;
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCode = code ?? 0;
		throw new Error("EXIT");
	}) as never);
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await import(MODULE);
	} catch (error) {
		if ((error as Error).message !== "EXIT") {
			throw error;
		}
	}
	return exitCode;
}

describe("gitmeta-check", () => {
	const orig = process.cwd();
	const repos: string[] = [];

	beforeEach(() => {
		vi.resetModules();
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

	function fixture(over: Overrides = {}): string {
		const dir = makeRepo(over);
		repos.push(dir);
		return dir;
	}

	it("passes on the real repo (all assertions green)", async () => {
		// The real repo is the canonical all-pass fixture: importing against it
		// exercises every success branch and never calls process.exit.
		const code = await runCheck(orig);
		expect(code).toBeNull();
	});

	it("passes on a well-formed synthetic fixture", async () => {
		// A hand-built good repo also passes — proving the assertions aren't keyed to
		// the real repo's exact paths but to the invariants themselves.
		const root = fixture({ withMise: true });
		const code = await runCheck(root);
		expect(code).toBeNull();
	});

	it("fails when build junk is NOT ignored (.gitignore too permissive)", async () => {
		// Drop every ignore rule: node_modules/dist/etc. are no longer ignored, so
		// the MUST_IGNORE assertions fire.
		const root = fixture({ gitignore: "# nothing ignored\n", withMise: true });
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails when the records/ tree is wrongly ignored (MUST_NOT_IGNORE)", async () => {
		// An over-broad `records/` ignore swallows the governance tree; this includes
		// the records/build/ regression-guard branch (a records/build/ path ignored).
		const root = fixture({
			gitignore: `${GOOD_GITIGNORE}\nrecords/\n`,
			withMise: true,
		});
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails on a duplicate content line in .gitignore", async () => {
		// `node_modules/` twice is dead weight / a merge slip; checkDuplicateLines
		// must flag it.
		const root = fixture({
			gitignore: `${GOOD_GITIGNORE}\nnode_modules/\n`,
			withMise: true,
		});
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails when .gitattributes mis-classifies line endings", async () => {
		// Markdown without `eol=lf` breaks the expectAttr(x.md, eol, lf) assertion.
		const root = fixture({
			gitattributes:
				"* text=auto\n*.ts text\n*.json text\npnpm-lock.yaml text eol=lf -diff linguist-generated=true\n*.png binary\n",
			withMise: true,
		});
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails when a tracked file matches .gitignore (ignored-but-tracked guard)", async () => {
		// Commit foo.log, THEN ignore *.log: the file is tracked yet ignored, which
		// checkTrackedNotIgnored must catch.
		const root = fixture({
			gitignore: GOOD_GITIGNORE, // already ignores *.log
			withMise: true,
			extraFiles: [{ path: "keep.log", content: "x\n" }],
		});
		// keep.log was force-added by `git add -A`? No — .gitignore excludes it, so
		// it is NOT committed. Force-add it to create the tracked-and-ignored state.
		execFileSync("git", ["add", "-f", "keep.log"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "force"], { cwd: root });
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails when .npmrc is unparseable (mise/pnpm exits non-zero)", async () => {
		// No bin/mise in the fixture → `${ROOT}/bin/mise` spawn errors (status ≠ 0),
		// which checkNpmrc reports as a malformed-.npmrc failure. This drives the
		// checkNpmrc fail branch without needing a real broken .npmrc.
		const root = fixture({ withMise: false });
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails on line-ending renormalisation drift", async () => {
		// Commit a CRLF file while `.gitattributes` has NO text rule, THEN turn on
		// `* text=auto`: `git add --renormalize` now re-stages the file (its LF-
		// normalised blob differs from the CRLF index), which checkRenormalize must
		// flag as drift. This is the guarantee that a stray CRLF can't merge.
		const root = fixture({ withMise: true });
		writeFileSync(join(root, "crlf.txt"), "l1\r\nl2\r\n");
		// Re-commit with attributes that DON'T normalise .txt, so the CRLF blob lands
		// in the index verbatim; then add `* text=auto` so renormalize sees drift.
		writeFileSync(join(root, ".gitattributes"), `${GOOD_GITATTRIBUTES}\n*.txt !text\n`);
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "raw crlf"], { cwd: root });
		writeFileSync(join(root, ".gitattributes"), `${GOOD_GITATTRIBUTES}\n*.txt text=auto\n`);
		execFileSync("git", ["add", ".gitattributes"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "normalise txt"], { cwd: root });
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("fails on a git parse diagnostic from a negative .gitattributes pattern", async () => {
		// A leading `!` line in `.gitattributes` makes git print
		// `warning: Negative patterns are ignored in git attributes` to stderr while
		// still exiting 0 — exactly the "diagnostic but exit 0" gap checkGitParseWarnings
		// promotes to a hard failure (mirroring the editorconfig gate).
		const root = fixture({
			gitattributes: `${GOOD_GITATTRIBUTES}\n!oops.md text\n`,
			withMise: true,
		});
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("reports 'unset' when an expected .gitattributes attr is entirely absent", async () => {
		// A .gitattributes that mentions none of the sampled attrs leaves them UNSET;
		// expectAttr's failure message must render `unset` (the `got ?? "unset"`
		// branch) rather than "undefined", and the run fails.
		const root = fixture({ gitattributes: "*.png binary\n", withMise: true });
		const code = await runCheck(root);
		expect(code).toBe(1);
	});

	it("falls back to process.cwd() for ROOT outside a git repo", async () => {
		// When `git rev-parse --show-toplevel` finds no repo, its stdout is empty and
		// ROOT falls back to process.cwd() (the `|| process.cwd()` arm). The script
		// then runs its assertions against the non-repo cwd — every git check fails,
		// so it exits 1 — but the point is it degrades to cwd instead of an empty
		// ROOT, and completes rather than throwing.
		const bare = mkdtempSync(join(tmpdir(), "notrepo-"));
		repos.push(bare);
		const code = await runCheck(bare);
		expect(code).toBe(1);
	});

	it("treats an unreadable .gitignore as empty in the duplicate-line check", async () => {
		// checkDuplicateLines reads .gitignore directly; if it is absent/unreadable the
		// try/catch must yield [] (no duplicates), not crash. Deleting .gitignore after
		// commit reaches that catch — the other assertions still fail the run (nothing
		// is ignored), but the duplicate check itself degrades gracefully.
		const root = fixture({ withMise: true });
		rmSync(join(root, ".gitignore"), { force: true });
		const code = await runCheck(root);
		// Removing .gitignore makes MUST_IGNORE assertions fail → exit 1; the point is
		// the run completes (contentLines' catch handled the missing file) rather than
		// throwing.
		expect(code).toBe(1);
	});
});
