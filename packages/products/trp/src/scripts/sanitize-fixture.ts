#!/usr/bin/env node
/**
 * `sanitize-fixture.ts` — regex + structural scrub of stdin per a
 * `sanitize-manifest.json`.
 *
 * The Phase 6 composed-run parity harness pipes captured fixture output through
 * this script so timestamps, temp paths, git SHAs and other ephemeral bytes
 * collapse to stable placeholders before landing on disk. The same tool is
 * called on both sides of a G0 dual-run diff, so a stable-diff claim reads as
 * a claim about shell behaviour, not one lucky capture.
 *
 * Contract (per plan v4):
 *   sanitize-fixture &lt;path/to/sanitize-manifest.json&gt;   # stdin → stdout
 *
 *   Reads stdin. Applies `manifest.scrub_rules` in order to stdin bytes
 *   (regex substitution, `gu` flag). If the scrubbed bytes parse as JSON AND
 *   `manifest.structural_shape_only` is non-empty, walks the JSON and replaces
 *   values at each named slash-joined path with a sanitize marker matching the
 *   `@foundation/agents` convention:
 *
 *       { sanitized: true, len: &lt;number&gt;, hash: `fnv1a-&lt;16 hex&gt;` }
 *
 *   Emits the scrubbed bytes to stdout. Path convention mirrors
 *   `src/workflows/sanitize.ts` — top-level keys are just the key name,
 *   nested is `a/b`, array indices are numeric strings.
 *
 * Exit codes:
 *   0 - success (stdout carries the scrubbed bytes)
 *   2 - bad argv (missing or extra positional; only ONE manifest path allowed)
 *   3 - manifest not found, invalid JSON, or a rule inside it fails validation
 *       (missing fields, non-string members, un-compilable regex)
 *   4 - stdin read error (rare; surfaced loudly so a broken pipe never masks
 *       an empty scrub result)
 *
 * Error model: helpers throw {@link SanitizeExit} carrying the exit code so
 * `main()` collects it in one place before the wrapper calls `process.exit`.
 * Keeps the source free of scattered `process.exit` calls that would double-
 * fire when tests mock exit as a no-op.
 *
 * @module
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { fnv1a64 } from "../workflows/sanitize.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScrubRule = {
	readonly pattern: string;
	readonly replacement: string;
	readonly reason: string;
};

export type SanitizeManifest = {
	readonly scrub_rules: readonly ScrubRule[];
	readonly structural_shape_only: readonly string[];
};

export type SanitizeMarker = {
	readonly sanitized: true;
	readonly len: number;
	readonly hash: string;
};

export type MainOptions = {
	readonly stdinContent?: string;
};

const USAGE = "usage: sanitize-fixture <path/to/sanitize-manifest.json>";

/**
 * `BASE_SCRUB_RULES` is intentionally empty. The plan v4 design allows a base
 * set that per-fixture manifests extend by concatenation; the CURRENT repo
 * ships every rule inside the per-fixture manifest so the base is a documented
 * no-op. Kept as a named export so consumers relying on the "base rules exist"
 * contract pick them up without special-casing.
 */
export const BASE_SCRUB_RULES: readonly ScrubRule[] = [];

/**
 * Tagged exit signal thrown by helpers when a validation fails. `main()`
 * catches instances of this class and converts them into a numeric return
 * code — the CLI wrapper (or a test) does the actual `process.exit`. Splitting
 * the signal from the exit lets the source stay `process.exit`-free below
 * the wrapper, so a mock that treats exit as a no-op never double-fires.
 */
export class SanitizeExit extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
		this.name = "SanitizeExit";
	}
}

/**
 * Write `message` to stderr with the tool prefix, then throw {@link SanitizeExit}
 * carrying `code`. Return type `never` so TS treats calls as terminating.
 *
 * @param {number} code - exit code (2, 3, or 4)
 * @param {string} message - human-readable reason (also carried on the error)
 */
function die(code: number, message: string): never {
	process.stderr.write(`sanitize-fixture: ${message}\n`);
	throw new SanitizeExit(code, message);
}

// ---------------------------------------------------------------------------
// Manifest loader (throws SanitizeExit(3) on any content-shape error)
// ---------------------------------------------------------------------------

/**
 * Read a `sanitize-manifest.json` from `path` and validate its shape.
 *
 * Throws {@link SanitizeExit} with `code=3` on any of: missing file, unreadable
 * file, malformed JSON, non-object root, non-array `scrub_rules`, non-array
 * `structural_shape_only`, or a rule missing the `{pattern, replacement,
 * reason}` string trio.
 *
 * @param {string} path - filesystem path to the manifest file
 * @returns {SanitizeManifest} normalised manifest (always with `scrub_rules`
 *   and `structural_shape_only` present, possibly empty)
 */
