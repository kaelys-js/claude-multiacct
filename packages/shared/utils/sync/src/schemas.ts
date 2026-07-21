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
 * Every upstream fetch is time-bounded: an unreachable OR hung endpoint degrades
 * to a per-schema warning (never counted as drift, never an indefinite hang), so
 * a flaky upstream can't stall or falsely red the gate.
 *
 * @module
 */

import { repoRoot } from "@foundation/core";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToolVersion } from "./mise-toml.ts";
import { oxfmtText } from "./oxfmt.ts";

const ROOT = repoRoot();
const MISE_TOML = join(ROOT, "mise.toml");
const SCHEMAS_DIR = join(ROOT, ".schemas");

// SchemaStore canonical URL for an unversioned vendored schema.
function schemaStore(name: string): string {
	return `https://json.schemastore.org/${name}.json`;
}

/**
 * Map of vendored schema basename → a function of the `mise.toml` text that
 * returns its upstream download URL. Versioned entries read the pinned tool
 * version; SchemaStore entries ignore the argument and re-fetch canonically.
 */
// NOTE: `.schemas/gitleaks.json`, `.schemas/reuse.json`, and `.schemas/syncpack.json`
// are hand-vendored (no public upstream — syncpack v15 publishes no config schema)
// and intentionally excluded from SCHEMA_SOURCES so `sync:check` stays green.
const SCHEMA_SOURCES: Readonly<Record<string, (toml: string) => string>> = {
	oxlint: (t) =>
		`https://raw.githubusercontent.com/oxc-project/oxc/oxlint_v${readToolVersion(t, "npm:oxlint")}/npm/oxlint/configuration_schema.json`,
	// oxfmt lives in the oxc monorepo, which tags releases by the oxlint version.
	oxfmt: (t) =>
		`https://raw.githubusercontent.com/oxc-project/oxc/oxlint_v${readToolVersion(t, "npm:oxlint")}/npm/oxfmt/configuration_schema.json`,
	"markdownlint-cli2": (t) =>
		`https://raw.githubusercontent.com/DavidAnson/markdownlint-cli2/v${readToolVersion(t, "npm:markdownlint-cli2")}/schema/markdownlint-cli2-config-schema.json`,
	// The BARE markdownlint config schema (rules only), for the extended base in
	// @foundation/config — distinct from the cli2 wrapper schema above. Same
	// markdownlint-cli2 release ships both.
	markdownlint: (t) =>
		`https://raw.githubusercontent.com/DavidAnson/markdownlint-cli2/v${readToolVersion(t, "npm:markdownlint-cli2")}/schema/markdownlint-config-schema.json`,
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

// Per-fetch timeout. Without it, one hung upstream stalls the `Promise.all`
// below (and the whole pre-push/CI drift gate) indefinitely instead of degrading
// to the unreachable-warning path. AbortSignal.timeout aborts a slow request;
// fetchSchema catches the throw into an `error` outcome, exactly like any other
// unreachable upstream.
const FETCH_TIMEOUT_MS = 15_000;

// Fetch a URL as UTF-8 text, throwing on any non-2xx response — or if the request
// exceeds FETCH_TIMEOUT_MS, so a hung upstream is treated as unreachable rather
// than hanging the sync.
async function fetchText(url: string): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
async function fetchSchema(
	name: string,
	source: (toml: string) => string,
	toml: string,
): Promise<SchemaOutcome> {
	const path = join(SCHEMAS_DIR, `${name}.json`);
	try {
		return { ok: true, name, path, fresh: oxfmtJson(await fetchText(source(toml)), path) };
	} catch (error) {
		return { ok: false, name, path, error: error instanceof Error ? error.message : String(error) };
	}
}

// Deterministic name-order comparator (default string order) for the SCHEMA_SOURCES
// entries, so both the fetch order and the verified-count output stay stable.
function byName([a]: [string, unknown], [b]: [string, unknown]): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

// Normalise raw schema JSON to the repo's canonical form by piping it through
// oxfmt (the repo's JSON formatter). Vendoring the oxfmt-formatted output keeps
// `sync:schemas` and `qa:format` in agreement — a freshly synced schema is
// already correctly formatted, so neither rewrites the other.
function oxfmtJson(raw: string, filepath: string): string {
	// Parse first so a malformed download fails loudly rather than vendoring junk.
	const compact = JSON.stringify(JSON.parse(raw));
	return oxfmtText(compact, filepath);
}

// Fetch every vendored schema and reconcile it against the on-disk copy: in
// `--check` mode report drift and exit non-zero; otherwise write the fresh copy.
async function main(): Promise<void> {
	const toml = readFileSync(MISE_TOML, "utf8");
	const check = process.argv.includes("--check");
	// Sorted [name, source] pairs — the source function is passed straight into
	// fetchSchema (no `SCHEMA_SOURCES[name]` re-lookup, which would be a dead
	// possibly-undefined branch since every name IS a key here).
	const sources = Object.entries(SCHEMA_SOURCES).toSorted(byName);

	// Fetch all schemas in parallel — each RESILIENTLY (a failure becomes an
	// `error` outcome, never a rejection), then classify against disk purely. Each
	// reachable schema is normalised through oxfmt so the vendored form is stable
	// and matches what `qa:format` expects (no format/sync write-loop).
	const outcomes = await Promise.all(
		sources.map(([name, source]) => fetchSchema(name, source, toml)),
	);
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
				: `Schemas are in sync (${String(reachableCount)}/${String(sources.length)} verified).\n`,
		);
		return;
	}

	for (const { name, path, fresh } of toWrite) {
		writeFileSync(path, fresh);
		process.stdout.write(`Wrote .schemas/${name}.json.\n`);
	}
	process.stdout.write("Schemas synced.\n");
}

// Run only when executed directly (`node packages/shared/utils/sync/src/schemas.ts`), NOT when the
// test suite imports the pure helpers above.
if (import.meta.filename === process.argv[1]) {
	await main();
}
