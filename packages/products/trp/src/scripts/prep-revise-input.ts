#!/usr/bin/env node
/**
 * `prep-revise-input.ts` — TRP-EE helper: build args for a REVISE workflow
 * invocation from a failure JSON (TRP-J stage 6-8 failure or TRP-W post-push
 * failure).
 *
 * Env: TASK_ID_SLUG, FAIL_JSON (defaults to latest trp-fail-*-a*.json or
 * -post-push.json)
 *
 * Output: JSON to stdout — the args object to feed to Workflow({args:...}).
 *
 * Ported line-for-line from `trp/scripts/prep-revise-input.py`. Every branch,
 * every field name, every log line is preserved verbatim.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// --- helpers ---------------------------------------------------------------

function writeStderr(text: string): void {
	process.stderr.write(text);
}

function writeStdout(text: string): void {
	process.stdout.write(text);
}

// Python truthiness: None/False/0/""/[]/{}/NaN are falsy, everything else
// truthy. JS's `??` only guards null/undefined and `||` treats empty
// collections as truthy — neither matches Python. This helper does.
function pyTruthy(x: unknown): boolean {
	if (x === null || x === undefined || x === false || x === 0 || x === "") {
		return false;
	}
	if (typeof x === "number" && Number.isNaN(x)) {
		return false;
	}
	if (Array.isArray(x)) {
		return x.length > 0;
	}
	if (typeof x === "object") {
		return Object.keys(x as Record<string, unknown>).length > 0;
	}
	return Boolean(x);
}

// Python `or` chain semantics: return the first Python-truthy value, or the
// last value if every operand is falsy (same as `a or b or c` — the tail
// value is returned as-is when the chain never short-circuits).
function pyOr<T>(...values: readonly T[]): T {
	for (let i = 0; i < values.length - 1; i++) {
		if (pyTruthy(values[i])) {
			return values[i] as T;
		}
	}
	return values.at(-1) as T;
}

// Minimal shell-style glob for the two patterns the .py used:
//   discovery/trp-fail-<slug>[-<repo>]-*.json
// The .py called glob.glob on a literal prefix + '*' + literal suffix, so a
// hand-rolled prefix/suffix match over readdirSync of the parent dir is
// sufficient and avoids pulling a glob dep for one call site.
function globFailPattern(pattern: string): string[] {
	const dir = dirname(pattern);
	const base = basename(pattern);
	const starIdx = base.indexOf("*");
	if (starIdx < 0) {
		return existsSync(pattern) ? [pattern] : [];
	}
	const prefix = base.slice(0, starIdx);
	const suffix = base.slice(starIdx + 1);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const hits: string[] = [];
	for (const name of entries) {
		if (name.startsWith(prefix) && name.endsWith(suffix)) {
			hits.push(join(dir, name));
		}
	}
	return hits;
}

// Sort file paths by mtime descending (newest first), mirroring the .py's
// `sorted(glob.glob(pat), key=os.path.getmtime, reverse=True)`.
function sortByMtimeDesc(paths: readonly string[]): string[] {
	return [...paths].toSorted((a, b) => {
		const am = statSync(a).mtimeMs;
		const bm = statSync(b).mtimeMs;
		return bm - am;
	});
}

// Coverage-entry id extraction, ported directly from `_extract_id` in the .py.
// Accepts str, dict with any of the fallback id keys, or returns null.
function extractId(x: unknown): string | null {
	if (typeof x === "string") {
		return x;
	}
	if (x !== null && typeof x === "object" && !Array.isArray(x)) {
		const d = x as Record<string, unknown>;
		for (const k of ["id", "item_id", "key", "label", "name", "title"]) {
			if (k in d) {
				return String(d[k]);
			}
		}
	}
	return null;
}

// Ported directly from `_closed_ids` in the .py. Returns the set of
// advisory-item ids the prior bundle claimed to close.
function closedIds(coverage: unknown): Set<string> {
	const closed = new Set<string>();
	if (coverage === null || coverage === undefined) {
		return closed;
	}
	let entries: unknown[];
	if (Array.isArray(coverage)) {
		entries = coverage;
	} else if (typeof coverage === "object") {
		entries = Object.values(coverage as Record<string, unknown>);
	} else {
		entries = [];
	}
	for (const e of entries) {
		if (e !== null && typeof e === "object" && !Array.isArray(e)) {
			const rec = e as Record<string, unknown>;
			const rawStatus = rec.status ?? rec.state ?? "";
			const status = String(rawStatus).toLowerCase();
			const isOpenStatus =
				status === "open" || status === "unaddressed" || status === "missing" || status === "gap";
			if (!isOpenStatus) {
				const files = pyOr(rec.closed_by_files, rec.files, rec.addressed_by);
				const addressed = rec.addressed ?? rec.closed;
				const isIncompleteStatus =
					status !== "" &&
					status !== "closed" &&
					status !== "addressed" &&
					status !== "covered" &&
					status !== "done";
				const skipForMissingEvidence = isIncompleteStatus && !files && addressed !== true;
				if (addressed !== false && !skipForMissingEvidence) {
					const iid = extractId(e);
					if (iid) {
						closed.add(iid);
					}
				}
			}
		} else {
			const iid = extractId(e);
			if (iid) {
				closed.add(iid);
			}
		}
	}
	return closed;
}

// --- main ------------------------------------------------------------------

export async function main(): Promise<number> {
	await Promise.resolve();
	const taskIdSlug = process.env.TASK_ID_SLUG;
	if (!taskIdSlug) {
		writeStderr("TASK_ID_SLUG env var is required\n");
		return 2;
	}
	const repoSlug = process.env.REPO_SLUG ?? ""; // for multi-repo tasks

	// Find the failure JSON to feed back. Prefer repo-scoped failures over
	// the task's global one when REPO_SLUG is set.
	let fail = process.env.FAIL_JSON ?? "";
	if (!fail) {
		const patterns: string[] = [];
		if (repoSlug) {
			patterns.push(`discovery/trp-fail-${taskIdSlug}-${repoSlug}-*.json`);
		}
		patterns.push(`discovery/trp-fail-${taskIdSlug}-*.json`);
		let candidates: string[] = [];
		for (const pat of patterns) {
			candidates = sortByMtimeDesc(globFailPattern(pat));
			if (candidates.length > 0) {
				break;
			}
		}
		if (candidates.length === 0) {
			writeStderr(`no trp-fail-${taskIdSlug}-*.json found\n`);
			return 2;
		}
		const [firstCandidate] = candidates;
		if (firstCandidate === undefined) {
			throw new Error("unexpected undefined");
		}
		fail = firstCandidate;
	}

	const failData = JSON.parse(readFileSync(fail, "utf8")) as Record<string, unknown>;
	const inputPath = `discovery/trp-input-${taskIdSlug}.json`;
	if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
		writeStderr(`${inputPath} not found — run driver in --prep-only first\n`);
		return 2;
	}

	const base = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;
	base.previous_attempt = failData;

	// Phase-2 gap carry-over: if a prior bundle exists, compare its
	// fix_item_coverage against advisory_fix_items and surface the still-open
	// items so DesignFix must close them this round.
	const bundleCandidates: string[] = [];
	if (repoSlug) {
		bundleCandidates.push(`discovery/trp-bundle-${taskIdSlug}-${repoSlug}.json`);
	}
	bundleCandidates.push(`discovery/trp-bundle-${taskIdSlug}.json`);
	const priorBundlePath =
		bundleCandidates.find((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		}) ?? null;

	const gaps: string[] = [];
	if (priorBundlePath) {
		try {
			const priorBundle = JSON.parse(readFileSync(priorBundlePath, "utf8")) as Record<
				string,
				unknown
			>;
			const coverage = priorBundle.fix_item_coverage;
			const advisoryItemsRaw = pyOr<unknown>(
				base.advisory_fix_items,
				failData.advisory_fix_items,
				[],
			);
			const advisoryItems = Array.isArray(advisoryItemsRaw) ? advisoryItemsRaw : [];
			const closed = closedIds(coverage);
			for (const item of advisoryItems) {
				const iid = extractId(item);
				if (iid && !closed.has(iid)) {
					gaps.push(iid);
				}
			}
		} catch (error: unknown) {
			writeStderr(`warn: gap extraction failed: ${String(error)}\n`);
		}
	}

	if (gaps.length > 0) {
		base.gaps_from_prior_attempt = gaps;
		const attemptN = pyOr<unknown>(failData.attempt, failData.attempt_number, "?");
		const advisoryRaw = base.advisory_fix_items;
		const advisoryArr = Array.isArray(advisoryRaw) ? advisoryRaw : [];
		const allIdsMaybe = advisoryArr.map((i) => extractId(i));
		const allIds = allIdsMaybe.filter((i): i is string => Boolean(i));
		const gapsSet = new Set(gaps);
		const closedIdsList = allIds.filter((i) => !gapsSet.has(i));
		const sortedClosed = [...closedIdsList].toSorted();
		const sortedGaps = [...gaps].toSorted();
		base.revise_directive =
			`Attempt ${String(attemptN)} closed items ${jsonReprList(sortedClosed)}; ` +
			`items ${jsonReprList(sortedGaps)} still open — YOU MUST close all ` +
			`${allIds.length} advisory_fix_items this round.`;
	}

	// Trim heavy fields to fit within reasonable prompt size.
	if (typeof base.poc_readme === "string" && base.poc_readme) {
		base.poc_readme = (base.poc_readme as string).slice(0, 5000);
	}
	const pinnedRaw = base.pinned_files;
	if (Array.isArray(pinnedRaw)) {
		for (const f of pinnedRaw) {
			if (f !== null && typeof f === "object") {
				const rec = f as Record<string, unknown>;
				if ("content_first_200_lines" in rec) {
					rec.content_first_200_lines = String(rec.content_first_200_lines ?? "").slice(0, 3000);
				}
			}
		}
	}

	writeStdout(`${pythonJsonDumps(base)}\n`);
	return 0;
}

// Python's `json.dumps(x)` defaults differ from `JSON.stringify(x)` in three
// ways that all matter for stdout byte-parity:
//   1. Item separator is `", "` (comma+space), key/value separator is `": "`.
//      JS's default is compact `,` / `:`.
//   2. `ensure_ascii=True` by default, so any code point >= U+0080 is emitted
//      as a `\uXXXX` escape. JS emits the raw UTF-8 bytes.
//   3. `print(...)` appends a trailing newline. The .py's final line is
//      `print(json.dumps(base))`; the .ts must mirror the `\n`.
//
// This helper handles (1) and (2); the trailing newline is applied by the
// caller so the semantics of "one JSON blob, one line" stay explicit.
function pythonJsonDumps(value: unknown): string {
	if (value === null || value === undefined) {
		return "null";
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (typeof value === "number") {
		// Python's json emits `Infinity` / `NaN` unquoted by default, but the
		// fixture never carries them. Match JS's `JSON.stringify` on finite
		// numbers, which produces the same digit output as Python for the
		// int/float shapes the impl actually sees.
		if (!Number.isFinite(value)) {
			throw new TypeError(`pythonJsonDumps: non-finite number ${String(value)}`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") {
		return pythonJsonString(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => pythonJsonDumps(v)).join(", ")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		return `{${entries
			.map(([k, v]) => `${pythonJsonString(k)}: ${pythonJsonDumps(v)}`)
			.join(", ")}}`;
	}
	throw new Error(`pythonJsonDumps: unsupported type ${typeof value}`);
}

// Serialize a string exactly the way Python's `json.dumps` with default
// `ensure_ascii=True` would: ASCII escapes match JSON, and any code point >=
// U+0080 becomes `\uXXXX` (or a surrogate pair for astral code points, which
// is precisely what Python emits too).
function pythonJsonString(s: string): string {
	let out = '"';
	for (let i = 0; i < s.length; i++) {
		const code = s.codePointAt(i);
		if (code === undefined) {
			throw new Error("unexpected undefined");
		}
		if (code === 0x22) {
			out += String.raw`\"`;
		} else if (code === 0x5c) {
			out += String.raw`\\`;
		} else if (code === 0x08) {
			out += String.raw`\b`;
		} else if (code === 0x09) {
			out += String.raw`\t`;
		} else if (code === 0x0a) {
			out += String.raw`\n`;
		} else if (code === 0x0c) {
			out += String.raw`\f`;
		} else if (code === 0x0d) {
			out += String.raw`\r`;
		} else if (code < 0x20 || code >= 0x7f) {
			out += String.raw`\u` + code.toString(16).padStart(4, "0");
		} else {
			out += s[i];
		}
	}
	out += '"';
	return out;
}

// Python's `str(sorted(list))` renders a list literal like `['a', 'b']` with
// single-quoted strings. The .py's f-string interpolation embedded that
// exact repr into the revise_directive; matching it byte-for-byte keeps the
// prompt-text golden across the port.
function jsonReprList(items: readonly string[]): string {
	if (items.length === 0) {
		return "[]";
	}
	return `[${items
		.map((s) => `'${s.replaceAll("\\", String.raw`\\`).replaceAll("'", String.raw`\'`)}'`)
		.join(", ")}]`;
}

// --- CLI entry -------------------------------------------------------------

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
		writeStderr(`prep-revise-input: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
