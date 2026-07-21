#!/usr/bin/env node
/**
 * `bundle-cross-file-check.ts` — TS port of `trp/scripts/bundle-cross-file-check.py`
 * (SRP-V). Cross-file semantic consistency checks over the bundle, run before
 * Stage F. Reads `discovery/trp-bundle-<task>.json` and scans every file's
 * `full_content` for consistency issues that lint won't catch:
 *
 * 1. Same env-var default set to DIFFERENT literal values across files.
 * 2. Same top-level const set to different literal values across files.
 * 3. Same import name resolved to different paths.
 *
 * Ported byte-for-byte from the Python original: every regex, every branch,
 * every message, every exit code preserved. No feature additions.
 *
 * Env: `BUNDLE_JSON`, `TASK_ID_SLUG`.
 * Exit: 0 on pass (or medium/low-only findings), 5 when any HIGH finding
 * remains.
 *
 * @module
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type BundleEntry = {
	path: string;
	full_content?: string;
};

type Bundle = {
	files_to_modify: BundleEntry[];
};

type Finding = {
	kind: string;
	severity: string;
	summary: string;
	locations: Record<string, string[]>;
};

// Pattern matches: process.env.NAME = "value" | process.env.NAME ??= "value"
// | process.env.NAME = process.env.NAME ?? "value"
const ENV_PATTERN =
	/process\.env\.([A-Z_][A-Z0-9_]*)\s*(?:\?\?=|=\s*(?:process\.env\.\1\s*\?\?\s*)?)\s*"([^"]+)"/gu;

// const NAME = "literal" — at module top level (indent 0)
const CONST_PATTERN = /^(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/gmu;

// import { X } from "path" — same X imported from different paths
const IMPORT_PATTERN =
	/import\s*(?:\{([^}]+)\}|(\*\s+as\s+\w+)|(\w+))\s*(?:,\s*\{([^}]+)\})?\s*from\s+"([^"]+)"/gu;

/**
 * Cross-file semantic consistency checker entry point. Reads the bundle at
 * `BUNDLE_JSON`, scans every file's `full_content` for env-var default
 * mismatches, top-level const mismatches, and import-path mismatches, then
 * writes a structured report under `discovery/`.
 *
 * @returns {number} The process exit code: 0 on pass (or medium/low-only
 *   findings), 5 when any HIGH finding remains.
 */
