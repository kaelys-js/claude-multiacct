// Behaviour tests for `repo-router.ts` (the TS port of the Python
// `trp/scripts/repo-router.py`). Covers every exported helper with
// direct-call unit tests plus an integration test of `main()` driven
// against synthesised sfp.env / trp.env fixtures.
//
// The module resolves REPO_ROOT at IMPORT time: `TRP_REPO_ROOT` when
// set (test hook + genuine runtime knob), otherwise file-anchored two
// levels up from the module (matches the Python source, which anchors
// off `__file__`). SFP_ENV / TRP_ENV / resolveFixSrc's base derive
// from that snapshot. The pure helpers we call directly (parseEnv /
// loadRepos / slugify / score / pick / resolveFixSrc) are unaffected
// -- parseEnv takes an explicit path, resolveFixSrc only exposes
// REPO_ROOT as a prefix we assert with `endsWith`. For main() we set
// `process.env.TRP_REPO_ROOT` to a scratch dir first, then use
// `vi.resetModules()` + `await import()` so the re-loaded module
// observes the scratch dir as its REPO_ROOT.
//
// No live IO -- the module only touches `node:fs`, `node:path`,
// process.env, and stdout / stderr. All of those are stubbable in
// place, so no fetch mock or `@foundation/shell` stub is required
// (neither is imported by the source).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadRepos,
	parseEnv,
	pick,
	type RepoEntry,
	resolveFixSrc,
	score,
	slugify,
} from "./repo-router.ts";
import type * as RepoRouterModule from "./repo-router.ts";

// Materialise a throwaway scratch dir. Used both for parseEnv fixtures
// and as the chdir target for main() integration cases.
function mkScratch(): string {
	return mkdtempSync(join(tmpdir(), "repo-router-"));
}

// Dynamically import a fresh copy of the module so REPO_ROOT captures the
// current TRP_REPO_ROOT. Called by every main() integration test AFTER
// staging the env var to point at scratch. Hoisted to module scope (rather
// than nested in the describe block) since it captures no variables from
// its parent scope.
function loadFresh(): Promise<typeof RepoRouterModule> {
	vi.resetModules();
	return import("./repo-router.ts");
}

// Convenience -- write a file under `root` with the given contents,
// mkdir-p'ing the parent so nested paths don't need extra ceremony.
function writeAt(root: string, subpath: string, contents: string): string {
	const full = join(root, subpath);
	writeFileSync(full, contents);
	return full;
}

// A canned repo entry used across score / pick tests. Kept as a
// factory so a case can override one field without spreading noise
// across every call site.
function mkRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
	return {
		slug: "prov",
		owner: "providence-labs",
		repo: "providence",
		default_branch: "main",
		...overrides,
	};
}

// ---------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------

describe("parseEnv", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkScratch();
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns an empty map when the file does not exist", () => {
		const out = parseEnv(join(scratch, "missing.env"));
		expect(out.size).toBe(0);
	});

	it("returns an empty map when the path is a directory (statSync isFile false)", () => {
		// A directory exists at the path but isn't a file -- isFile() catches
		// the type check and returns false, so parseEnv short-circuits.
		mkdirSync(join(scratch, "adir"));
		const out = parseEnv(join(scratch, "adir"));
		expect(out.size).toBe(0);
	});

	it("skips comments and blank lines", () => {
		const p = writeAt(scratch, "a.env", "# a comment\n\n\nFOO=bar\n");
		const out = parseEnv(p);
		expect([...out.entries()]).toEqual([["FOO", "bar"]]);
	});

	it("skips lines with no equals sign", () => {
		const p = writeAt(scratch, "a.env", "not a kv line\nOK=yes\n");
		const out = parseEnv(p);
		expect(out.get("OK")).toBe("yes");
		expect(out.has("not a kv line")).toBe(false);
	});

	it("preserves insertion order", () => {
		const p = writeAt(scratch, "a.env", "A=1\nB=2\nC=3\n");
		expect([...parseEnv(p).keys()]).toEqual(["A", "B", "C"]);
	});

	it("strips surrounding double quotes from values", () => {
		const p = writeAt(scratch, "a.env", 'FOO="bar"\n');
		expect(parseEnv(p).get("FOO")).toBe("bar");
	});

	it("strips surrounding single quotes from values", () => {
		const p = writeAt(scratch, "a.env", "FOO='bar'\n");
		expect(parseEnv(p).get("FOO")).toBe("bar");
	});

	it("strips both quote classes (double then single, like Python .strip)", () => {
		const p = writeAt(scratch, "a.env", "FOO=\"'bar'\"\n");
		expect(parseEnv(p).get("FOO")).toBe("bar");
	});

	it("leaves an unquoted value alone", () => {
		const p = writeAt(scratch, "a.env", "FOO=bar baz\n");
		expect(parseEnv(p).get("FOO")).toBe("bar baz");
	});

	it("handles CRLF line endings", () => {
		const p = writeAt(scratch, "a.env", "A=1\r\nB=2\r\n");
		expect(parseEnv(p).get("A")).toBe("1");
		expect(parseEnv(p).get("B")).toBe("2");
	});

	it("keeps only up to the first '=' as the key", () => {
		// A value that itself contains '=' must be preserved verbatim; only
		// the first '=' splits.
		const p = writeAt(scratch, "a.env", "KEY=a=b=c\n");
		const out = parseEnv(p);
		expect(out.get("KEY")).toBe("a=b=c");
	});

	it("trims whitespace around key and value", () => {
		const p = writeAt(scratch, "a.env", "  KEY   =   value   \n");
		const out = parseEnv(p);
		expect(out.get("KEY")).toBe("value");
	});
});

