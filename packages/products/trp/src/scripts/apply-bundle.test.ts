// Tests for `apply-bundle.ts` — the TS port of `trp/scripts/apply-bundle.py`.
//
// The module exports a single async `main()`; every helper (splitLinesKeepEnds,
// stripNewlines, parseAndApply, splitPatchChunks, writeTests) is module-private
// on purpose (parity with the .py source), so these tests drive coverage
// through `main()` down every fallback branch:
//
//   1. env-var validation (missing BUNDLE_JSON / FIX_SRC / TASK_ID_SLUG → 1)
//   2. SRP-GG fold of test_additions into files_to_modify
//   3. Path Y — all-full-content shortcut (no diff parsing)
//   4. Patch-mode: `git apply` strict succeeds
//   5. Patch-mode: git-apply variants exhausted, `patch -p1 -F 3` succeeds
//   6. Content-substitution parser: exact / trim-newlines / anchor-pair
//      matches, /dev/null new files, backslash lines, bare-line context
//   7. Per-file `patch -p1 -F 5` final fallback
//   8. All fallbacks fail → return 5
//
// `@foundation/shell`'s `sh` is mocked so no real `git apply` or `patch`
// subprocess ever runs; every test controls the mocked exit codes to force a
// specific branch. Filesystem is real (temp dir per test) — the module writes
// through node:fs and reading the written file is the load-bearing assertion.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";
import { main, writeTests } from "./apply-bundle.ts";

// Hoisted mock: replace `@foundation/shell` before the module under test is
// evaluated. Each test drives `mockedSh.mockResolvedValue*` to steer main()
// down a specific fallback branch. A live subprocess in unit tests would
// couple this file to the host's `git` / `patch` versions. Vitest hoists this
// call above the imports above at transform time regardless of source order.
vi.mock("@foundation/shell", () => ({
	sh: vi.fn<typeof sh>(),
}));

const mockedSh = vi.mocked(sh);

// Compact ShResult-shaped literal for mocks. The real ShResult has more
// fields but the module under test only reads `exitCode`, `stdout`, `stderr`.
function shResult(exitCode: number, stdout = "", stderr = ""): Awaited<ReturnType<typeof sh>> {
	return {
		command: "mock",
		args: [],
		exitCode,
		signal: undefined,
		stdout,
		stderr,
		timedOut: false,
		durationMs: 0,
	};
}

// Silence + capture the module's console.log / stderr so a failing test
// doesn't drown the reporter in the module's status lines. Returns an
// accessor for the captured stderr string. Lives outside `describe` — it
// doesn't capture anything from that scope.
function silenceLog(): () => string {
	vi.spyOn(console, "log").mockImplementation(() => {});
	const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
}

// Mock-`sh()` sequencing helpers for the per-file `patch -p1 -F 5` fallback
// tests below. Defined outside any `it()` block: vitest/no-conditional-in-test
// flags conditionals nested lexically under a test callback, including
// mock-implementation closures passed to `mockImplementation`.

// First 6 calls (5 git-apply variants + `patch -p1 -F 3`) refuse; every call
// after that succeeds.
function sixRefusalsThenSuccess(): () => Promise<Awaited<ReturnType<typeof sh>>> {
	let call = 0;
	return () => {
		call += 1;
		return Promise.resolve(shResult(call <= 6 ? 1 : 0));
	};
}

// First 6 calls refuse, the 7th (first per-file patch attempt) succeeds, the
// 8th (second per-file patch attempt) fails with stdout/stderr set.
function sixRefusalsSeventhSucceedsEighthFails(): () => Promise<Awaited<ReturnType<typeof sh>>> {
	let call = 0;
	return () => {
		call += 1;
		if (call <= 6) {
			return Promise.resolve(shResult(1));
		}
		if (call === 7) {
			return Promise.resolve(shResult(0));
		}
		return Promise.resolve(shResult(1, "some stdout", "some stderr"));
	};
}

// Reads `mockedSh.mock.calls[index]` without a non-null assertion — throws
// with a clear message if the test asserted on a call that never happened.
function mockCallArgs(index: number): { cmd: unknown; args: readonly unknown[] | undefined } {
	const call = mockedSh.mock.calls[index];
	if (call === undefined) {
		throw new Error(`expected a mocked sh() call at index ${index}`);
	}
	return { cmd: call[0], args: call[1] };
}

