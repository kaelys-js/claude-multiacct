// Behaviour tests for `codeowners-reviewers.ts` (SRP-KK reviewer selection).
//
// WHY it matters: this port is a byte-for-byte re-implementation of the
// Python source at `security-pocs/repos/trp/scripts/codeowners-reviewers.py`.
// The whole reason it exists is to feed `gh pr edit --add-reviewer` with the
// same set of individuals the Python script would have picked; any drift in
// the glob translator, the "last matching rule wins" pass, or the team-owner
// filter produces a PR routed to the wrong humans. These tests fix the
// contract at the level of every exported helper plus the `main()` glue.
//
// No external services are touched: `main()` reads files and env vars only,
// so a per-test scratch directory is enough — no `@foundation/shell` or
// `fetch` mocks needed (the impl imports neither).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectReviewers, globMatch, main, parseCodeowners } from "./codeowners-reviewers.ts";

describe("globMatch", () => {
	it("still matches when a leading-slash pattern is present anywhere (Python-parity)", () => {
		// The Python impl uses `re.search`, not `re.fullmatch`, so a leading
		// `/` only strips the character — it does not add a `^` anchor. Both
		// the Python source and this TS port match `packages/src/index.ts`
		// against `/src`. This test locks in that documented parity even
		// though it diverges from the CODEOWNERS spec's "anchor at root".
		expect(globMatch("/src", "src/index.ts")).toBe(true);
		expect(globMatch("/src", "packages/src/index.ts")).toBe(true);
	});

	it("matches unanchored patterns anywhere in the path", () => {
		expect(globMatch("src", "src/index.ts")).toBe(true);
		expect(globMatch("src", "packages/src/index.ts")).toBe(true);
	});

	it("treats `*` as a non-slash wildcard", () => {
		expect(globMatch("*.ts", "index.ts")).toBe(true);
		expect(globMatch("*.ts", "nested/index.ts")).toBe(true);
		// `*` must not span a slash — `a/b.ts` cannot match `a*.ts`.
		expect(globMatch("/a*.ts", "a/b.ts")).toBe(false);
	});

	it("treats `**` as an any-including-slash wildcard", () => {
		expect(globMatch("src/**", "src/a/b/c.ts")).toBe(true);
		expect(globMatch("**/index.ts", "a/b/index.ts")).toBe(true);
	});

	it("treats `?` as a single-character wildcard", () => {
		expect(globMatch("/a?c", "abc")).toBe(true);
		expect(globMatch("/a?c", "abbc")).toBe(false);
	});

	it("strips trailing slashes from the pattern", () => {
		// `src/` should behave like `src` — the trailing `/` is a
		// directory-marker convention, not part of the match.
		expect(globMatch("src/", "src/index.ts")).toBe(true);
		expect(globMatch("/src///", "src/index.ts")).toBe(true);
	});

	it("escapes regex metacharacters in literal path segments", () => {
		// The `.` and `+` here must be literal, not regex metachars.
		expect(globMatch("/a.b+c", "a.b+c")).toBe(true);
		expect(globMatch("/a.b+c", "axbxc")).toBe(false);
	});

	it("requires the match to end at `/` or end-of-string", () => {
		// `docs` should match `docs/x` but not `docstring.md` — the trailing
		// `(?:/|$)` anchor is what enforces that.
		expect(globMatch("/docs", "docs/x")).toBe(true);
		expect(globMatch("/docs", "docstring.md")).toBe(false);
	});
});

describe("parseCodeowners", () => {
	it("returns an empty rule list for empty input", () => {
		expect(parseCodeowners("")).toEqual([]);
	});

	it("drops comment-only and blank lines", () => {
		const text = "\n# top comment\n   \n\t\n# another\n";
		expect(parseCodeowners(text)).toEqual([]);
	});

	it("drops lines with fewer than two whitespace-separated fields", () => {
		// A pattern with no owners is meaningless per the CODEOWNERS spec.
		expect(parseCodeowners("*")).toEqual([]);
		expect(parseCodeowners("only-a-pattern\n")).toEqual([]);
	});

	it("strips inline `#` comments", () => {
		const rules = parseCodeowners("*.ts @alice # a trailing comment");
		expect(rules).toEqual([{ pattern: "*.ts", owners: ["@alice"] }]);
	});

	it("splits on runs of whitespace (spaces and tabs)", () => {
		const rules = parseCodeowners("src/**\t@alice   @bob\t\t@carol");
		expect(rules).toEqual([{ pattern: "src/**", owners: ["@alice", "@bob", "@carol"] }]);
	});

	it("preserves the order of rules", () => {
		const rules = parseCodeowners("* @root\n/src @src-owner\n/docs @docs-owner");
		expect(rules.map((r) => r.pattern)).toEqual(["*", "/src", "/docs"]);
	});
});

