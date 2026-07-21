#!/usr/bin/env node
/**
 * `apply-bundle.ts` — TS port of `trp/scripts/apply-bundle.py`.
 *
 * Applies a TRP bundle's patches to `$FIX_SRC`. Called from
 * `scripts/fix-task.sh`.
 *
 * Env vars expected: `BUNDLE_JSON`, `FIX_SRC`, `TASK_ID_SLUG`.
 *
 * Try in order:
 *   1. `git apply` on the multi-file patch (strictest — five option variants).
 *   2. `patch -p1 -F 3` on the multi-file patch (fuzzy, forgiving of bare @@).
 *   3. Content-substitution parser (per-hunk running-content buffer).
 *   4. Per-file `patch -p1 -F 5` (isolate a bad file without dropping the rest).
 *
 * Workflow-generated patches often use bare `@@` hunks (no line ranges) —
 * GNU/BSD `patch` handles those; `git apply` does not.
 *
 * Ported byte-for-byte from the Python original: every branch, every fallback
 * ordering, every exit code preserved. No feature additions.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sh } from "@foundation/shell";

type FileToModify = {
	path: string;
	full_content?: string;
	patch_unified?: string;
	rationale?: string;
};

type TestAddition = {
	path: string;
	full_content?: string;
	fails_without_fix?: string;
};

type Bundle = {
	files_to_modify: FileToModify[];
	test_additions?: TestAddition[];
};

type RunResult = {
	readonly returncode: number;
	readonly stdout: string;
	readonly stderr: string;
};

// Python `subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)` shim.
async function run(cmd: string, args: readonly string[], cwd?: string): Promise<RunResult> {
	const r = await sh(cmd, args, { cwd, rejectOnError: false, timeout: 0 });
	return { returncode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// Python `str.splitlines(keepends=True)` — split on \n, \r\n, or \r, keeping
// the terminator on each returned line. A final line without a terminator is
// preserved verbatim.
function splitLinesKeepEnds(s: string): string[] {
	const lines: string[] = [];
	let start = 0;
	let i = 0;
	while (i < s.length) {
		const ch = s.codePointAt(i);
		if (ch === 0x0a /* \n */) {
			lines.push(s.slice(start, i + 1));
			start = i + 1;
			i += 1;
		} else if (ch === 0x0d /* \r */) {
			if (s.codePointAt(i + 1) === 0x0a) {
				lines.push(s.slice(start, i + 2));
				start = i + 2;
				i += 2;
			} else {
				lines.push(s.slice(start, i + 1));
				start = i + 1;
				i += 1;
			}
		} else {
			i += 1;
		}
	}
	if (start < s.length) {
		lines.push(s.slice(start));
	}
	return lines;
}

// Python `s.strip('\n')` — strip only newline characters from both ends.
function stripNewlines(s: string): string {
	let a = 0;
	let b = s.length;
	while (a < b && s[a] === "\n") {
		a += 1;
	}
	while (b > a && s[b - 1] === "\n") {
		b -= 1;
	}
	return s.slice(a, b);
}

// SRP-side helper mirroring the Python `write_tests_and_exit` body (minus the
// exit). Called from every successful apply branch. After the SRP-GG fold at
// the top of main(), `b.test_additions` is always empty here — the loop is
// kept for structural parity with the source.
export function writeTests(b: Bundle, fixSrc: string): void {
	for (const t of b.test_additions ?? []) {
		const dst = join(fixSrc, t.path);
		mkdirSync(dirname(dst), { recursive: true });
		writeFileSync(dst, t.full_content ?? "");
		process.stdout.write(`   wrote test file: ${t.path}\n`);
	}
}