export async function main(): Promise<number> {
	// No I/O in this module is genuinely asynchronous (readFileSync/
	// writeFileSync are used throughout), but `main` keeps its async, Promise-
	// returning signature so a thrown validation error below becomes a
	// rejected promise rather than a synchronous throw — callers (and the
	// tests) rely on `main()` always returning a promise.
	await Promise.resolve();
	const bundlePath = process.env.BUNDLE_JSON;
	const taskIdSlug = process.env.TASK_ID_SLUG;
	if (bundlePath === undefined || taskIdSlug === undefined) {
		throw new Error("BUNDLE_JSON, TASK_ID_SLUG must both be set");
	}

	const b: Bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
	const files: Map<string, string> = new Map();
	for (const f of b.files_to_modify) {
		files.set(f.path, f.full_content ?? "");
	}

	const findings: Finding[] = [];

	// ── 1. env-var defaults ──────────────────────────────────────────
	const envValues: Map<string, Map<string, string[]>> = new Map();
	for (const [path, content] of files) {
		const rx = new RegExp(ENV_PATTERN.source, ENV_PATTERN.flags);
		let m: RegExpExecArray | null;
		while ((m = rx.exec(content)) !== null) {
			const [, name, value] = m as unknown as [string, string, string];
			if (!envValues.has(name)) {
				envValues.set(name, new Map());
			}
			const valMap = envValues.get(name);
			if (valMap === undefined) {
				throw new Error("unexpected undefined");
			}
			let paths = valMap.get(value);
			if (paths === undefined) {
				paths = [];
				valMap.set(value, paths);
			}
			paths.push(path);
		}
	}

	for (const [name, valMap] of envValues) {
		if (valMap.size > 1) {
			const locations: Record<string, string[]> = {};
			for (const [v, paths] of valMap) {
				locations[v] = paths;
			}
			findings.push({
				kind: "env-default-mismatch",
				severity: "high",
				summary: `env var ${name} has different defaults across files`,
				locations,
			});
		}
	}

	// ── 2. top-level constants ──────────────────────────────────────
	const constValues: Map<string, Map<string, string[]>> = new Map();
	for (const [path, content] of files) {
		const rx = new RegExp(CONST_PATTERN.source, CONST_PATTERN.flags);
		let m: RegExpExecArray | null;
		while ((m = rx.exec(content)) !== null) {
			const [, name, value] = m as unknown as [string, string, string];
			if (!constValues.has(name)) {
				constValues.set(name, new Map());
			}
			const valMap = constValues.get(name);
			if (valMap === undefined) {
				throw new Error("unexpected undefined");
			}
			let paths = valMap.get(value);
			if (paths === undefined) {
				paths = [];
				valMap.set(value, paths);
			}
			paths.push(path);
		}
	}

	for (const [name, valMap] of constValues) {
		if (valMap.size > 1) {
			const locations: Record<string, string[]> = {};
			for (const [v, paths] of valMap) {
				locations[v] = paths;
			}
			findings.push({
				kind: "const-value-mismatch",
				severity: "medium",
				summary: `const ${name} has different string values across files`,
				locations,
			});
		}
	}

	// ── 3. import path consistency ──────────────────────────────────
	const importPaths: Map<string, Map<string, string[]>> = new Map();
	for (const [path, content] of files) {
		const rx = new RegExp(IMPORT_PATTERN.source, IMPORT_PATTERN.flags);
		let m: RegExpExecArray | null;
		while ((m = rx.exec(content)) !== null) {
			const [, bracedNames, _starAs, _singleName, secondBracedNames, fromPath] = m;
			const namesGroup = bracedNames ?? secondBracedNames ?? "";
			if (fromPath === undefined) {
				throw new Error("unexpected undefined");
			}
			for (const rawName of namesGroup.trim().split(/,\s*/u)) {
				const [aliasHead] = rawName.trim().split(" as ");
				if (aliasHead === undefined) {
					throw new Error("unexpected undefined");
				}
				const n = aliasHead.trim();
				if (n) {
					if (!importPaths.has(n)) {
						importPaths.set(n, new Map());
					}
					const pathMap = importPaths.get(n);
					if (pathMap === undefined) {
						throw new Error("unexpected undefined");
					}
					let paths = pathMap.get(fromPath);
					if (paths === undefined) {
						paths = [];
						pathMap.set(fromPath, paths);
					}
					paths.push(path);
				}
			}
		}
	}

	for (const [name, pathMap] of importPaths) {
		if (pathMap.size > 1) {
			// Only flag if paths are meaningfully different (not just relative-form variance)
			// Normalize: strip .js suffix + leading ./ ../
			const norm: Map<string, string[]> = new Map();
			for (const [p, filesList] of pathMap) {
				// Python: p.replace('.js', '').lstrip('./').lstrip('.').lstrip('/')
				// str.replace with no count replaces ALL occurrences; lstrip with '.'
				// or '/' or './' strips any leading run of those characters.
				const key = p.replaceAll(".js", "").replace(/^[./]+/u, "");
				let normPaths = norm.get(key);
				if (normPaths === undefined) {
					normPaths = [];
					norm.set(key, normPaths);
				}
				normPaths.push(...filesList);
			}
			if (norm.size > 1) {
				const locations: Record<string, string[]> = {};
				for (const [p, filesList] of pathMap) {
					locations[p] = filesList;
				}
				findings.push({
					kind: "import-path-mismatch",
					severity: "low",
					summary: `${name} imported from different paths across files`,
					locations,
				});
			}
		}
	}

	// ── output ──────────────────────────────────────────────────────
	if (findings.length === 0) {
		process.stdout.write("   cross-file check: PASS (no consistency issues)\n");
		return 0;
	}

	// Write structured report for the loop's failure JSON.
	const reportPath = `discovery/bundle-cross-file-${taskIdSlug}.json`;
	writeFileSync(reportPath, `${JSON.stringify({ findings }, null, 2)}\n`);
	process.stdout.write(`   cross-file check: ${findings.length} finding(s) → ${reportPath}\n`);
	for (const f of findings) {
		process.stdout.write(`     [${f.severity.toUpperCase()}] ${f.summary}\n`);
		for (const [value, paths] of Object.entries(f.locations)) {
			process.stdout.write(`       "${value.slice(0, 60)}" in: ${paths.join(", ")}\n`);
		}
	}
	// HIGH severity blocks; MEDIUM/LOW warn only.
	const high = findings.filter((f) => f.severity === "high");
	return high.length > 0 ? 5 : 0;
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
