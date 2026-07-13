#!/usr/bin/env node
/**
 * `repo-router.ts` — TS port of `trp/scripts/repo-router.py`.
 *
 * Picks a registered client repo from an intent hint. Reads sfp.env (or
 * trp.env for tracker defaults) at the repo root, walks the
 * `SFP_REPO_<slug>=<slug>:<owner>/<repo>:<default_branch>` registry, and
 * picks the best match for either an explicit target_repo string or a
 * keyword pulled out of a task description. Emits a single JSON object on
 * stdout:
 *
 *   {slug, owner, repo, default_branch, fix_src_path}
 *
 * `fix_src_path` resolves to `discovery/fix-src/<slug>-<task_id_slug>`.
 * When `TRP_PARALLEL_SAFE` is not `true` the task_id is dropped from the
 * path so concurrent runs share the same tree (single-worktree default).
 *
 * If no entry matches, the first sfp.env row wins and a warning goes to
 * stderr — the caller decides whether to accept the fallback.
 *
 * CLI:
 *   --intent-hint <str>            repo slug, owner/repo, or keyword
 *   --task <TRACKER>:<TASK_ID>     e.g. clickup:abc123 — used for fix_src_path
 *
 * Migrated line-for-line from the .py source: every function, every branch,
 * every stderr message preserved verbatim.
 *
 * @module
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Python anchored REPO_ROOT to the .py file's grandparent
// (trp/scripts/repo-router.py -> trp/) so sfp.env and trp.env read
// from the same tree regardless of the calling process's CWD. Match
// that: resolve two levels up from THIS file (packages/products/trp/
// src/scripts/repo-router.ts -> packages/products/trp/). Runtime
// override via TRP_REPO_ROOT for tests and unusual layouts; empty /
// unset falls through to the file-anchored default. Never
// process.cwd() — that silently reads sfp.env from wherever the
// caller happened to be.
const FILE_ANCHORED_REPO_ROOT: string = resolve(import.meta.dirname, "..", "..");
const REPO_ROOT_OVERRIDE: string | undefined = process.env.TRP_REPO_ROOT;
const REPO_ROOT: string =
	REPO_ROOT_OVERRIDE !== undefined && REPO_ROOT_OVERRIDE.length > 0
		? REPO_ROOT_OVERRIDE
		: FILE_ANCHORED_REPO_ROOT;
const SFP_ENV: string = join(REPO_ROOT, "sfp.env");
const TRP_ENV: string = join(REPO_ROOT, "trp.env");

export type RepoEntry = {
	slug: string;
	owner: string;
	repo: string;
	default_branch: string;
};

export type OutputEntry = RepoEntry & {
	fix_src_path: string;
};

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Parse a KEY=VALUE env file. Ignores comments and blank lines. Strips
 * surrounding quotes on values. Returns a Map in insertion order.
 *
 * @param {string} path - path to the env file to parse.
 * @returns {Map<string, string>} parsed key/value pairs in file order.
 */
export function parseEnv(path: string): Map<string, string> {
	const out = new Map<string, string>();
	if (!isFile(path)) {
		return out;
	}
	const raw = readFileSync(path, "utf8");
	for (const rawLine of raw.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line && !line.startsWith("#") && line.includes("=")) {
			const idx = line.indexOf("=");
			const k = line.slice(0, idx).trim();
			let v = line.slice(idx + 1).trim();
			// Match Python's .strip('"').strip("'") — strip both quote chars from
			// both ends, one class at a time.
			v = stripSurrounding(v, '"');
			v = stripSurrounding(v, "'");
			out.set(k, v);
		}
	}
	return out;
}

function stripSurrounding(s: string, ch: string): string {
	let start = 0;
	let end = s.length;
	while (start < end && s[start] === ch) {
		start += 1;
	}
	while (end > start && s[end - 1] === ch) {
		end -= 1;
	}
	return s.slice(start, end);
}

/**
 * Extract SFP_REPO_* entries in file order. Returns list of entries.
 * Malformed rows log to stderr and are skipped.
 *
 * @param {Map<string, string>} env - parsed env key/value pairs (from `parseEnv`).
 * @returns {RepoEntry[]} the registered repo entries, in file order.
 */
export function loadRepos(env: Map<string, string>): RepoEntry[] {
	const repos: RepoEntry[] = [];
	for (const [key, val] of env) {
		if (key.startsWith("SFP_REPO_")) {
			const parts = val.split(":");
			if (parts.length === 3) {
				const [slug, ownerRepo, defaultBranch] = parts;
				if (slug !== undefined && ownerRepo !== undefined && defaultBranch !== undefined) {
					if (ownerRepo.includes("/")) {
						const slashIdx = ownerRepo.indexOf("/");
						const owner = ownerRepo.slice(0, slashIdx);
						const repo = ownerRepo.slice(slashIdx + 1);
						repos.push({
							slug,
							owner,
							repo,
							default_branch: defaultBranch,
						});
					} else {
						process.stderr.write(`repo-router: skipping malformed owner/repo in ${key}\n`);
					}
				}
			} else {
				process.stderr.write(`repo-router: skipping malformed ${key}=${JSON.stringify(val)}\n`);
			}
		}
	}
	return repos;
}