// Content-substitution parser. Processes each hunk individually against a
// running content buffer with whitespace-tolerant context matching. Returns
// [ok, msg] — msg is the target path on success or the failure reason.
function parseAndApply(chunk: string, fixSrcDir: string): [boolean, string] {
	const lines = splitLinesKeepEnds(chunk);
	const plusLine = lines.find((l) => l.startsWith("+++ "));
	if (plusLine === undefined) {
		return [false, "no +++ header"];
	}
	const target = plusLine.slice(6).trim().split("\t")[0] ?? "";
	const targetPath = join(fixSrcDir, target);
	// Group lines into per-hunk blocks (each starts with @@).
	const hunks: string[][] = [];
	let current: string[] | null = null;
	for (const l of lines) {
		if (l.startsWith("--- ") || l.startsWith("+++ ")) {
			// Header line — not part of any hunk body.
		} else if (l.startsWith("@@")) {
			if (current !== null) {
				hunks.push(current);
			}
			current = [];
		} else if (current !== null) {
			current.push(l);
		}
	}
	if (current !== null) {
		hunks.push(current);
	}
	if (hunks.length === 0) {
		return [false, "no hunks found"];
	}
	const dashLine = lines.find((l) => l.startsWith("--- ")) ?? "";
	const isNew = dashLine.includes("/dev/null");
	let content = "";
	if (!isNew) {
		try {
			content = readFileSync(targetPath, "utf8");
		} catch {
			content = "";
		}
	}
	if (!isNew && !content) {
		return [false, `target missing: ${target}`];
	}
	// Apply each hunk in order to the running content.
	for (let hi = 0; hi < hunks.length; hi += 1) {
		const hunkLines = hunks[hi] ?? [];
		const before: string[] = [];
		const after: string[] = [];
		for (const l of hunkLines) {
			const c = l.length > 0 ? l[0] : "";
			const body = c === "+" || c === "-" || c === " " ? l.slice(1) : l;
			if (c === "+") {
				after.push(body);
			} else if (c === "-") {
				before.push(body);
			} else if (c === " ") {
				before.push(body);
				after.push(body);
			} else if (c === "\\") {
				// Skip `\ No newline at end of file` markers — neither before nor after.
			} else {
				// Bare line — treat as context (workflow sometimes drops the
				// leading space on context lines).
				before.push(l);
				after.push(l);
			}
		}
		const beforeTxt = before.join("");
		const afterTxt = after.join("");
		if (isNew) {
			content += afterTxt;
		} else if (content.includes(beforeTxt)) {
			// String-arg `.replace` in JS replaces only the first occurrence —
			// matches Python's `content.replace(before_txt, after_txt, 1)`.
			content = content.replace(beforeTxt, afterTxt);
		} else {
			// Try trim-newlines fallback, then anchor-pair fallback (first + last
			// non-empty ` `-context lines).
			const trimmed = stripNewlines(beforeTxt);
			if (trimmed && content.includes(trimmed)) {
				content = content.replace(trimmed, stripNewlines(afterTxt));
			} else {
				const anchors: number[] = [];
				for (let i = 0; i < hunkLines.length; i += 1) {
					const l = hunkLines[i] ?? "";
					if (l.startsWith(" ") && l.trim()) {
						anchors.push(i);
					}
				}
				let anchorMatched = false;
				if (anchors.length >= 2) {
					const firstAnchor = (hunkLines[anchors[0] ?? 0] ?? "").slice(1);
					const lastAnchor = (hunkLines[anchors.at(-1) ?? 0] ?? "").slice(1);
					const fi = content.indexOf(firstAnchor);
					const startFrom = fi >= 0 ? fi + 1 : 0;
					const li = content.indexOf(lastAnchor, startFrom);
					if (fi >= 0 && li > fi) {
						const endOfLast = li + lastAnchor.length;
						content = content.slice(0, fi) + afterTxt + content.slice(endOfLast);
						anchorMatched = true;
					}
				}
				if (!anchorMatched) {
					return [
						false,
						`hunk ${hi + 1} not found in ${target}\nfirst 3 lines: ${JSON.stringify(before.slice(0, 3))}`,
					];
				}
			}
		}
	}
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, content);
	return [true, target];
}

// Split a raw patch's lines into per-file chunks on `--- ` boundaries.
function splitPatchChunks(patchLines: readonly string[]): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	for (const line of patchLines) {
		if (line.startsWith("--- ") && current.length > 0) {
			chunks.push(current.join(""));
			current = [];
		}
		current.push(line);
	}
	if (current.length > 0) {
		chunks.push(current.join(""));
	}
	return chunks;
}

