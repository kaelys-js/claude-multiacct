#!/usr/bin/env node
/**
 * Wraps `ec` (editorconfig-checker) to close a real gap: `ec` prints a
 * `.editorconfig` PARSE error to stderr but still exits 0, so a malformed
 * `.editorconfig` sails through `qa:lint` today. This wrapper spawns `ec`
 * through the repo-scoped mise wrapper, echoes its output so users still see
 * any conformance issues, and exits non-zero if `ec` exited non-zero OR its
 * output carries a `.editorconfig` parse-error signature.
 *
 * Registry id `editorconfig` runs this instead of bare `ec`.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE = join(ROOT, "bin/mise");

// Substrings that only appear when `ec` fails to PARSE `.editorconfig` itself
// (as opposed to a normal conformance finding). `ec` emits these to stderr but
// still exits 0, so they must be promoted to a hard failure here.
const PARSE_ERROR_SIGNATURES: readonly string[] = [
	'cannot parse the ini file ".editorconfig"',
	'error loading ini file "',
];

// True when `ec`'s combined output names a `.editorconfig` load/parse error.
function hasParseError(output: string): boolean {
	return PARSE_ERROR_SIGNATURES.some((sig) => output.includes(sig));
}

const result = spawnSync(MISE, ["exec", "--", "ec"], { cwd: ROOT, encoding: "utf8" });
const combined = `${result.stdout}${result.stderr}`;

// Echo `ec`'s own output (we captured rather than inherited it) so real
// conformance findings and parse errors both stay visible to the user.
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);

const status = result.status ?? 1;
if (status !== 0) {
	process.exit(status);
}

if (hasParseError(combined)) {
	process.stderr.write(
		"editorconfig-check: `ec` reported a .editorconfig parse error but exited 0 — failing.\n",
	);
	process.exit(1);
}

process.exit(0);