// ---------------------------------------------------------------------
// loadRepos
// ---------------------------------------------------------------------

describe("loadRepos", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stderr: string;

	beforeEach(() => {
		stderr = "";
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stderr.write);
	});
	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("ignores keys that don't start with SFP_REPO_", () => {
		const env = new Map<string, string>([
			["OTHER_KEY", "value"],
			["SFP_REPO_prov", "prov:providence-labs/providence:main"],
		]);
		const out = loadRepos(env);
		expect(out).toHaveLength(1);
		expect(out[0]?.slug).toBe("prov");
	});

	it("parses a well-formed row into slug/owner/repo/default_branch", () => {
		const env = new Map([["SFP_REPO_prov", "prov:providence-labs/providence:main"]]);
		expect(loadRepos(env)).toEqual([
			{
				slug: "prov",
				owner: "providence-labs",
				repo: "providence",
				default_branch: "main",
			},
		]);
	});

	it("skips malformed rows with the wrong number of colon parts", () => {
		const env = new Map([["SFP_REPO_bad", "onlyoneparts"]]);
		const out = loadRepos(env);
		expect(out).toEqual([]);
		expect(stderr).toContain("skipping malformed SFP_REPO_bad");
	});

	it("skips rows with too many colon parts", () => {
		const env = new Map([["SFP_REPO_bad", "a:b:c:d"]]);
		const out = loadRepos(env);
		expect(out).toEqual([]);
		expect(stderr).toContain("skipping malformed SFP_REPO_bad");
	});

	it("skips rows whose owner/repo segment has no slash", () => {
		const env = new Map([["SFP_REPO_bad", "slug:justowner:main"]]);
		const out = loadRepos(env);
		expect(out).toEqual([]);
		expect(stderr).toContain("skipping malformed owner/repo in SFP_REPO_bad");
	});

	it("supports repo names that themselves contain slashes (splits owner off first)", () => {
		const env = new Map([["SFP_REPO_x", "x:owner/nested/name:trunk"]]);
		const out = loadRepos(env);
		expect(out).toEqual([
			{ slug: "x", owner: "owner", repo: "nested/name", default_branch: "trunk" },
		]);
	});

	it("returns entries in insertion order", () => {
		const env = new Map([
			["SFP_REPO_a", "a:o/r:main"],
			["OTHER", "ignored"],
			["SFP_REPO_b", "b:o/r2:trunk"],
		]);
		const out = loadRepos(env);
		expect(out.map((r) => r.slug)).toEqual(["a", "b"]);
	});
});

// ---------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------