// Sequential try-in-order over `git apply` variants: recursion instead of a
// `for` loop with an internal `await`, since the search must stop at the
// first success and the variants cannot run in parallel via `Promise.all`.
async function tryGitApplyVariants(
	variants: ReadonlyArray<readonly [string[], string]>,
	fixSrc: string,
	fullAbs: string,
): Promise<string | null> {
	const [head, ...rest] = variants;
	if (head === undefined) {
		return null;
	}
	const [opts, label] = head;
	const r = await run("git", ["apply", ...opts, fullAbs], fixSrc);
	if (r.returncode === 0) {
		return label;
	}
	return tryGitApplyVariants(rest, fixSrc, fullAbs);
}

// Sequential per-chunk `patch -p1 -F 5` attempts: recursion instead of a
// `for` loop with an internal `await`, since the PASS/FAIL log lines must
// stay in chunk order (`Promise.all` would not preserve that).
async function applyPerFileFallback(chunks: readonly string[], fixSrc: string): Promise<number> {
	const [chunk, ...rest] = chunks;
	if (chunk === undefined) {
		return 0;
	}
	const tmpFile = join(tmpdir(), `apply-bundle-${randomBytes(8).toString("hex")}.patch`);
	writeFileSync(tmpFile, chunk);
	const r = await run("patch", ["-p1", "-F", "5", "--forward", "-i", tmpFile], fixSrc);
	let pathHint = "";
	for (const ln of chunk.split(/\r\n|\r|\n/u)) {
		if (ln.startsWith("+++ ")) {
			pathHint = ln.slice(6).trim();
			break;
		}
	}
	let thisApplied = 0;
	if (r.returncode === 0) {
		thisApplied = 1;
		process.stdout.write(`     PASS: ${pathHint}\n`);
	} else {
		process.stdout.write(`     FAIL: ${pathHint}\n`);
		process.stdout.write(
			`       stderr: ${(r.stderr || "").replaceAll("\n", " | ").slice(0, 400)}\n`,
		);
		process.stdout.write(
			`       stdout: ${(r.stdout || "").replaceAll("\n", " | ").slice(0, 400)}\n`,
		);
	}
	try {
		unlinkSync(tmpFile);
	} catch {
		// Best-effort cleanup; a stale tmp file is harmless.
	}
	const restApplied = await applyPerFileFallback(rest, fixSrc);
	return thisApplied + restApplied;
}

