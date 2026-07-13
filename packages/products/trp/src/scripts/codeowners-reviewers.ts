#!/usr/bin/env node
/**
 * `codeowners-reviewers.ts` — SRP-KK: given a bundle + CODEOWNERS file,
 * list unique reviewers to request.
 *
 * TS port of `security-pocs/repos/trp/scripts/codeowners-reviewers.py`.
 * Behaviour is byte-for-byte identical to the Python source: same CODEOWNERS
 * search order, same glob-to-regex translation, last-matching-rule wins,
 * team owners (any owner containing `/`) are skipped so `gh --add-reviewer`
 * only sees individuals.
 *
 * Env: FIX_SRC, BUNDLE_JSON.
 * Output: one `@`-prefixed reviewer per line to stdout.
 *
 * @module
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

// CODEOWNERS can live at repo root, .github/, or docs/.
const CO_PATHS: readonly string[] = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

type BundleFile = { path: string };
type Bundle = { files_to_modify: BundleFile[] };
type Rule = { pattern: string; owners: string[] };

/**
 * Translate a CODEOWNERS glob to a regex and test `path`.
 *
 * Mirrors the Python `glob_match` exactly:
 *   - Trailing `/` is stripped from the pattern.
 *   - A leading `/` anchors the match to the repo root.
 *   - `**` matches anything (including `/`), `*` matches non-`/`, `?` matches
 *     one character.
 *   - The regex is suffixed with `(?:/|$)` and, for unanchored patterns,
 *     prefixed with `(?:^|/)`.
 *
 * @param {string} pattern - CODEOWNERS glob pattern.
 * @param {string} path - Repo-relative path to test against `pattern`.
 * @returns {boolean} Whether `path` matches `pattern`.
 */
export function globMatch(pattern: string, path: string): boolean {
	let pat = pattern.replace(/\/+$/u, "");
	let anchored = false;
	if (pat.startsWith("/")) {
		pat = pat.slice(1);
		anchored = true;
	}
	// Escape regex metachars (matches Python's `re.escape` for the chars a
	// CODEOWNERS glob can contain), then translate the glob wildcards. The
	// order below matches the Python: `\*\*` -> `.*`, then `\*` -> `[^/]*`,
	// then `\?` -> `.`.
	let rx = pat.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
	rx = rx
		.replaceAll(String.raw`\*\*`, ".*")
		.replaceAll(String.raw`\*`, "[^/]*")
		.replaceAll(String.raw`\?`, ".");
	rx += "(?:/|$)";
	if (!anchored) {
		rx = `(?:^|/)${rx}`;
	}
	return new RegExp(rx, "u").test(path);
}

/**
 * Parse a CODEOWNERS file's text into an ordered list of `(pattern, owners)`
 * rules. Comments (`#` to end of line) and blank lines are dropped.
 *
 * @param {string} text - Raw CODEOWNERS file contents.
 * @returns {Rule[]} Ordered list of parsed rules.
 */
export function parseCodeowners(text: string): Rule[] {
	const rules: Rule[] = [];
	for (const rawLine of text.split("\n")) {
		const [rawPattern] = rawLine.split("#", 1);
		if (rawPattern === undefined) {
			throw new Error("unexpected undefined");
		}
		const ln = rawPattern.trim();
		if (ln) {
			const parts = ln.split(/\s+/u);
			if (parts.length >= 2) {
				const [pattern, ...owners] = parts;
				if (pattern === undefined) {
					throw new Error("unexpected undefined");
				}
				rules.push({ pattern, owners });
			}
		}
	}
	return rules;
}

/**
 * Compute the sorted, unique list of individual reviewers for `bundlePaths`
 * against `rules`. Last-matching-rule wins per CODEOWNERS spec; team owners
 * (containing `/`) are dropped.
 *
 * @param {Rule[]} rules - Ordered CODEOWNERS rules from `parseCodeowners`.
 * @param {string[]} bundlePaths - Repo-relative paths touched by the fix bundle.
 * @returns {string[]} Sorted, deduplicated list of individual (non-team) reviewers.
 */
export function collectReviewers(rules: Rule[], bundlePaths: string[]): string[] {
	const seen = new Set<string>();
	for (const path of bundlePaths) {
		let winner: string[] | null = null;
		for (const { pattern, owners } of rules) {
			if (globMatch(pattern, path)) {
				winner = owners;
			}
		}
		if (winner) {
			for (const owner of winner) {
				// Skip team owners (they contain /); gh doesn't accept teams
				// via --add-reviewer without special flag. Only pass
				// individuals.
				if (!owner.includes("/")) {
					seen.add(owner);
				}
			}
		}
	}
	return [...seen].toSorted();
}

export async function main(): Promise<number> {
	await Promise.resolve();
	const fixSrc = process.env.FIX_SRC;
	const bundlePath = process.env.BUNDLE_JSON;
	if (fixSrc === undefined) {
		throw new Error("FIX_SRC");
	}
	if (bundlePath === undefined) {
		throw new Error("BUNDLE_JSON");
	}

	let coFile: string | null = null;
	for (const c of CO_PATHS) {
		const p = join(fixSrc, c);
		if (existsSync(p)) {
			coFile = p;
			break;
		}
	}
	if (!coFile) {
		return 0;
	}

	const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as Bundle;
	const bundlePaths = bundle.files_to_modify.map((f) => f.path);

	const rules = parseCodeowners(readFileSync(coFile, "utf8"));
	const reviewers = collectReviewers(rules, bundlePaths);

	for (const r of reviewers) {
		process.stdout.write(`${r}\n`);
	}
	return 0;
}

// Only run main() when this file is invoked directly (not on test import).
function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(`codeowners-reviewers: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