describe("slugify", () => {
	it("lowercases and hyphenates a normal phrase", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});
	it("collapses runs of non-alnum into a single hyphen", () => {
		expect(slugify("a   b---c__d")).toBe("a-b-c-d");
	});
	it("strips leading and trailing hyphens", () => {
		expect(slugify("---foo---")).toBe("foo");
	});
	it("returns 'task' for an empty string", () => {
		expect(slugify("")).toBe("task");
	});
	it("returns 'task' for a string with only non-alnum characters", () => {
		expect(slugify("!!!")).toBe("task");
	});
	it("keeps digits and lowercases letters", () => {
		expect(slugify("SEC-01")).toBe("sec-01");
	});
});

// ---------------------------------------------------------------------
// score
// ---------------------------------------------------------------------

describe("score", () => {
	it("returns 0 for an empty hint", () => {
		expect(score("", mkRepo())).toBe(0);
	});

	it("returns 100 for an exact slug match", () => {
		expect(score("prov", mkRepo())).toBe(100);
	});

	it("returns 100 for an exact owner/repo match", () => {
		expect(score("providence-labs/providence", mkRepo())).toBe(100);
	});

	it("returns 100 for an exact repo-name match", () => {
		expect(score("providence", mkRepo())).toBe(100);
	});

	it("is case-insensitive", () => {
		expect(score("PROV", mkRepo())).toBe(100);
	});

	it("returns 60 for an exact owner match", () => {
		expect(score("providence-labs", mkRepo({ slug: "prov", repo: "providence" }))).toBe(60);
	});

	it("returns 40 when the slug is contained in the hint", () => {
		expect(score("some prov keyword", mkRepo({ slug: "prov", repo: "unrelated" }))).toBe(40);
	});

	it("returns 40 when the hint is contained in the slug", () => {
		expect(score("pr", mkRepo({ slug: "prov", repo: "unrelated" }))).toBe(40);
	});

	it("returns 30 when the repo name is contained in the hint", () => {
		expect(score("The providence project", mkRepo({ slug: "unrelated", repo: "providence" }))).toBe(
			30,
		);
	});

	it("returns 30 when the hint is contained in the repo name", () => {
		expect(score("provi", mkRepo({ slug: "xyzzz", repo: "providence" }))).toBe(30);
	});

	it("returns 10 when only the owner substring appears in the hint", () => {
		expect(
			score(
				"some words mentioning providence-labs somewhere",
				mkRepo({ slug: "xyzzz", repo: "otherwise", owner: "providence-labs" }),
			),
		).toBe(10);
	});

	it("returns 0 when nothing overlaps", () => {
		expect(
			score(
				"totally unrelated",
				mkRepo({ slug: "xyzzz", repo: "wholly", owner: "differentowner" }),
			),
		).toBe(0);
	});

	it("trims and lowercases the hint before comparing", () => {
		expect(score("   PROV   ", mkRepo())).toBe(100);
	});
});

// ---------------------------------------------------------------------
// pick
// ---------------------------------------------------------------------

describe("pick", () => {
	it("returns [null, false] on an empty repo list", () => {
		const [picked, matched] = pick([], "anything");
		expect(picked).toBeNull();
		expect(matched).toBe(false);
	});

	it("returns [firstEntry, false] when nothing scores > 0", () => {
		// Pick strings that share NO single character with the hint --
		// score's substring branch fires on any overlap, including a
		// single-char owner appearing anywhere in the hint.
		const a = mkRepo({ slug: "xxx", owner: "yyy", repo: "zzz" });
		const b = mkRepo({ slug: "qqq", owner: "www", repo: "vvv" });
		const [picked, matched] = pick([a, b], "1234567890");
		expect(picked).toBe(a);
		expect(matched).toBe(false);
	});

	it("returns the exact match when one row matches", () => {
		const a = mkRepo({ slug: "a", owner: "oa", repo: "ra" });
		const b = mkRepo({ slug: "b", owner: "ob", repo: "rb" });
		const [picked, matched] = pick([a, b], "b");
		expect(picked).toBe(b);
		expect(matched).toBe(true);
	});

	it("breaks ties by insertion order (earlier row wins on equal scores)", () => {
		// Both rows would score 40 on "com" (slug contains hint), so the
		// earlier-declared row must win.
		const first = mkRepo({ slug: "compute", owner: "o", repo: "r1" });
		const second = mkRepo({ slug: "computer", owner: "o", repo: "r2" });
		const [picked, matched] = pick([first, second], "com");
		expect(matched).toBe(true);
		expect(picked).toBe(first);
	});

	it("prefers higher scores over insertion order", () => {
		const first = mkRepo({ slug: "unrelated", owner: "own", repo: "generic" });
		const second = mkRepo({ slug: "prov", owner: "p", repo: "providence" });
		const [picked] = pick([first, second], "prov");
		expect(picked).toBe(second);
	});

	it("returns matched=false and first entry when hint is empty", () => {
		const a = mkRepo({ slug: "a" });
		const b = mkRepo({ slug: "b" });
		const [picked, matched] = pick([a, b], "");
		expect(picked).toBe(a);
		expect(matched).toBe(false);
	});
});