export async function main(): Promise<number> {
	const bundlePath = process.env["BUNDLE_JSON"];
	const fixSrc = process.env["FIX_SRC"];
	const taskIdSlug = process.env["TASK_ID_SLUG"];
	if (!bundlePath || !fixSrc || !taskIdSlug) {
		process.stderr.write("apply-bundle: missing BUNDLE_JSON, FIX_SRC, or TASK_ID_SLUG env\n");
		return 1;
	}

	const b: Bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
	// SRP-GG: fold test_additions into files_to_modify so downstream stages
	// (SRP-V cross-file check, SRP-X schema check, apply, adversarial) see one
	// atomic file list. Preserve legacy behavior: entries with no
	// `full_content` but `patch_unified` remain patch-mode.
	for (const t of b.test_additions ?? []) {
		b.files_to_modify.push({
			path: t.path,
			full_content: t.full_content ?? "",
			rationale: t.fails_without_fix ?? "regression test",
		});
	}
	b.test_additions = [];
	mkdirSync("discovery/patches", { recursive: true });

	// Path Y: if every file has `full_content`, write files directly. No diff
	// parsing, zero hunk-format hallucination surface. Fall back to patch mode
	// when any file only has `patch_unified` (older bundles).
	if (b.files_to_modify.every((fm) => "full_content" in fm && Boolean(fm.full_content))) {
		let written = 0;
		for (const fm of b.files_to_modify) {
			const dst = join(fixSrc, fm.path);
			mkdirSync(dirname(dst), { recursive: true });
			writeFileSync(dst, fm.full_content ?? "");
			written += 1;
			process.stdout.write(`   wrote full file: ${fm.path}\n`);
		}
		for (const t of b.test_additions ?? []) {
			const dst = join(fixSrc, t.path);
			mkdirSync(dirname(dst), { recursive: true });
			writeFileSync(dst, t.full_content ?? "");
			process.stdout.write(`   wrote test file: ${t.path}\n`);
		}
		process.stdout.write(
			`   applied ${written} file(s) via full-content write (no patch parsing)\n`,
		);
		return 0;
	}

	const patchPath = `discovery/patches/${taskIdSlug}.patch`;
	{
		const parts: string[] = [];
		for (const fm of b.files_to_modify) {
			const pu = fm.patch_unified ?? "";
			parts.push(pu);
			if (!pu.endsWith("\n")) {
				parts.push("\n");
			}
		}
		writeFileSync(patchPath, parts.join(""));
	}
	process.stdout.write(`   assembled patch -> ${patchPath}\n`);

	const fullAbs = resolve(patchPath);
	// Try git apply variants — strict → recount → whitespace-lenient →
	// recount+lenient.
	const gitApplyVariants: ReadonlyArray<readonly [string[], string]> = [
		[[], "git apply (strict)"],
		[["--recount"], "git apply --recount"],
		[["--ignore-whitespace"], "git apply --ignore-whitespace"],
		[["--recount", "--ignore-whitespace"], "git apply --recount --ignore-whitespace"],
		[["--recount", "--ignore-whitespace", "-C0"], "git apply --recount -C0"],
	];
	const gitApplyLabel = await tryGitApplyVariants(gitApplyVariants, fixSrc, fullAbs);
	if (gitApplyLabel !== null) {
		process.stdout.write(`   applied ${b.files_to_modify.length} patch(es) via ${gitApplyLabel}\n`);
		writeTests(b, fixSrc);
		return 0;
	}

	process.stdout.write("   git apply variants refused — falling back to patch -p1 -F 3\n");
	{
		const r = await run("patch", ["-p1", "-F", "3", "--forward", "-i", fullAbs], fixSrc);
		if (r.returncode === 0) {
			process.stdout.write(`   applied ${b.files_to_modify.length} patch(es) via patch -p1 -F 3\n`);
			writeTests(b, fixSrc);
			return 0;
		}
	}

	process.stdout.write(
		"   patch -p1 refused the whole patch — trying content-substitution parser\n",
	);
	// Robust content-substitution: process each hunk individually, apply to a
	// running content buffer. Whitespace-tolerant fallback for context matching.
	const patchContent = readFileSync(patchPath, "utf8");
	const patchLines = splitLinesKeepEnds(patchContent);

	{
		const chunks = splitPatchChunks(patchLines);
		let applied = 0;
		for (const chunk of chunks) {
			const [ok, msg] = parseAndApply(chunk, fixSrc);
			if (ok) {
				applied += 1;
				process.stdout.write(`     PASS: ${msg} (content-substitution)\n`);
			} else {
				process.stdout.write(`     FAIL: ${msg}\n`);
			}
		}
		if (applied === chunks.length) {
			process.stdout.write(`   applied ${applied} patch(es) via content-substitution\n`);
			writeTests(b, fixSrc);
			return 0;
		}
	}

	process.stdout.write(
		"   content-substitution failed — retrying per-file patch -p1 as final fallback\n",
	);
	// Split on `--- ` boundaries.
	const patchContent2 = readFileSync(patchPath, "utf8");
	const patchLines2 = splitLinesKeepEnds(patchContent2);
	const chunks = splitPatchChunks(patchLines2);
	const applied = await applyPerFileFallback(chunks, fixSrc);
	if (applied !== chunks.length) {
		process.stdout.write(`   FAIL: ${applied}/${chunks.length} chunks applied\n`);
		return 5;
	}
	process.stdout.write(`   applied ${applied} patch(es) via per-file patch -p1 -F 5\n`);
	writeTests(b, fixSrc);
	return 0;
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exit(1);
	}
}