export function loadManifest(path: string): SanitizeManifest {
	if (!existsSync(path)) {
		die(3, `manifest not found: ${path}`);
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error: unknown) {
		die(3, `cannot read manifest ${path}: ${String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		die(3, `invalid JSON in manifest ${path}: ${String(error)}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		die(3, `manifest must be a JSON object: ${path}`);
	}

	const record = parsed as Record<string, unknown>;
	const rules = parseScrubRules(record.scrub_rules, path);
	const structural = parseStructuralPaths(record.structural_shape_only, path);
	return { scrub_rules: rules, structural_shape_only: structural };
}

function parseScrubRules(raw: unknown, path: string): readonly ScrubRule[] {
	if (raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		die(3, `scrub_rules must be an array in ${path}`);
	}
	const out: ScrubRule[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			die(3, `scrub_rules[${i}] must be an object in ${path}`);
		}
		const rule = entry as Record<string, unknown>;
		const { pattern, replacement, reason } = rule;
		if (
			typeof pattern !== "string" ||
			typeof replacement !== "string" ||
			typeof reason !== "string"
		) {
			die(3, `scrub_rules[${i}] missing {pattern, replacement, reason} strings in ${path}`);
		}
		out.push({ pattern, replacement, reason });
	}
	return out;
}

function parseStructuralPaths(raw: unknown, path: string): readonly string[] {
	if (raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		die(3, `structural_shape_only must be an array in ${path}`);
	}
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (typeof item !== "string") {
			die(3, `structural_shape_only[${i}] must be a string in ${path}`);
		}
		out.push(item);
	}
	return out;
}

// ---------------------------------------------------------------------------
// scrub_rules — regex substitution
// ---------------------------------------------------------------------------

/**
 * Apply `rules` in declared order to `input`, returning the substituted string.
 * Each rule compiles with the `gu` flag so replacements are global and unicode-
 * aware. A rule whose `pattern` fails to compile throws {@link SanitizeExit}
 * with `code=3` (invalid manifest content).
 *
 * @param {string} input - the bytes to scrub
 * @param {readonly ScrubRule[]} rules - rules to apply in order; earlier rules
 *   run before later ones (order is load-bearing when a later pattern must not
 *   re-match an earlier replacement)
 * @returns {string} the scrubbed bytes
 */
export function applyScrubRules(input: string, rules: readonly ScrubRule[]): string {
	let out = input;
	// Using `entries()` avoids the noise of `rules[i]!` and gives us a typed
	// `rule` in the loop body without an "undefined-check" dead branch.
	for (const [i, rule] of rules.entries()) {
		let re: RegExp;
		try {
			re = new RegExp(rule.pattern, "gu");
		} catch (error: unknown) {
			die(3, `scrub_rules[${i}] pattern is not a valid regex (${rule.reason}): ${String(error)}`);
		}
		out = out.replace(re, rule.replacement);
	}
	return out;
}

// ---------------------------------------------------------------------------
// structural_shape_only — collapse values at named JSON paths
// ---------------------------------------------------------------------------

/**
 * Build a sanitize marker for `value` matching the `@foundation/agents`
 * convention (`{sanitized, len, hash}`).
 *
 * `len` counts the domain-appropriate measure:
 *   - string: character length
 *   - array: element count
 *   - object: key count
 *   - scalar (number/boolean/null): length of the JSON-serialised form
 *
 * `hash` is `fnv1a-` prepended to the 16-hex-char FNV-1a-64 of the
 * JSON-serialised form (the raw string for strings, so the hash matches
 * `sanitize.ts`'s marker shape).
 *
 * @param {unknown} value - the value to fingerprint
 * @returns {SanitizeMarker} the marker replacing `value` in the sanitized tree
 */
export function structuralMarker(value: unknown): SanitizeMarker {
	let len: number;
	let hashSource: string;
	if (typeof value === "string") {
		len = value.length;
		hashSource = value;
	} else if (Array.isArray(value)) {
		len = value.length;
		hashSource = JSON.stringify(value) ?? "null";
	} else if (value !== null && typeof value === "object") {
		len = Object.keys(value as Record<string, unknown>).length;
		hashSource = JSON.stringify(value) ?? "null";
	} else {
		// number, boolean, null
		hashSource = JSON.stringify(value) ?? "null";
		len = hashSource.length;
	}
	return { sanitized: true, len, hash: `fnv1a-${fnv1a64(hashSource)}` };
}

/**
 * Walk `value` and, at every slash-joined path listed in `paths`, replace the
 * subtree with a sanitize marker. Non-target subtrees are copied through with
 * key insertion order and array order preserved.
 *
 * Path examples:
 *   - `""`           → root replaced (rare, but supported for completeness)
 *   - `"summary"`    → top-level key `summary`
 *   - `"a/b/c"`      → nested key path
 *   - `"list/0"`     → first element of top-level `list` array
 *
 * @param {unknown} value - the JSON value to walk
 * @param {readonly string[]} paths - target paths to collapse
 * @returns {unknown} the walked value with markers at target paths
 */