describe("collectReviewers", () => {
	it("returns an empty list when there are no rules", () => {
		expect(collectReviewers([], ["src/index.ts"])).toEqual([]);
	});

	it("returns an empty list when there are no bundle paths", () => {
		const rules = parseCodeowners("* @alice");
		expect(collectReviewers(rules, [])).toEqual([]);
	});

	it("gives last-matching-rule wins per the CODEOWNERS spec", () => {
		const rules = parseCodeowners("* @root\n/src @src-owner");
		expect(collectReviewers(rules, ["src/index.ts"])).toEqual(["@src-owner"]);
	});

	it("skips team owners (any owner containing `/`)", () => {
		const rules = parseCodeowners("* @org/platform-team @alice");
		expect(collectReviewers(rules, ["anywhere/x"])).toEqual(["@alice"]);
	});

	it("deduplicates reviewers across bundle paths", () => {
		const rules = parseCodeowners("* @alice");
		expect(collectReviewers(rules, ["a.ts", "b.ts", "c/d.ts"])).toEqual(["@alice"]);
	});

	it("sorts the returned reviewers alphabetically", () => {
		const rules = parseCodeowners("* @charlie @alice @bob");
		expect(collectReviewers(rules, ["x"])).toEqual(["@alice", "@bob", "@charlie"]);
	});

	it("yields an empty list when the only matched rule has only team owners", () => {
		const rules = parseCodeowners("* @org/team");
		expect(collectReviewers(rules, ["a.ts"])).toEqual([]);
	});

	it("does not add reviewers for paths no rule matches", () => {
		const rules = parseCodeowners("/src @src-owner");
		expect(collectReviewers(rules, ["docs/README.md"])).toEqual([]);
	});
});

describe("main()", () => {
	let scratch: string;
	let bundlePath: string;
	const originalEnv = { ...process.env };

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "codeowners-reviewers-"));
		bundlePath = join(scratch, "bundle.json");
		writeFileSync(
			bundlePath,
			JSON.stringify({
				files_to_modify: [{ path: "src/index.ts" }, { path: "docs/x.md" }],
			}),
		);
		process.env.FIX_SRC = scratch;
		process.env.BUNDLE_JSON = bundlePath;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		rmSync(scratch, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("throws with the offending var name when FIX_SRC is unset", async () => {
		delete process.env.FIX_SRC;
		await expect(main()).rejects.toThrow("FIX_SRC");
	});

	it("throws with the offending var name when BUNDLE_JSON is unset", async () => {
		delete process.env.BUNDLE_JSON;
		await expect(main()).rejects.toThrow("BUNDLE_JSON");
	});

	it("returns 0 silently when no CODEOWNERS file exists in any of the three search paths", async () => {
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it("reads CODEOWNERS from the repo root when present", async () => {
		writeFileSync(join(scratch, "CODEOWNERS"), "* @alice\n");
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);
		expect(lines).toEqual(["@alice\n"]);
	});

	it("prefers `.github/CODEOWNERS` when no root file exists", async () => {
		mkdirSync(join(scratch, ".github"));
		writeFileSync(join(scratch, ".github", "CODEOWNERS"), "* @bob\n");
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);
		expect(lines).toEqual(["@bob\n"]);
	});

	it("falls back to `docs/CODEOWNERS` when neither root nor `.github` variant exists", async () => {
		mkdirSync(join(scratch, "docs"));
		writeFileSync(join(scratch, "docs", "CODEOWNERS"), "* @carol\n");
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);
		expect(lines).toEqual(["@carol\n"]);
	});

	it("stops at the first search-path hit and does not read subsequent files", async () => {
		// Root file wins; the `.github` file must NOT contribute its owner.
		writeFileSync(join(scratch, "CODEOWNERS"), "* @root-owner\n");
		mkdirSync(join(scratch, ".github"));
		writeFileSync(join(scratch, ".github", "CODEOWNERS"), "* @github-owner\n");
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);
		expect(lines).toEqual(["@root-owner\n"]);
	});

	it("integrates parsing + matching + team-filtering + sort on a realistic fixture", async () => {
		// Bundle touches src/ (src-owner wins over root) and docs/ (docs-owner).
		// Root has a team owner mixed in; it must not leak through.
		writeFileSync(
			join(scratch, "CODEOWNERS"),
			`${[
				"# fallback: keep team notified, plus a human",
				"*             @org/platform @root-human",
				"/src          @src-owner",
				"/docs         @docs-owner @root-human",
				"",
				"# malformed line below should be skipped",
				"only-a-pattern",
			].join("\n")}\n`,
		);
		const lines: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			lines.push(String(chunk));
			return true;
		});
		await expect(main()).resolves.toBe(0);
		// Sorted, deduped, individuals only.
		expect(lines).toEqual(["@docs-owner\n", "@root-human\n", "@src-owner\n"]);
	});

	it("writes nothing when every matched rule is team-only", async () => {
		writeFileSync(join(scratch, "CODEOWNERS"), "* @org/only-a-team\n");
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it("accepts a bundle with an empty `files_to_modify` array", async () => {
		writeFileSync(bundlePath, JSON.stringify({ files_to_modify: [] }));
		writeFileSync(join(scratch, "CODEOWNERS"), "* @alice\n");
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await expect(main()).resolves.toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it("propagates a JSON parse error when the bundle is not valid JSON", async () => {
		writeFileSync(bundlePath, "not json at all");
		writeFileSync(join(scratch, "CODEOWNERS"), "* @alice\n");
		await expect(main()).rejects.toThrow(/./u);
	});
});
