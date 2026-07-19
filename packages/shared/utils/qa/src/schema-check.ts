#!/usr/bin/env node
/**
 * Instance validation: validate the repo's DATA/config files against their
 * declared schemas. `check-jsonschema --check-metaschema` (a registry tool) only
 * proves the `*.schema.json` files are themselves valid schemas; it never checks
 * that our actual config (owners.yaml, package.json, …) CONFORMS to them. This
 * runner closes that gap.
 *
 * Unlike the old hand-maintained {data, schema} table, it AUTO-DISCOVERS: it
 * enumerates every tracked config file (json/jsonc/json5/yaml/yml/toml), reads
 * the schema reference the file itself declares, and validates against it. A
 * file with no reference is skipped; a new config file that declares a schema is
 * picked up automatically.
 *
 * Schema-reference syntax by format:
 *  - json / jsonc / json5: a top-level `"$schema"` (json5 may drop the quotes).
 *  - yaml / yml: a `# yaml-language-server: $schema=<ref>` line.
 *  - toml: a `#:schema <ref>` line.
 *
 * A `<ref>` that is a relative path resolves to a repo file; an `http(s)://`
 * ref is passed through. A remote schema that can't be downloaded (offline, 5xx)
 * is a WARNING — never a failure — mirroring `sync:schemas`' network resilience;
 * a genuine schema-validation failure IS a failure. The process exits non-zero
 * iff any file failed validation.
 *
 * Run through the repo-scoped mise wrapper (`bin/mise exec`) so versions come
 * from mise.toml, matching the rest of @foundation/qa.
 *
 * @module
 */

import { miseExec, repoRoot } from "@foundation/core";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const ROOT = repoRoot();

// Config extensions we know how to extract a schema reference from.
const CONFIG_EXTENSIONS = new Set(["json", "jsonc", "json5", "yaml", "yml", "toml"]);

// Directories excluded from discovery: `.schemas/**` are schemas themselves
// (metaschema-checked by the `check-jsonschema` registry tool, not instances);
// the rest are generated / vendored trees that are never repo config.
const EXCLUDED_PREFIXES: readonly string[] = [".schemas/", "node_modules/", ".mise/", ".turbo/"];

/** A discovered config file and the schema reference it declares. */
type Discovered = {
	readonly file: string;
	readonly ref: string;
};

// The file's extension without the dot, lowercased ("" if none).
function extOf(file: string): string {
	const dot = file.lastIndexOf(".");
	return dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
}

// Extract a JSON-family `$schema` value: the first `"$schema": "<ref>"` (quoted,
// as in json/jsonc) or `$schema: "<ref>"` (json5's optionally-unquoted key). We
// regex rather than parse so jsonc/json5 comments (and trailing commas) never
// trip us up. Returns null when the file declares none.
function extractJsonSchema(text: string): string | null {
	const m = /["']?\$schema["']?\s*:\s*["']([^"']+)["']/u.exec(text);
	return m?.[1] ?? null;
}

// Extract a YAML `# yaml-language-server: $schema=<ref>` reference, or null.
function extractYamlSchema(text: string): string | null {
	const m = /#\s*yaml-language-server:\s*\$schema=(\S+)/u.exec(text);
	return m?.[1] ?? null;
}

// Extract a TOML `#:schema <ref>` reference (first non-blank convention), or null.
function extractTomlSchema(text: string): string | null {
	const m = /#:schema\s+(\S+)/u.exec(text);
	return m?.[1] ?? null;
}

// Dispatch to the right extractor for a file's extension. Unknown extensions and
// files with no declared reference both yield null (skipped).
function extractRef(file: string, text: string): string | null {
	switch (extOf(file)) {
		case "json":
		case "jsonc":
		case "json5": {
			return extractJsonSchema(text);
		}
		case "yaml":
		case "yml": {
			return extractYamlSchema(text);
		}
		case "toml": {
			return extractTomlSchema(text);
		}
		default: {
			return null;
		}
	}
}

// Convert a jsonc/json5 source to strict JSON so a plain-JSON validator (which is
// all check-jsonschema offers offline — it can't read jsonc and has no bundled
// json5 parser) can parse it. In a single string-aware pass this drops `//` and
// `/* */` comments and normalises single-quoted strings to double-quoted; it then
// quotes bare identifier object keys and removes trailing commas. String literals
// are respected throughout — a `//`, `/*`, or `:` inside a string is preserved —
// which is why the comment/quote handling is a scanner, not a regex. This is the
// "parse leniently" step the discovery contract calls for.
function json5ToJson(src: string): string {
	let out = "";
	let inString = false;
	let quote = "";
	for (let i = 0; i < src.length; i += 1) {
		const ch = src[i];
		const next = src[i + 1];
		if (inString) {
			if (ch === "\\") {
				out += ch + (next ?? "");
				i += 1;
			} else if (ch === quote) {
				out += '"';
				inString = false;
			} else if (ch === '"') {
				out += String.raw`\"`;
			} else {
				out += ch;
			}
		} else if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			out += '"';
		} else if (ch === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") {
				i += 1;
			}
			out += "\n";
		} else if (ch === "/" && next === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
				i += 1;
			}
			i += 1;
		} else {
			out += ch;
		}
	}
	// Quote bare identifier keys (`key:` → `"key":`), anchored on the `{`/`,` that
	// precedes an object member so string values containing `:` are never matched.
	const quoted = out.replaceAll(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/gu, '$1"$2"$3');
	// Drop trailing commas (`,]` / `,}`), which JSON rejects but jsonc/json5 allow.
	return quoted.replaceAll(/,(\s*[\]}])/gu, "$1");
}

