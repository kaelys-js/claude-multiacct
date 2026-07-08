#!/usr/bin/env node
/**
 * Re-fetch the vendored JSON schemas in `.schemas/` from their upstream source.
 *
 * The repo vendors config schemas so editors validate config files offline and
 * `check-jsonschema` has a stable metaschema. Tool-specific schemas are pinned
 * to the tool's version from `mise.toml`, so a version bump re-fetches the
 * matching schema; the rest are SchemaStore snapshots (re-fetched fresh).
 *
 * `--check` fetches into memory and exits non-zero if any vendored file differs
 * from upstream (CI drift), without writing.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE_TOML = join(ROOT, "mise.toml");
const SCHEMAS_DIR = join(ROOT, ".schemas");
const MISE = join(ROOT, "bin/mise");

// Read a tool's pinned version from the `[tools]` table of `mise.toml`.
function readToolVersion(toml: string, tool: string): string {
	const lines = toml.split("\n");
	let inTools = false;
	for (const line of lines) {
		const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
		if (header) {
			inTools = header[1] === "tools";
		} else if (inTools) {
			const escaped = tool.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
			const match = new RegExp(String.raw`^\s*"?${escaped}"?\s*=\s*"([^"]+)"`, "u").exec(line);
			if (match?.[1] !== undefined) {
				return match[1];
			}
		}
	}
	throw new Error(`mise.toml: no [tools] entry for "${tool}"`);
}

// SchemaStore canonical URL for an unversioned vendored schema.
function schemaStore(name: string): string {
	return `https://json.schemastore.org/${name}.json`;
}

/**
 * Map of vendored schema basename → a function of the `mise.toml` text that
 * returns its upstream download URL. Versioned entries read the pinned tool
 * version; SchemaStore entries ignore the argument and re-fetch canonically.
 */
// NOTE: `.schemas/gitleaks.json` and `.schemas/reuse.json` are hand-vendored (no
// public upstream) and intentionally excluded from SCHEMA_SOURCES so `sync:check`
// stays green.
const SCHEMA_SOURCES: Readonly<Record<string, (toml: string) => string>> = {
	oxlint: (t) =>
		`https://raw.githubusercontent.com/oxc-project/oxc/oxlint_v${readToolVersion(t, "npm:oxlint")}/npm/oxlint/configuration_schema.json`,
	// oxfmt lives in the oxc monorepo, which tags releases by the oxlint version.
	oxfmt: (t) =>
		`https://raw.githubusercontent.com/oxc-project/oxc/oxlint_v${readToolVersion(t, "npm:oxlint")}/npm/oxfmt/configuration_schema.json`,
	"markdownlint-cli2": (t) =>
		`https://raw.githubusercontent.com/DavidAnson/markdownlint-cli2/v${readToolVersion(t, "npm:markdownlint-cli2")}/schema/markdownlint-cli2-config-schema.json`,
	// mise ships its own always-current schema (unversioned; mise self-bootstraps).
	mise: () => "https://mise.jdx.dev/schema/mise.json",
	// lefthook + commitlint ship public upstream schemas; vendored UNVERSIONED (like
	// mise/taplo) so an offline editor still validates lefthook.yml / commitlint.config.json.
	lefthook: () => "https://raw.githubusercontent.com/evilmartians/lefthook/master/schema.json",
	commitlint: () => "https://json.schemastore.org/commitlintrc.json",
	// turbo ships its own public schema (unversioned, like mise); vendored so
	// turbo.json validates offline against `./.schemas/turbo.json`.
	turbo: () => "https://turbo.build/schema.json",
	// ── SchemaStore snapshots (unversioned; re-fetched fresh) ──────────
	taplo: () => schemaStore("taplo"),
	yamllint: () => schemaStore("yamllint"),
	package: () => schemaStore("package"),
	tsconfig: () => schemaStore("tsconfig"),
	"pnpm-workspace": () => schemaStore("pnpm-workspace"),
	"github-workflow": () => schemaStore("github-workflow"),
};

// Fetch a URL as UTF-8 text, throwing on any non-2xx response.
async function fetchText(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`fetch ${url} → HTTP ${res.status}`);
	}
	return res.text();
}

/**
 * The per-schema fetch+normalise outcome: `fresh` upstream text when it could be
 * downloaded and formatted, or an `error` message when the upstream was
 * unreachable (offline, DNS, 5xx, a malformed body, …). A skipped upstream is
 * NEVER treated as drift — the vendored copy simply can't be verified this run.
 */
export type SchemaOutcome =
	| { readonly ok: true; readonly name: string; readonly path: string; readonly fresh: string }
	| { readonly ok: false; readonly name: string; readonly path: string; readonly error: string };

// Whether a {@link SchemaOutcome} carries a successfully-fetched `fresh` copy.
export function isReachable(o: SchemaOutcome): o is Extract<SchemaOutcome, { ok: true }> {
	return o.ok;
}

