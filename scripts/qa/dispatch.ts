/**
 * Interprets the {@link TOOLS} registry: selects each tool's files, builds its
 * argv, and runs it through the repo-scoped mise wrapper. The file-selection
 * and argv-expansion logic is pure (and unit-tested in dispatch.test.ts); the
 * rest is the process-spawning IO layer.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FILES, type Match, type Tool, TOOLS } from "./registry.ts";

export type Mode = "lint" | "format-check" | "format-write";

// ── pure selection helpers (unit-tested) ─────────────────────────────

// Files whose extension (case-insensitive) is in the allowed set.
export function selectByExt(files: readonly string[], extensions: readonly string[]): string[] {
	const set = new Set(extensions.map((e) => e.toLowerCase()));
	return files.filter((f) => {
		const dot = f.lastIndexOf(".");
		return dot !== -1 && set.has(f.slice(dot + 1).toLowerCase());
	});
}

// Files matching a path regex.
export function selectByRegex(files: readonly string[], pattern: string): string[] {
	const re = new RegExp(pattern, "iu");
	return files.filter((f) => re.test(f));
}

// Expand an argv template: replace the {@link FILES} token with the file list,
// or with `["."]` when in whole-repo mode and the tool prefers a dot there.
export function expandArgv(
	template: readonly string[],
	files: readonly string[],
	opts: { wholeRepo: boolean; fullRepoDot: boolean },
): string[] {
	const replacement = opts.wholeRepo && opts.fullRepoDot ? ["."] : [...files];
	return template.flatMap((arg) => (arg === FILES ? replacement : [arg]));
}

// ── IO layer ─────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 1_048_576;

function gitRoot(): string {
	const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	return r.stdout.trim() || process.cwd();
}

const ROOT = gitRoot();

// Tracked files, or the passed staged subset.
function candidateFiles(staged: string[] | null): string[] {
	if (staged !== null) {
		return staged;
	}
	const r = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	return r.stdout.split("\n").filter(Boolean);
}

// Resolve the files a tool applies to, given the candidate set.
function selectFiles(match: Match, candidates: string[]): string[] {
	switch (match.kind) {
		case "ext": {
			return selectByExt(candidates, match.extensions);
		}
		case "regex": {
			return selectByRegex(candidates, match.pattern);
		}
		case "secrets": {
			return candidates;
		}
	}
}

// Run one tool invocation through `bin/mise exec`; return true on success.
function mise(argv: string[], cwd = ROOT): boolean {
	const r = spawnSync(join(ROOT, "bin/mise"), ["exec", "--", ...argv], { cwd, stdio: "inherit" });
	return r.status === 0;
}

function note(label: string): void {
	process.stdout.write(`\u001B[1m▸ ${label}\u001B[0m\n`);
}

function runLint(tool: Tool, candidates: string[], wholeRepo: boolean): boolean | null {
	const { lint } = tool;
	if (!lint) {
		return null;
	}

	if (lint.mode === "staged-aware") {
		note(tool.id);
		return mise(wholeRepo ? lint.fullArgv : lint.stagedArgv);
	}

	const files = selectFiles(tool.match, candidates);
	if (files.length === 0) {
		return null;
	}

	if (lint.mode === "project") {
		// Whole-project tool: gated on ≥1 matched file (checked above), then run
		// its argv verbatim with no FILES substitution.
		note(tool.id);
		return mise([...lint.argv]);
	}

	// mode === "files"
	note(tool.id);
	return mise(expandArgv(lint.argv, files, { wholeRepo, fullRepoDot: lint.fullRepoDot ?? false }));
}

function runFormat(
	tool: Tool,
	candidates: string[],
	wholeRepo: boolean,
	check: boolean,
): boolean | null {
	const { format } = tool;
	if (!format) {
		return null;
	}
	const files = selectFiles(tool.match, candidates);
	if (files.length === 0) {
		return null;
	}
	note(tool.id);
	const template = check ? format.check : format.write;
	return mise(expandArgv(template, files, { wholeRepo, fullRepoDot: format.fullRepoDot ?? false }));
}

// Hygiene guards that aren't external tools: merge markers, oversized files.
function runHygiene(candidates: string[]): boolean {
	let ok = true;
	note("merge-conflict markers");
	const marker = /^(<{7}|={7}|>{7})( |$)/u;
	for (const f of candidates) {
		let text: string | null = null;
		try {
			text = readFileSync(join(ROOT, f), "utf8");
		} catch {
			text = null;
		}
		if (text !== null && text.split("\n").some((l) => marker.test(l))) {
			process.stdout.write(`  ✗ ${f}: unresolved merge-conflict marker\n`);
			ok = false;
		}
	}
	note("large files (>1 MiB)");
	for (const f of candidates) {
		try {
			const bytes = readFileSync(join(ROOT, f)).length;
			if (bytes > MAX_FILE_BYTES) {
				process.stdout.write(`  ✗ ${f} is ${Math.round(bytes / 1024)} KiB (>1024)\n`);
				ok = false;
			}
		} catch {
			// missing/unreadable — skip
		}
	}
	return ok;
}

// Run the toolchain in the given mode. `staged` is the lefthook-provided file
// list (staged mode); `null` means whole-repo. Runs every applicable tool even
// if one fails, then resolves false if any failed.
export function run(mode: Mode, staged: string[] | null, only: string | null = null): boolean {
	const candidates = candidateFiles(staged);
	const wholeRepo = staged === null;
	let ok = true;

	// When `--only <id>` is set, restrict to that single tool; otherwise every tool.
	const applicable = only === null ? TOOLS : TOOLS.filter((tool) => tool.id === only);

	if (mode === "lint") {
		if ((only === null || only === "hygiene") && !runHygiene(candidates)) {
			ok = false;
		}
		for (const tool of applicable) {
			if (runLint(tool, candidates, wholeRepo) === false) {
				ok = false;
			}
		}
	} else {
		const check = mode === "format-check";
		for (const tool of applicable) {
			if (runFormat(tool, candidates, wholeRepo, check) === false) {
				ok = false;
			}
		}
	}
	return ok;
}