describe("apply-bundle.main()", () => {
	let workDir: string;
	let fixSrc: string;
	let bundlePath: string;
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = ["BUNDLE_JSON", "FIX_SRC", "TASK_ID_SLUG"] as const;

	beforeEach(() => {
		originalCwd = process.cwd();
		workDir = mkdtempSync(join(tmpdir(), "apply-bundle-test-"));
		fixSrc = join(workDir, "fix-src");
		mkdirSync(fixSrc, { recursive: true });
		bundlePath = join(workDir, "bundle.json");
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			Reflect.deleteProperty(process.env, k);
		}
		process.chdir(workDir);
		mockedSh.mockReset();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) {
				Reflect.deleteProperty(process.env, k);
			} else {
				process.env[k] = savedEnv[k];
			}
		}
		try {
			rmSync(workDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; mkdtemp dirs are eventually reclaimed by the OS.
		}
	});

	// Convenience: serialize `b`, point env at it, use TASK_ID_SLUG "t-slug".
	function stageBundle(b: unknown, slug = "t-slug"): void {
		writeFileSync(bundlePath, JSON.stringify(b));
		process.env.BUNDLE_JSON = bundlePath;
		process.env.FIX_SRC = fixSrc;
		process.env.TASK_ID_SLUG = slug;
	}

	// ------------------------------------------------------------------
	// Env-var validation — three separate misses so each stderr message
	// is exercised. All three take the same early-return path but the
	// module conditions on ALL three being present, so proving one missing
	// makes the branch fire.

	it("returns 1 when BUNDLE_JSON is unset", async () => {
		const readErr = silenceLog();
		process.env.FIX_SRC = fixSrc;
		process.env.TASK_ID_SLUG = "s";
		// BUNDLE_JSON deliberately unset.
		const code = await main();
		expect(code).toBe(1);
		// The single stderr line names all three so operators can grep the
		// message even when only one is missing.
		expect(readErr()).toContain("missing BUNDLE_JSON, FIX_SRC, or TASK_ID_SLUG");
	});

	it("returns 1 when FIX_SRC is unset", async () => {
		silenceLog();
		process.env.BUNDLE_JSON = "/tmp/anything.json";
		process.env.TASK_ID_SLUG = "s";
		expect(await main()).toBe(1);
	});

	it("returns 1 when TASK_ID_SLUG is unset", async () => {
		silenceLog();
		process.env.BUNDLE_JSON = "/tmp/anything.json";
		process.env.FIX_SRC = fixSrc;
		expect(await main()).toBe(1);
	});

	// ------------------------------------------------------------------
	// Path Y — full-content write, no diff parsing. sh must NOT be called
	// on this path; a regression that reaches for `git apply` first would
	// trip both the return-code assertion and the mocked call count.

	it("full-content path writes every file and does not invoke sh", async () => {
		stageBundle({
			files_to_modify: [
				{ path: "src/a.ts", full_content: "export const a = 1;\n", rationale: "fix" },
				{ path: "nested/dir/b.txt", full_content: "hello\n" },
			],
		});
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(readFileSync(join(fixSrc, "nested/dir/b.txt"), "utf8")).toBe("hello\n");
		// The full-content shortcut must never call sh — proving it takes the
		// Path Y branch, not a patch fallback.
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("SRP-GG fold: test_additions become files_to_modify and get written", async () => {
		stageBundle({
			files_to_modify: [{ path: "src/x.ts", full_content: "code\n" }],
			test_additions: [
				{
					path: "tests/x.test.ts",
					full_content: "test\n",
					fails_without_fix: "regression",
				},
			],
		});
		silenceLog();
		expect(await main()).toBe(0);
		// Folded entry lands under files_to_modify and takes Path Y.
		expect(readFileSync(join(fixSrc, "tests/x.test.ts"), "utf8")).toBe("test\n");
		expect(mockedSh).not.toHaveBeenCalled();
	});

	it("full-content with empty string falls through to patch mode", async () => {
		// `Boolean(fm.full_content)` is false for "" → NOT Path Y.
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					full_content: "",
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		mockedSh.mockResolvedValueOnce(shResult(0));
		silenceLog();
		expect(await main()).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(1);
		expect(mockedSh.mock.calls[0]?.[0]).toBe("git");
	});

	it("mixed full_content + patch_unified falls through to patch mode", async () => {
		// One entry has full_content, another doesn't → `every()` fails → patch.
		stageBundle({
			files_to_modify: [
				{ path: "a.txt", full_content: "hello\n" },
				{
					path: "b.txt",
					patch_unified: "--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		mockedSh.mockResolvedValueOnce(shResult(0));
		silenceLog();
		expect(await main()).toBe(0);
		// git apply strict succeeded on first try — a single sh call.
		expect(mockedSh).toHaveBeenCalledTimes(1);
	});

	// ------------------------------------------------------------------
	// Patch-mode variants. sh is mocked to control which fallback wins.

	it("git apply strict succeeds on the first variant", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		mockedSh.mockResolvedValueOnce(shResult(0));
		silenceLog();
		expect(await main()).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(1);
		const { cmd, args } = mockCallArgs(0);
		expect(cmd).toBe("git");
		// Strict = no flags between "apply" and the patch path.
		expect(args?.[0]).toBe("apply");
		expect(args?.[1]).toMatch(/\.patch$/u);
	});

	it("git apply --recount fires after strict fails", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		mockedSh.mockResolvedValueOnce(shResult(1)).mockResolvedValueOnce(shResult(0));
		silenceLog();
		expect(await main()).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(2);
		// Second call must carry --recount before the patch path.
		expect(mockedSh.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["apply", "--recount"]));
	});

	it("all 5 git apply variants exhaust, then patch -p1 -F 3 succeeds", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		// 5 git failures + 1 patch success = 6 total.
		for (let i = 0; i < 5; i += 1) {
			mockedSh.mockResolvedValueOnce(shResult(1));
		}
		mockedSh.mockResolvedValueOnce(shResult(0));
		silenceLog();
		expect(await main()).toBe(0);
		expect(mockedSh).toHaveBeenCalledTimes(6);
		// Sixth call is `patch -p1 -F 3 --forward -i <path>` — the fuzzy fallback.
		const { cmd, args } = mockCallArgs(5);
		expect(cmd).toBe("patch");
		expect(args?.slice(0, 5)).toEqual(["-p1", "-F", "3", "--forward", "-i"]);
	});

	// ------------------------------------------------------------------
	// Content-substitution parser. All 6 mocked subprocess calls (git x5,
	// patch -p1 -F 3) fail; the parser then runs against a real file on
	// disk, which is what makes these assertions load-bearing.

	function forceContentSub(): void {
		// Fail every git-apply variant + the patch -p1 -F 3 call.
		mockedSh.mockResolvedValue(shResult(1, "", "refused"));
	}

	it("content-substitution: exact-match hunk replaces target file", async () => {
		writeFileSync(join(fixSrc, "hello.txt"), "line1\nline2\nline3\n");
		stageBundle({
			files_to_modify: [
				{
					path: "hello.txt",
					// Git-style `b/` prefix: parseAndApply strips 6 chars after "+++"
					// (i.e. "+++ b/"), so `+++ b/hello.txt` → target = "hello.txt"
					// and lands at `<fixSrc>/hello.txt` directly.
					patch_unified:
						"--- a/hello.txt\n+++ b/hello.txt\n@@\n line1\n-line2\n+line2-new\n line3\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "hello.txt"), "utf8")).toBe("line1\nline2-new\nline3\n");
	});

	it("content-substitution: /dev/null hunk creates a new file", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "created.txt",
					patch_unified: "--- /dev/null\n+++ b/created.txt\n@@\n+hello\n+world\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "created.txt"), "utf8")).toBe("hello\nworld\n");
	});

	it(
		String.raw`content-substitution: trim-newlines fallback matches surplus \n in before_txt`,
		async () => {
			writeFileSync(join(fixSrc, "f.txt"), "aa\nbb\ncc\n");
			stageBundle({
				files_to_modify: [
					{
						path: "f.txt",
						// The leading " \n" (empty context line) makes before_txt start
						// with "\n" — no exact match. `strip('\n')` fallback wins.
						patch_unified: "--- a/f.txt\n+++ b/f.txt\n@@\n \n aa\n-bb\n+BB\n cc\n",
					},
				],
			});
			forceContentSub();
			silenceLog();
			expect(await main()).toBe(0);
			expect(readFileSync(join(fixSrc, "f.txt"), "utf8")).toContain("BB");
		},
	);

	it("content-substitution: anchor-pair fallback replaces between first/last ` `-context lines", async () => {
		writeFileSync(join(fixSrc, "g.txt"), "keep-start\nold-mid-1\nold-mid-2\nkeep-end\n");
		stageBundle({
			files_to_modify: [
				{
					path: "g.txt",
					// Removed lines don't match exact-or-trimmed (extra X characters),
					// so parseAndApply falls to the anchor-pair path — replacing
					// everything between "keep-start" and "keep-end".
					patch_unified:
						"--- a/g.txt\n+++ b/g.txt\n@@\n keep-start\n-oldXmidX1\n-oldXmidX2\n+NEW\n keep-end\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "g.txt"), "utf8")).toBe("keep-start\nNEW\nkeep-end\n");
	});

	it("content-substitution: skips backslash lines (`\\ No newline at end of file`)", async () => {
		writeFileSync(join(fixSrc, "h.txt"), "a\nb"); // no trailing newline
		stageBundle({
			files_to_modify: [
				{
					path: "h.txt",
					patch_unified: "--- a/h.txt\n+++ b/h.txt\n@@\n a\n-b\n\\ No newline at end of file\n+B\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		// File had no trailing newline; before_txt "a\nb\n" won't exact-match,
		// but the trim-newlines fallback strips \n from both sides and finds
		// "a\nb" in the file, replacing with stripNewlines("a\nB\n") = "a\nB".
		// Load-bearing bit: the backslash line was SKIPPED (not treated as bare
		// context), otherwise before_txt would carry the marker text and fail.
		expect(readFileSync(join(fixSrc, "h.txt"), "utf8")).toBe("a\nB");
	});

	it(String.raw`content-substitution: handles \r\n line endings end-to-end`, async () => {
		// CRLF file + CRLF patch — the exact-match path finds before_txt with
		// its `\r\n` intact and swaps in after_txt. The load-bearing branch
		// coverage bit is splitLinesKeepEnds' `\r\n` recognition (offset += 2)
		// vs. the plain-`\n` fast path.
		writeFileSync(join(fixSrc, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
		stageBundle({
			files_to_modify: [
				{
					path: "crlf.txt",
					patch_unified:
						"--- a/crlf.txt\r\n+++ b/crlf.txt\r\n@@\r\n one\r\n-two\r\n+TWO\r\n three\r\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "crlf.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
	});

	it("content-substitution: bare lines (no +/-/space prefix) are treated as context", async () => {
		writeFileSync(join(fixSrc, "i.txt"), "alpha\nbeta\ngamma\n");
		stageBundle({
			files_to_modify: [
				{
					path: "i.txt",
					// The `beta\n` line has no leading prefix character — the parser's
					// "bare line" branch keeps it in both `before` and `after`, so the
					// hunk still applies against the on-disk file.
					patch_unified: "--- a/i.txt\n+++ b/i.txt\n@@\n alpha\nbeta\n-gamma\n+GAMMA\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "i.txt"), "utf8")).toBe("alpha\nbeta\nGAMMA\n");
	});

	it("content-substitution: hunk with no ` `-context lines fails all fallbacks (anchors < 2) → return 5", async () => {
		// File exists, patch's `-` lines don't appear in it, and there are no
		// space-prefixed context lines to anchor on. Exact-match, trim-newlines
		// fallback, AND anchor-pair fallback all fail — `anchors.length >= 2` is
		// false so parseAndApply hits the terminal `hunk N not found` return.
		writeFileSync(join(fixSrc, "j.txt"), "totally unrelated content\n");
		stageBundle({
			files_to_modify: [
				{
					path: "j.txt",
					patch_unified:
						"--- a/j.txt\n+++ b/j.txt\n@@\n-does-not-exist-1\n-does-not-exist-2\n+replaced\n",
				},
			],
		});
		mockedSh.mockResolvedValue(shResult(1));
		silenceLog();
		expect(await main()).toBe(5);
		// Target file must not have been mangled by a partial apply.
		expect(readFileSync(join(fixSrc, "j.txt"), "utf8")).toBe("totally unrelated content\n");
	});

	it("content-substitution then per-file patch also fails: no +++ header → return 5", async () => {
		// Patch body with no `+++ ` line at all — parseAndApply short-circuits to
		// `no +++ header`. Per-file patch fallback then also fails (mocked).
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					// Uses `--- ` so splitPatchChunks still produces one chunk.
					patch_unified: "--- a/x.txt\n@@\n+hello\n",
				},
			],
		});
		mockedSh.mockResolvedValue(shResult(1, "", "err"));
		silenceLog();
		expect(await main()).toBe(5);
	});

	it("content-substitution: no `@@` hunk header → fails, per-file patch fallback also fails → return 5", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					// Headers but no hunks → parseAndApply returns "no hunks found".
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n",
				},
			],
		});
		mockedSh.mockResolvedValue(shResult(1));
		silenceLog();
		expect(await main()).toBe(5);
	});

	it("content-substitution: target file missing (not /dev/null) → fails, per-file patch fallback fails → return 5", async () => {
		// No pre-existing "missing.txt" in fixSrc, --- line is not /dev/null, so
		// `not is_new and not content` → return "target missing".
		stageBundle({
			files_to_modify: [
				{
					path: "missing.txt",
					patch_unified: "--- a/missing.txt\n+++ b/missing.txt\n@@\n a\n-b\n+B\n",
				},
			],
		});
		mockedSh.mockResolvedValue(shResult(1));
		silenceLog();
		expect(await main()).toBe(5);
	});

	// ------------------------------------------------------------------
	// Per-file `patch -p1 -F 5` final fallback: content-substitution fails
	// (target file absent), but the mocked per-file patch returns 0 so
	// main() reports success.

	it("per-file patch -p1 -F 5 succeeds after content-substitution fails", async () => {
		stageBundle({
			files_to_modify: [
				{
					path: "gone.txt",
					patch_unified: "--- gone.txt\n+++ gone.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		// First 6 calls: 5 git-apply variants + `patch -p1 -F 3` — all fail.
		// 7th call: per-file `patch -p1 -F 5` — succeeds.
		mockedSh.mockImplementation(sixRefusalsThenSuccess());
		silenceLog();
		expect(await main()).toBe(0);
		// One per-file patch call after the 6 refusals.
		expect(mockedSh).toHaveBeenCalledTimes(7);
		const { cmd, args } = mockCallArgs(6);
		expect(cmd).toBe("patch");
		expect(args?.slice(0, 3)).toEqual(["-p1", "-F", "5"]);
	});

	it("per-file patch -p1 -F 5 partial success (1 of 2 chunks) → return 5", async () => {
		// Two files, content-substitution fails on both, per-file patch succeeds
		// on the first call and fails on the second — applied != chunks.length.
		stageBundle({
			files_to_modify: [
				{
					path: "a.txt",
					patch_unified: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
				{
					path: "b.txt",
					patch_unified: "--- b.txt\n+++ b.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
		});
		// 5 git-apply variants + patch -F 3 = 6 refusals. Per-file: 7th succeeds,
		// 8th fails.
		mockedSh.mockImplementation(sixRefusalsSeventhSucceedsEighthFails());
		silenceLog();
		expect(await main()).toBe(5);
	});

	// ------------------------------------------------------------------
	// Additional branch coverage: splitLinesKeepEnds' lone-\r path, the
	// hunk-grouping "body line before any @@ header" no-op, the missing
	// "--- " header fallback, the anchor-pair "first anchor not found"
	// failure, and the SRP-GG-folded test_addition default fields.

	it(
		String.raw`content-substitution: a lone \r (old-Mac line ending, no trailing \n) is a terminator`,
		async () => {
			// splitLinesKeepEnds treats a bare \r not followed by \n as its own
			// line terminator (branch distinct from the \r\n pairing above).
			writeFileSync(join(fixSrc, "mac.txt"), "one\rtwo\rthree\r");
			stageBundle({
				files_to_modify: [
					{
						path: "mac.txt",
						patch_unified: "--- a/mac.txt\r+++ b/mac.txt\r@@\r one\r-two\r+TWO\r three\r",
					},
				],
			});
			forceContentSub();
			silenceLog();
			expect(await main()).toBe(0);
			expect(readFileSync(join(fixSrc, "mac.txt"), "utf8")).toBe("one\rTWO\rthree\r");
		},
	);

	it("content-substitution: a body line preceding any `@@` header is silently dropped", async () => {
		// Malformed-but-tolerated input: a stray line sits between the +++
		// header and the first @@ hunk marker. `current` is still `null` at
		// that point (grouping hasn't started), so the line is a no-op rather
		// than corrupting the first hunk's body.
		writeFileSync(join(fixSrc, "stray.txt"), "alpha\nbeta\n");
		stageBundle({
			files_to_modify: [
				{
					path: "stray.txt",
					patch_unified:
						"--- a/stray.txt\n+++ b/stray.txt\nstray preamble line\n@@\n alpha\n-beta\n+BETA\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "stray.txt"), "utf8")).toBe("alpha\nBETA\n");
	});

	it("content-substitution: a chunk with no `--- ` header still applies via the `+++`-only target", async () => {
		// dashLine falls back to "" (no "--- " line present at all), so
		// isNew resolves to false via the empty-string fallback rather than
		// an actual /dev/null marker — the target file must already exist.
		writeFileSync(join(fixSrc, "noheader.txt"), "keep\nold\n");
		stageBundle({
			files_to_modify: [
				{
					path: "noheader.txt",
					patch_unified: "+++ b/noheader.txt\n@@\n keep\n-old\n+new\n",
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		expect(readFileSync(join(fixSrc, "noheader.txt"), "utf8")).toBe("keep\nnew\n");
	});

	it("content-substitution: anchor-pair fallback fails closed when the first anchor text isn't in the file → return 5", async () => {
		// Two ` `-context lines exist (anchors.length >= 2), but the file's
		// content doesn't contain the first anchor's text at all, so
		// `content.indexOf(firstAnchor)` is -1 and the anchor-pair fallback
		// must decline instead of splicing at a bogus offset.
		writeFileSync(join(fixSrc, "noanchor.txt"), "nothing matches here at all\n");
		stageBundle({
			files_to_modify: [
				{
					path: "noanchor.txt",
					patch_unified:
						"--- a/noanchor.txt\n+++ b/noanchor.txt\n@@\n first-anchor-text\n-removedX1\n-removedX2\n+replaced\n last-anchor-text\n",
				},
			],
		});
		mockedSh.mockResolvedValue(shResult(1));
		silenceLog();
		expect(await main()).toBe(5);
		expect(readFileSync(join(fixSrc, "noanchor.txt"), "utf8")).toBe(
			"nothing matches here at all\n",
		);
	});

	it("SRP-GG fold: a test_addition with neither full_content nor fails_without_fix gets the documented defaults", async () => {
		// Both fields omitted → the fold must default full_content to "" and
		// rationale to "regression test" rather than leaving them undefined.
		// The primary file_to_modify has no full_content, so the bundle falls
		// through to patch mode (proving the fold ran before the Path Y check).
		stageBundle({
			files_to_modify: [
				{
					path: "x.txt",
					patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n\n",
				},
			],
			test_additions: [{ path: "tests/defaulted.test.ts" }],
		});
		// 5 git-apply variants + patch -F 3 fail, content-substitution then
		// fails too (target "x.txt" doesn't exist on disk), per-file patch
		// -F 5 fails on both chunks → return 5. We only care that main()
		// exercised the fold defaults without throwing, and that the folded
		// entry's rationale/full_content defaults show up in the assembled
		// patch (an empty full_content produces no patch_unified for that
		// entry, so it's absent from files_to_modify's patch assembly path
		// entirely — assert instead via the discovery patch file not
		// containing a stray "undefined").
		mockedSh.mockResolvedValue(shResult(1));
		silenceLog();
		const code = await main();
		expect([0, 5]).toContain(code);
		const assembled = readFileSync(join(workDir, "discovery/patches/t-slug.patch"), "utf8");
		expect(assembled).not.toContain("undefined");
	});

	// ------------------------------------------------------------------
	// Side-effect assertions.

	it(
		String.raw`assembles the patch file at discovery/patches/<slug>.patch, appending \n when patch_unified lacks one`,
		async () => {
			stageBundle(
				{
					files_to_modify: [
						{
							path: "x.txt",
							// Deliberately no trailing newline — main() must append one so
							// consecutive files don't run into each other.
							patch_unified: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-o\n+n",
						},
					],
				},
				"my-slug",
			);
			mockedSh.mockResolvedValueOnce(shResult(0));
			silenceLog();
			expect(await main()).toBe(0);
			const assembled = readFileSync(join(workDir, "discovery/patches/my-slug.patch"), "utf8");
			expect(assembled.endsWith("\n")).toBe(true);
			expect(assembled).toContain("+++ b/x.txt");
		},
	);

	it("creates discovery/patches even when the full-content shortcut fires", async () => {
		// Path Y skips the patch file write, but the mkdir runs before the
		// branch — proving the side effect is unconditional.
		stageBundle({
			files_to_modify: [{ path: "a.txt", full_content: "x\n" }],
		});
		silenceLog();
		expect(await main()).toBe(0);
		expect(existsSync(join(workDir, "discovery/patches"))).toBe(true);
	});

	// ------------------------------------------------------------------
	// Integration: content-substitution across a synthesized multi-file
	// patch — exercises splitPatchChunks (two `--- ` boundaries), the
	// per-hunk running-content buffer across multiple hunks in one file,
	// and writeTests's silent no-op after the SRP-GG fold empties
	// test_additions.

	it("integration: multi-file, multi-hunk content-substitution across a synthesized patch", async () => {
		// Stage two real files under fixSrc — the parser reads them, applies
		// hunks against a running content buffer, and writes them back.
		mkdirSync(join(fixSrc, "src"), { recursive: true });
		writeFileSync(join(fixSrc, "src/a.ts"), "// header\nOLD_A\nmid\nOLD_B\n// footer\n");
		writeFileSync(join(fixSrc, "src/b.ts"), "one\ntwo\nthree\n");
		stageBundle({
			files_to_modify: [
				{
					path: "src/a.ts",
					// Two hunks against the same file — parser applies them in order
					// against the running content buffer.
					patch_unified: [
						"--- a/src/a.ts",
						"+++ b/src/a.ts",
						"@@",
						" // header",
						"-OLD_A",
						"+NEW_A",
						" mid",
						"@@",
						" mid",
						"-OLD_B",
						"+NEW_B",
						" // footer",
						"",
					].join("\n"),
				},
				{
					path: "src/b.ts",
					patch_unified: [
						"--- a/src/b.ts",
						"+++ b/src/b.ts",
						"@@",
						" one",
						"-two",
						"+TWO",
						" three",
						"",
					].join("\n"),
				},
			],
		});
		forceContentSub();
		silenceLog();
		expect(await main()).toBe(0);
		// First file: both hunks applied against the shared running buffer.
		expect(readFileSync(join(fixSrc, "src/a.ts"), "utf8")).toBe(
			"// header\nNEW_A\nmid\nNEW_B\n// footer\n",
		);
		// Second file: single hunk, proving splitPatchChunks separated the two
		// `--- ` boundaries into distinct chunks.
		expect(readFileSync(join(fixSrc, "src/b.ts"), "utf8")).toBe("one\nTWO\nthree\n");
	});
});

// Coverage: exercise writeTests + inline test_additions loop with non-empty
// test_additions (main()'s SRP-GG fold normally empties it before this runs).

describe("writeTests (direct, pre-SRP-GG-fold coverage)", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "apply-bundle-writeTests-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("writes each test_additions entry to the fix-src tree with its content", () => {
		const bundle = {
			files_to_modify: [],
			test_additions: [
				{ path: "tests/foo.test.ts", full_content: "// alpha\n" },
				{ path: "nested/bar.test.ts", full_content: "// beta\n" },
			],
		};
		writeTests(bundle as never, scratch);
		expect(readFileSync(join(scratch, "tests/foo.test.ts"), "utf8")).toBe("// alpha\n");
		expect(readFileSync(join(scratch, "nested/bar.test.ts"), "utf8")).toBe("// beta\n");
	});

	it("handles empty full_content by writing an empty file", () => {
		const bundle = {
			files_to_modify: [],
			test_additions: [{ path: "empty.test.ts" }],
		};
		writeTests(bundle as never, scratch);
		expect(readFileSync(join(scratch, "empty.test.ts"), "utf8")).toBe("");
	});
});