// Reconcile fetched outcomes against the on-disk copies (pure — no IO). Reachable
// schemas whose formatted upstream differs from disk are `drifted` (in `--check`)
// or `toWrite` (otherwise); unreachable schemas are collected for a warning and
// NEVER counted as drift, so an offline run (or a flaky upstream) can't fail the
// check on something the caller's code didn't change.
export function reconcile(
	outcomes: readonly SchemaOutcome[],
	readCurrent: (path: string) => string,
): {
	drifted: string[];
	toWrite: Array<{ name: string; path: string; fresh: string }>;
	unreachable: Array<{ name: string; error: string }>;
	reachableCount: number;
} {
	const drifted: string[] = [];
	const toWrite: Array<{ name: string; path: string; fresh: string }> = [];
	const unreachable: Array<{ name: string; error: string }> = [];
	for (const o of outcomes) {
		if (!o.ok) {
			unreachable.push({ name: o.name, error: o.error });
		} else if (readCurrent(o.path) !== o.fresh) {
			drifted.push(o.name);
			toWrite.push(o);
		}
	}
	return {
		drifted,
		toWrite,
		unreachable,
		reachableCount: outcomes.length - unreachable.length,
	};
}

// Fetch + normalise ONE schema, never throwing: a network/HTTP/parse/format
// failure is captured as an `error` outcome so one unreachable upstream can't
// abort the whole sync (the resilience the pre-push + CI drift gate needs).
async function fetchSchema(name: string, toml: string): Promise<SchemaOutcome> {
	const path = join(SCHEMAS_DIR, `${name}.json`);
	try {
		const url = SCHEMA_SOURCES[name]?.(toml) ?? "";
		return { ok: true, name, path, fresh: oxfmtJson(await fetchText(url), path) };
	} catch (error) {
		return { ok: false, name, path, error: error instanceof Error ? error.message : String(error) };
	}
}

// Normalise raw schema JSON to the repo's canonical form by piping it through
// oxfmt (the repo's JSON formatter). Vendoring the oxfmt-formatted output keeps
// `sync:schemas` and `qa:format` in agreement — a freshly synced schema is
// already correctly formatted, so neither rewrites the other.
function oxfmtJson(raw: string, filepath: string): string {
	// Parse first so a malformed download fails loudly rather than vendoring junk.
	const compact = JSON.stringify(JSON.parse(raw));
	const res = spawnSync(MISE, ["exec", "--", "oxfmt", "--stdin-filepath", filepath], {
		input: compact,
		encoding: "utf8",
	});
	if (res.status !== 0) {
		throw new Error(`oxfmt failed: ${res.stderr}`);
	}
	return res.stdout;
}

// Fetch every vendored schema and reconcile it against the on-disk copy: in
// `--check` mode report drift and exit non-zero; otherwise write the fresh copy.
async function main(): Promise<void> {
	const toml = readFileSync(MISE_TOML, "utf8");
	const check = process.argv.includes("--check");
	const names = Object.keys(SCHEMA_SOURCES).toSorted();

	// Fetch all schemas in parallel — each RESILIENTLY (a failure becomes an
	// `error` outcome, never a rejection), then classify against disk purely. Each
	// reachable schema is normalised through oxfmt so the vendored form is stable
	// and matches what `qa:format` expects (no format/sync write-loop).
	const outcomes = await Promise.all(names.map((name) => fetchSchema(name, toml)));
	// A not-yet-vendored schema (first generation) reads as "" so reconcile counts
	// it as drift and writes it, rather than throwing ENOENT.
	const { drifted, toWrite, unreachable, reachableCount } = reconcile(outcomes, (p) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return "";
		}
	});

	// Unreachable upstreams are a WARNING, never a failure: an offline push or a
	// flaky SchemaStore can't red the drift gate on code the caller didn't touch.
	for (const { name, error } of unreachable) {
		process.stderr.write(
			`WARN: skipping .schemas/${name}.json — upstream unreachable (${error}).\n`,
		);
	}

	if (check) {
		if (drifted.length > 0) {
			for (const name of drifted) {
				process.stderr.write(`.schemas/${name}.json is out of sync with upstream.\n`);
			}
			process.stderr.write("Run `pnpm sync:schemas` to fix.\n");
			process.exit(1);
		}
		process.stdout.write(
			reachableCount === 0
				? "Schemas: all upstreams unreachable — drift check skipped (offline?).\n"
				: `Schemas are in sync (${String(reachableCount)}/${String(names.length)} verified).\n`,
		);
		return;
	}

	for (const { name, path, fresh } of toWrite) {
		writeFileSync(path, fresh);
		process.stdout.write(`Wrote .schemas/${name}.json.\n`);
	}
	process.stdout.write("Schemas synced.\n");
}

// Run only when executed directly (`node scripts/sync/schemas.ts`), NOT when the
// test suite imports the pure helpers above.
if (import.meta.filename === process.argv[1]) {
	await main();
}