// True for an `http://` / `https://` schema reference (as opposed to a repo path).
function isRemote(ref: string): boolean {
	return /^https?:\/\//u.test(ref);
}

// Resolve a schema reference to the argument passed to `--schemafile`: a remote
// URL passes through; a relative path resolves against the REFERENCING FILE's
// directory (matching yaml-language-server / `$schema` semantics), so a ref like
// `../schema/x.json` from `templates/foo.yaml` reaches `schema/x.json`. Root-level
// files (dirname ".") keep working as `./x` → repo-root/x.
function resolveRef(ref: string, file: string): string {
	if (isRemote(ref)) {
		return ref;
	}
	const rel = ref.replace(/^\.\//u, "");
	return isAbsolute(rel) ? rel : join(ROOT, dirname(file), rel);
}

// Read a tracked file's schema reference, or null if it declares none / is an
// excluded path / a non-config extension / unreadable.
function refForFile(file: string): string | null {
	if (!CONFIG_EXTENSIONS.has(extOf(file)) || EXCLUDED_PREFIXES.some((p) => file.startsWith(p))) {
		return null;
	}
	let text: string;
	try {
		text = readFileSync(join(ROOT, file), "utf8");
	} catch {
		return null;
	}
	return extractRef(file, text);
}

// Enumerate tracked config files that declare a schema reference. Excluded
// directories and refless files are dropped. Deterministic (git ls-files order).
function discover(): Discovered[] {
	const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	const files = listed.stdout.split("\n").filter(Boolean);
	const found: Discovered[] = [];
	for (const file of files) {
		const ref = refForFile(file);
		if (ref !== null) {
			found.push({ file, ref });
		}
	}
	return found;
}

// ── Schema-coverage gate ────────────────────────────────────────────────────
// Instance validation (above) only covers files that ALREADY declare a schema.
// The coverage gate closes the other half: every tracked config file that COULD
// carry a schema marker MUST carry one, so a new `.yml`/`.toml`/`.json*` can't
// slip in unvalidated. A file with no marker is a hard FAIL (not a skip).

// Paths excluded from the coverage requirement: generated / vendored / lock
// files that are not authored repo config, plus the schemas themselves. `*.lock`
// and `**/*.schema.json` are matched by suffix; the rest are prefix/exact.
const COVERAGE_EXCLUDED_PREFIXES: readonly string[] = [
	".schemas/",
	"coverage/",
	"node_modules/",
	"dist/",
	"build/",
	".turbo/",
	".mise/",
	".git/",
];
const COVERAGE_EXCLUDED_EXACT = new Set([
	"pnpm-lock.yaml",
	"mise.lock",
	// `.sync-upstream.json` is a per-fork config consumed by
	// `packages/shared/utils/sync/src/opt-in-sync-upstream.ts`. No public
	// upstream schema exists for it and the CLI's `readConfig()` already
	// enforces the three required string fields at read time, so requiring a
	// `$schema` marker would add ceremony without catching anything the CLI
	// does not already catch.
	".sync-upstream.json",
	// The next two files are terraform-managed by `kaelys-js-infra`. The fleet-sync
	// workflow re-emits them from that source on every sync and strips any local
	// edits, so an inline `# yaml-language-server: $schema=…` marker is silently
	// removed on the next sync. Exempting them here lets the gate stay strict
	// everywhere else without fighting a loop with the sync workflow.
	".github/ISSUE_TEMPLATE/config.yml",
	".github/dependabot.yml",
]);

// Whether a tracked config file is exempt from the schema-coverage requirement.
// Test fixtures under any `**/tests/fixtures/` directory are data files, not repo
// config — the coverage gate exists to catch un-schemad config, not to force a
// `$schema` marker into every fixture input/output byte-for-byte on disk.
// `*.template.yml` / `*.template.yaml` are pre-substitution workflow templates
// (see `packages/shared/config/workflows/`); the CLI that consumes them writes
// the schema-ref appropriate to the OUTPUT location, so the template itself is
// intentionally schema-ref-less at rest.
function isCoverageExcluded(file: string): boolean {
	if (
		COVERAGE_EXCLUDED_EXACT.has(file) ||
		file.endsWith(".lock") ||
		file.endsWith(".schema.json") ||
		file.endsWith(".template.yml") ||
		file.endsWith(".template.yaml") ||
		file.includes("/tests/fixtures/")
	) {
		return true;
	}
	return COVERAGE_EXCLUDED_PREFIXES.some((p) => file.startsWith(p));
}

// Whether `file` is a coverage-gated config file (right extension, not excluded)
// that declares NO schema marker. Unreadable files are treated as compliant (the
// gate can't assert a marker it can't read; `git ls-files` output is trusted).
function lacksSchemaMarker(file: string): boolean {
	if (!CONFIG_EXTENSIONS.has(extOf(file)) || isCoverageExcluded(file)) {
		return false;
	}
	let text: string;
	try {
		text = readFileSync(join(ROOT, file), "utf8");
	} catch {
		return false;
	}
	return extractRef(file, text) === null;
}

// Tracked config files (json/jsonc/json5/yaml/yml/toml) that are NOT excluded
// yet declare NO schema marker. Deterministic (git ls-files order).
function missingSchemaRefs(): string[] {
	const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
	const files = listed.stdout.split("\n").filter(Boolean);
	return files.filter(lacksSchemaMarker);
}

// Signatures in check-jsonschema's output that mean the SCHEMA could not be
// downloaded (network/DNS/5xx), as opposed to a genuine validation failure.
const DOWNLOAD_FAILURE_SIGNATURES: readonly string[] = [
	"FailedDownloadError",
	"ConnectionError",
	"Max retries exceeded",
	"Failed to download",
	"Could not retrieve",
];

/** One file's validation outcome. */
type Outcome = "pass" | "fail" | "warn-unreachable";

// The status glyph for a reported outcome.
function mark(outcome: Outcome): string {
	if (outcome === "pass") {
		return "✓ OK  ";
	}
	if (outcome === "fail") {
		return "✗ FAIL";
	}
	return "⚠ WARN";
}

// The path check-jsonschema should validate for a discovered file. jsonc/json5
// carry comments (and json5 syntax) check-jsonschema can't parse, so we hand it a
// comment-stripped `.json` copy in a temp dir; other formats it parses natively.
// Returns the temp dir to clean up (or null when the file was used as-is).
function dataFileFor(d: Discovered): { path: string; cleanup: string | null } {
	const ext = extOf(d.file);
	if (ext !== "jsonc" && ext !== "json5") {
		return { path: d.file, cleanup: null };
	}
	const raw = readFileSync(join(ROOT, d.file), "utf8");
	const dir = mkdtempSync(join(tmpdir(), "schema-check-"));
	const path = join(dir, `${d.file.replaceAll("/", "_")}.json`);
	writeFileSync(path, json5ToJson(raw));
	return { path, cleanup: dir };
}

// Validate one discovered file against its resolved schema. A remote-schema
// download failure is classified `warn-unreachable` (network resilience); any
// other non-zero exit is a genuine `fail`.
function validate(d: Discovered): Outcome {
	const schemafile = resolveRef(d.ref, d.file);
	const { path, cleanup } = dataFileFor(d);
	// The data path is either the original file or a stripped jsonc/json5 copy with
	// a `.json` name, which check-jsonschema parses as plain JSON.
	const r = miseExec(["check-jsonschema", "--schemafile", schemafile, path], { cwd: ROOT });
	if (cleanup !== null) {
		rmSync(cleanup, { recursive: true, force: true });
	}
	const combined = `${r.stdout}${r.stderr}`;
	if (r.status === 0) {
		process.stdout.write(r.stdout);
		return "pass";
	}
	if (isRemote(d.ref) && DOWNLOAD_FAILURE_SIGNATURES.some((s) => combined.includes(s))) {
		process.stderr.write(
			`WARN: ${d.file} — schema ${d.ref} unreachable (offline?); skipping validation.\n`,
		);
		return "warn-unreachable";
	}
	// Genuine validation failure — surface check-jsonschema's own diagnostics.
	process.stdout.write(r.stdout);
	process.stderr.write(r.stderr);
	return "fail";
}

function main(): void {
	// Coverage gate first: every tracked config file that could carry a schema
	// marker must declare one. A miss is a hard failure (listed by name) — the
	// point is that an unvalidated config file can never merge.
	const missing = missingSchemaRefs();
	process.stdout.write("[1m▸ schema coverage gate[0m\n");
	if (missing.length > 0) {
		process.stderr.write(
			`  ✗ FAIL ${String(missing.length)} tracked config file(s) declare NO schema marker:\n`,
		);
		for (const file of missing) {
			process.stderr.write(`    ${file}\n`);
		}
		process.stderr.write(
			"  Add a marker ($schema | # yaml-language-server: $schema= | #:schema) or exclude it.\n",
		);
	} else {
		process.stdout.write("  ✓ OK   every tracked config file declares a schema marker\n");
	}

	const discovered = discover();

	process.stdout.write("[1m▸ schema instance validation (auto-discovered)[0m\n");
	process.stdout.write("  discovered set (file → schema):\n");
	for (const d of discovered) {
		process.stdout.write(`    ${d.file} → ${d.ref}\n`);
	}

	let failed = missing.length;
	for (const d of discovered) {
		const outcome = validate(d);
		process.stdout.write(`  ${mark(outcome)} ${d.file} → ${d.ref}\n`);
		if (outcome === "fail") {
			failed += 1;
		}
	}
	process.exit(failed > 0 ? 1 : 0);
}

main();