/**
 * Lowercase, replace non-alnum runs with hyphens, trim. Empty -> 'task'.
 *
 * @param {string} text - the text to slugify.
 * @returns {string} the slugified text, or `"task"` when empty.
 */
export function slugify(text: string): string {
	const s = text
		.toLowerCase()
		.replaceAll(/[^a-zA-Z0-9]+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "");
	return s || "task";
}

/**
 * Higher is better. 0 means no match at all.
 *
 * @param {string} hint - the intent hint (repo slug, owner/repo, or keyword).
 * @param {RepoEntry} repo - the candidate repo entry to score against.
 * @returns {number} the match score, 0 when there is no match.
 */
export function score(hint: string, repo: RepoEntry): number {
	if (!hint) {
		return 0;
	}
	const h = hint.toLowerCase().trim();
	const slug = repo.slug.toLowerCase();
	const owner = repo.owner.toLowerCase();
	const name = repo.repo.toLowerCase();
	const full = `${owner}/${name}`;

	// Exact hits first.
	if (h === slug || h === full || h === name) {
		return 100;
	}
	// owner/repo prefix or repo-only.
	if (h === owner) {
		return 60;
	}
	// Substring — hint contains slug or vice versa.
	if (slug.includes(h) || h.includes(slug)) {
		return 40;
	}
	if (name.includes(h) || h.includes(name)) {
		return 30;
	}
	if (h.includes(owner)) {
		return 10;
	}
	return 0;
}

/**
 * Return [repo, matched]. Fallback to first entry when nothing scores
 * above zero — caller logs the warning.
 *
 * @param {RepoEntry[]} repos - the registered repo entries to pick from.
 * @param {string} hint - the intent hint (repo slug, owner/repo, or keyword).
 * @returns {[RepoEntry | null, boolean]} `[picked, matched]` — `matched` is
 *   `false` when the pick fell back to the first entry.
 */
export function pick(repos: RepoEntry[], hint: string): [RepoEntry | null, boolean] {
	if (repos.length === 0) {
		return [null, false];
	}
	const ranked = repos
		.map((r, i) => ({ s: score(hint, r), i, r }))
		.toSorted((a, b) => {
			if (a.s !== b.s) {
				return b.s - a.s;
			}
			return a.i - b.i;
		});
	const [top] = ranked;
	if (top === undefined || top.s === 0) {
		return [repos[0] ?? null, false];
	}
	return [top.r, true];
}

/**
 * discovery/fix-src/<slug>[-<task_id_slug>] — task suffix only when
 * TRP_PARALLEL_SAFE is truthy so single-worktree runs stay stable.
 *
 * @param {string} slug - the repo slug.
 * @param {string} taskId - the tracker task id (e.g. `abc123` from `clickup:abc123`).
 * @param {boolean} parallelSafe - whether `TRP_PARALLEL_SAFE` is set.
 * @returns {string} the resolved fix-src directory path.
 */
export function resolveFixSrc(slug: string, taskId: string, parallelSafe: boolean): string {
	const base = join(REPO_ROOT, "discovery", "fix-src");
	if (parallelSafe && taskId) {
		return join(base, `${slug}-${slugify(taskId)}`);
	}
	return join(base, slug);
}

type ParsedArgs = {
	intentHint: string;
	task: string;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
	let intentHint = "";
	let task = "";
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a !== undefined) {
			if (a === "--intent-hint") {
				intentHint = argv[i + 1] ?? "";
				i += 1;
			} else if (a.startsWith("--intent-hint=")) {
				intentHint = a.slice("--intent-hint=".length);
			} else if (a === "--task") {
				task = argv[i + 1] ?? "";
				i += 1;
			} else if (a.startsWith("--task=")) {
				task = a.slice("--task=".length);
			}
		}
	}
	return { intentHint, task };
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
	const args = parseArgs(argv);

	const env = new Map<string, string>();
	// trp.env first so sfp.env keys win on conflict (repo registry is
	// authoritative there).
	for (const [k, v] of parseEnv(TRP_ENV)) {
		env.set(k, v);
	}
	for (const [k, v] of parseEnv(SFP_ENV)) {
		env.set(k, v);
	}

	const repos = loadRepos(env);
	if (repos.length === 0) {
		process.stderr.write("repo-router: no SFP_REPO_* entries in sfp.env\n");
		return 2;
	}

	const [picked, matched] = pick(repos, args.intentHint);
	if (picked === null) {
		process.stderr.write("repo-router: no SFP_REPO_* entries in sfp.env\n");
		return 2;
	}
	if (!matched) {
		process.stderr.write(
			`repo-router: no match for intent-hint ${JSON.stringify(args.intentHint)}; ` +
				`falling back to first entry ${JSON.stringify(picked.slug)}\n`,
		);
	}

	const parallelSafe = (env.get("TRP_PARALLEL_SAFE") ?? "").toLowerCase() === "true";
	let taskId = "";
	if (args.task && args.task.includes(":")) {
		taskId = args.task.slice(args.task.indexOf(":") + 1);
	}

	const out: OutputEntry = {
		...picked,
		fix_src_path: resolveFixSrc(picked.slug, taskId, parallelSafe),
	};
	process.stdout.write(JSON.stringify(out));
	process.stdout.write("\n");
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
		process.stderr.write(`repo-router: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