// ---------------------------------------------------------------------
// resolveFixSrc
// ---------------------------------------------------------------------

describe("resolveFixSrc", () => {
	// The base is REPO_ROOT/discovery/fix-src -- REPO_ROOT is captured at
	// module import time, so we don't assert the absolute prefix. We
	// assert only the suffix, which is the interesting part.

	it("returns .../discovery/fix-src/<slug> when parallel_safe is false", () => {
		const p = resolveFixSrc("prov", "abc123", false);
		expect(p.endsWith(join("discovery", "fix-src", "prov"))).toBe(true);
	});

	it("ignores the task id when parallel_safe is false", () => {
		const p = resolveFixSrc("prov", "abc123", false);
		expect(p.includes("abc123")).toBe(false);
	});

	it("returns .../discovery/fix-src/<slug>-<taskslug> when parallel_safe && taskId", () => {
		const p = resolveFixSrc("prov", "SEC-01 flag", true);
		expect(p.endsWith(join("discovery", "fix-src", "prov-sec-01-flag"))).toBe(true);
	});

	it("drops the task suffix when parallel_safe is true but taskId is empty", () => {
		const p = resolveFixSrc("prov", "", true);
		expect(p.endsWith(join("discovery", "fix-src", "prov"))).toBe(true);
	});

	it("slugifies a non-alnum-only task id to 'task' before suffixing", () => {
		const p = resolveFixSrc("prov", "!!!", true);
		expect(p.endsWith(join("discovery", "fix-src", "prov-task"))).toBe(true);
	});
});

// ---------------------------------------------------------------------
// main() integration
// ---------------------------------------------------------------------