export function applyStructuralShape(value: unknown, paths: readonly string[]): unknown {
	const targets = new Set(paths);
	function walk(node: unknown, path: string): unknown {
		if (targets.has(path)) {
			return structuralMarker(node);
		}
		if (Array.isArray(node)) {
			return node.map((item, i) => walk(item, path ? `${path}/${i}` : String(i)));
		}
		if (node !== null && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
				out[k] = walk(v, path ? `${path}/${k}` : k);
			}
			return out;
		}
		return node;
	}
	return walk(value, "");
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline on `input`: apply `scrub_rules` in order, then — if
 * `structural_shape_only` is non-empty and the scrubbed bytes parse as JSON —
 * walk the tree and collapse values at the named paths.
 *
 * When `structural_shape_only` is empty OR the input does not parse as JSON,
 * the scrubbed bytes pass through unchanged. When the structural pass runs,
 * the result is JSON.stringify'd with 2-space indent and a trailing newline
 * so the on-disk artefact ends the way every other JSON write in this repo
 * ends (`emit-trp-failure.ts` and friends).
 *
 * @param {string} input - stdin bytes
 * @param {SanitizeManifest} manifest - manifest driving the pipeline
 * @returns {string} the scrubbed bytes ready for stdout
 */
export function runPipeline(input: string, manifest: SanitizeManifest): string {
	const effectiveRules = [...BASE_SCRUB_RULES, ...manifest.scrub_rules];
	const scrubbed = applyScrubRules(input, effectiveRules);
	if (manifest.structural_shape_only.length === 0) {
		return scrubbed;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(scrubbed);
	} catch {
		// Not JSON — the structural pass is a documented no-op. The scrubbed
		// bytes flow through so a non-JSON fixture (a raw log capture, say)
		// still benefits from `scrub_rules`.
		return scrubbed;
	}
	const collapsed = applyStructuralShape(parsed, manifest.structural_shape_only);
	return `${JSON.stringify(collapsed, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// stdin reader (throws SanitizeExit(4) on read error)
// ---------------------------------------------------------------------------

/**
 * Synchronously read every byte from stdin (fd 0) as UTF-8. Throws
 * {@link SanitizeExit} with `code=4` on any read error, so a broken pipe never
 * masks an empty scrub result as a happy zero.
 *
 * @returns {string} stdin content as a UTF-8 string (empty when stdin is empty)
 */
export function readStdinSync(): string {
	try {
		return readFileSync(0, "utf8");
	} catch (error: unknown) {
		die(4, `stdin read error: ${String(error)}`);
	}
}

// ---------------------------------------------------------------------------
// argv validator (throws SanitizeExit(2) on missing / extra positional)
// ---------------------------------------------------------------------------

/**
 * Validate `argv` (already stripped of node + entry). Exactly one positional
 * is required; nothing may look like a flag.
 *
 * @param {readonly string[]} argv - positional arguments (after `process.argv.slice(2)`)
 * @returns {string} the sole positional (the manifest path)
 */
export function requireManifestPath(argv: readonly string[]): string {
	if (argv.length !== 1) {
		die(2, USAGE);
	}
	const [path] = argv;
	if (path === undefined || path.startsWith("--")) {
		die(2, USAGE);
	}
	return path;
}

// ---------------------------------------------------------------------------
// main() — CLI entry
// ---------------------------------------------------------------------------

/**
 * CLI entry. Reads `process.argv`, loads the manifest, reads stdin (or the
 * `stdinContent` override when provided by a test), runs the pipeline, writes
 * the scrubbed bytes to stdout, and returns the exit code. The wrapper below
 * calls `process.exit(main())` in production; tests can call `main()` directly
 * and assert on the return value.
 *
 * A helper throwing {@link SanitizeExit} converts to a matching numeric return
 * code. Any other error propagates so the wrapper's catch clause maps it to
 * an "unexpected error → exit 1" outcome.
 *
 * The `stdinContent` seam exists so unit tests don't have to bind
 * `readFileSync` to fd 0 — passing the content directly is the cleanest way
 * to drive main() from a spec without a real pipe. The CLI wrapper never
 * passes it.
 *
 * @param {MainOptions} [options] - `stdinContent` overrides real stdin (test seam)
 * @returns {number} exit code — 0 on success, or the code carried on the
 *   caught {@link SanitizeExit}
 */
export function main(options: MainOptions = {}): number {
	try {
		const argv = process.argv.slice(2);
		const manifestPath = requireManifestPath(argv);
		const manifest = loadManifest(manifestPath);
		const stdin = options.stdinContent ?? readStdinSync();
		const output = runPipeline(stdin, manifest);
		process.stdout.write(output);
		return 0;
	} catch (error) {
		if (error instanceof SanitizeExit) {
			return error.code;
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Direct-run guard
// ---------------------------------------------------------------------------

function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(resolve(entry));
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = main();
		process.exit(code);
	} catch (error: unknown) {
		process.stderr.write(`sanitize-fixture: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
