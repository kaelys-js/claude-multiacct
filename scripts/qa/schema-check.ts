#!/usr/bin/env node
/**
 * Instance validation: validate the repo's DATA/config files against their
 * schemas. Stardust's `check-jsonschema --check-metaschema` only proves the
 * `*.schema.json` files are themselves valid schemas; it never checks that our
 * actual config (owners.yaml, package.json, …) conforms to them. This runner
 * closes that gap by running `check-jsonschema --schemafile <schema> <data>`
 * for a fixed table of {data, schema} pairs.
 *
 * check-jsonschema natively parses YAML/JSON/TOML data, so mixed formats need
 * no pre-conversion. Every pair runs (no fail-fast); the process exits non-zero
 * if any pair failed.
 *
 * Run through the repo-scoped mise wrapper (`bin/mise exec`) so versions come
 * from mise.toml, matching the rest of scripts/qa.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE = join(ROOT, "bin/mise");

/** A data file paired with the schema it must conform to (both repo-relative). */
type Pair = {
	readonly data: string;
	readonly schema: string;
};

// The instance-validation table. Each data file is validated against its
// vendored (or repo-authored) schema. All schemas resolve offline — no pair is
// dropped for an unresolvable $ref.
const PAIRS: readonly Pair[] = [
	{ data: "owners.yaml", schema: "schema/owners.schema.json" },
	{ data: "package.json", schema: ".schemas/package.json" },
	{ data: "tsconfig.json", schema: ".schemas/tsconfig.json" },
	{ data: "pnpm-workspace.yaml", schema: ".schemas/pnpm-workspace.json" },
	{ data: "mise.toml", schema: ".schemas/mise.json" },
];

// Validate one pair through `bin/mise exec -- check-jsonschema`; true on pass.
// check-jsonschema's own diagnostics stream straight through (stdio inherit).
function validate(pair: Pair): boolean {
	const r = spawnSync(
		MISE,
		["exec", "--", "check-jsonschema", "--schemafile", pair.schema, pair.data],
		{ cwd: ROOT, stdio: "inherit" },
	);
	return r.status === 0;
}

function report(pair: Pair, ok: boolean): void {
	const mark = ok ? "✓ OK  " : "✗ FAIL";
	process.stdout.write(`  ${mark} ${pair.data} → ${pair.schema}\n`);
}

process.stdout.write("\u001B[1m▸ schema instance validation\u001B[0m\n");
let allOk = true;
for (const pair of PAIRS) {
	const ok = validate(pair);
	report(pair, ok);
	if (!ok) {
		allOk = false;
	}
}
process.exit(allOk ? 0 : 1);