describe("main() integration", () => {
	let prevRepoRoot: string | undefined;
	let scratch: string;
	let stdout: string;
	let stderr: string;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		prevRepoRoot = process.env.TRP_REPO_ROOT;
		scratch = mkScratch();
		process.env.TRP_REPO_ROOT = scratch;
		stdout = "";
		stderr = "";
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stdout.write);
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stderr.write);
		delete process.env.TRP_PARALLEL_SAFE;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		if (prevRepoRoot === undefined) {
			delete process.env.TRP_REPO_ROOT;
		} else {
			process.env.TRP_REPO_ROOT = prevRepoRoot;
		}
		rmSync(scratch, { recursive: true, force: true });
		delete process.env.TRP_PARALLEL_SAFE;
	});

	it("exits 2 and warns when no sfp.env / trp.env files exist", async () => {
		const mod = await loadFresh();
		const code = await mod.main([]);
		expect(code).toBe(2);
		expect(stderr).toContain("no SFP_REPO_* entries in sfp.env");
	});

	it("exits 2 when sfp.env exists but has no SFP_REPO_* rows", async () => {
		writeFileSync(join(scratch, "sfp.env"), "# nothing\nOTHER=1\n");
		const mod = await loadFresh();
		const code = await mod.main([]);
		expect(code).toBe(2);
		expect(stderr).toContain("no SFP_REPO_* entries in sfp.env");
	});

	it("emits JSON with the matched entry on stdout and returns 0", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${[
				"SFP_REPO_prov=prov:providence-labs/providence:main",
				"SFP_REPO_hand=hand:handshake/handshake:trunk",
			].join("\n")}\n`,
		);
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "hand"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.slug).toBe("hand");
		expect(out.owner).toBe("handshake");
		expect(out.repo).toBe("handshake");
		expect(out.default_branch).toBe("trunk");
		// Single-worktree default (TRP_PARALLEL_SAFE unset) -> no task suffix
		// even though --task carried one.
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "hand"))).toBe(true);
		expect(stderr).toBe("");
	});

	it("falls back to the first entry with a stderr warning when nothing matches", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${["SFP_REPO_xxx=xxx:yyy/zzz:main", "SFP_REPO_qqq=qqq:www/vvv:main"].join("\n")}\n`,
		);
		const mod = await loadFresh();
		// A hint with no overlapping characters against any of the
		// slug/owner/repo strings above -- forces the fallback branch.
		const code = await mod.main(["--intent-hint", "1234567890"]);
		expect(code).toBe(0);
		expect(stderr).toContain("no match for intent-hint");
		expect(stderr).toContain('"1234567890"');
		expect(stderr).toContain('falling back to first entry "xxx"');
		const out = JSON.parse(stdout);
		expect(out.slug).toBe("xxx");
	});

	it("appends a task suffix to fix_src_path when TRP_PARALLEL_SAFE=true and --task carries an id", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${["TRP_PARALLEL_SAFE=true", "SFP_REPO_prov=prov:providence-labs/providence:main"].join(
				"\n",
			)}\n`,
		);
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov", "--task", "clickup:abc123"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "prov-abc123"))).toBe(true);
	});

	it("drops the task suffix when TRP_PARALLEL_SAFE=true but --task has no colon", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${["TRP_PARALLEL_SAFE=true", "SFP_REPO_prov=prov:providence-labs/providence:main"].join(
				"\n",
			)}\n`,
		);
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov", "--task", "nocolon"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "prov"))).toBe(true);
	});

	it("drops the task suffix when TRP_PARALLEL_SAFE is not literally 'true'", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${[
				"TRP_PARALLEL_SAFE=yes", // truthy-ish but not the sentinel
				"SFP_REPO_prov=prov:providence-labs/providence:main",
			].join("\n")}\n`,
		);
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov", "--task", "clickup:abc123"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "prov"))).toBe(true);
	});

	it("accepts --intent-hint=<val> and --task=<val> collapsed forms", async () => {
		writeFileSync(
			join(scratch, "sfp.env"),
			`${["TRP_PARALLEL_SAFE=true", "SFP_REPO_prov=prov:providence-labs/providence:main"].join(
				"\n",
			)}\n`,
		);
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint=prov", "--task=clickup:xyz"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.slug).toBe("prov");
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "prov-xyz"))).toBe(true);
	});

	it("handles empty argv (no --intent-hint) with a fallback warning and success", async () => {
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_only=only:o/only-repo:main\n");
		const mod = await loadFresh();
		const code = await mod.main([]);
		// Score returns 0 for an empty hint -> fallback to first entry with
		// a warning, still exit 0.
		expect(code).toBe(0);
		expect(stderr).toContain("no match for intent-hint");
		const out = JSON.parse(stdout);
		expect(out.slug).toBe("only");
	});

	it("lets sfp.env win over trp.env on a duplicated key", async () => {
		// The Python source updates trp.env first, then sfp.env -- so the
		// sfp.env value must survive. The TS port mirrors that order.
		writeFileSync(join(scratch, "trp.env"), "SFP_REPO_prov=prov:trp/wrong:trunk\n");
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_prov=prov:providence-labs/providence:main\n");
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.owner).toBe("providence-labs");
		expect(out.repo).toBe("providence");
		expect(out.default_branch).toBe("main");
	});

	it("reads TRP_PARALLEL_SAFE from trp.env when it isn't in sfp.env", async () => {
		writeFileSync(join(scratch, "trp.env"), "TRP_PARALLEL_SAFE=true\n");
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_prov=prov:providence-labs/providence:main\n");
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov", "--task", "clickup:xyz"]);
		expect(code).toBe(0);
		const out = JSON.parse(stdout);
		expect(out.fix_src_path.endsWith(join("discovery", "fix-src", "prov-xyz"))).toBe(true);
	});

	it("terminates the stdout JSON with a trailing newline", async () => {
		writeFileSync(join(scratch, "sfp.env"), "SFP_REPO_prov=prov:providence-labs/providence:main\n");
		const mod = await loadFresh();
		const code = await mod.main(["--intent-hint", "prov"]);
		expect(code).toBe(0);
		expect(stdout.endsWith("\n")).toBe(true);
		// Path separator is platform-native (`join()` in the module), so
		// tests running on POSIX see `/` as `sep`.
		expect(sep).toMatch(/[\\/u]/u);
	});
});
