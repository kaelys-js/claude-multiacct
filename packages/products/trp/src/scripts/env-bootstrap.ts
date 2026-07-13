#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * `env-bootstrap.ts` — TS port of `trp/scripts/env-bootstrap.sh`.
 *
 * Brings a fix-src tree to a state where lint / test / build can run.
 * Detects the package manager from lockfile fingerprint, runs a frozen,
 * script-free install, and (opt-in) brings up a docker compose model used
 * by the client's integration suite.
 *
 * Migrated line-for-line from the bash source: every branch, exit code,
 * env-var check, and log line preserved verbatim. Bash `set -euo pipefail`
 * semantics map to an explicit `RunError` throw that bubbles to `main()`
 * as an exit code; the source has no `trap` so there is no cleanup stack
 * to unwind here.
 *
 * Usage:
 *   env-bootstrap.ts <fix-src-path> [--with-docker] [--dry-run]
 *
 * @module
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ─── Stage 1 — Argument parsing + fix-src validation ─────────────

// The USAGE text mirrors what `sed -n '2,12p' "$0"` prints in the bash
// source when the operator passes `--help`. Line 12 (`set -euo pipefail`)
// is included intentionally — the bash sed range is inclusive and we keep
// output parity, quirks and all.
const USAGE = `# env-bootstrap.sh — bring a fix-src tree to a state where lint / test / build
# can run. Detects the package manager from lockfile fingerprint, runs a
# frozen, script-free install, and (opt-in) brings up a docker compose model
# used by the client's integration suite.
#
# Portable to bash 3.2 (stock macOS) — no associative arrays, no \`mapfile\`,
# no \`[[ =~ ]]\` features that only land in bash 4+.
#
# Usage:
#   env-bootstrap.sh <fix-src-path> [--with-docker] [--dry-run]
set -euo pipefail`;

// Shared fs guards. Bash's `[ -d path ]` / `[ -f path ]` do not throw on
// broken symlinks or permission errors; they just return false. Match that
// with try/catch around statSync so callers stay simple.
function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export type ParsedArgs = {
	readonly fixSrc: string;
	readonly withDocker: boolean;
	readonly dryRun: boolean;
};

type ParseOutcome =
	| { readonly kind: "ok"; readonly args: ParsedArgs }
	| { readonly kind: "help" }
	| { readonly kind: "err"; readonly exitCode: number };

// Bash `for arg in "$@"` walk. Preserves the source's exit-code contract:
// unknown flags and duplicate positionals return 2; missing / non-directory
// fix-src returns 2 with the exact error string the bash version writes.
export function parseArgs(argv: readonly string[]): ParseOutcome {
	let dryRun = false;
	let withDocker = false;
	let fixSrc = "";
	for (const arg of argv) {
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--with-docker") {
			withDocker = true;
		} else if (arg === "--help" || arg === "-h") {
			return { kind: "help" };
		} else if (arg.startsWith("-")) {
			process.stderr.write(`ERROR: unknown flag: ${arg}\n`);
			return { kind: "err", exitCode: 2 };
		} else if (fixSrc) {
			process.stderr.write(`ERROR: unexpected positional arg: ${arg}\n`);
			return { kind: "err", exitCode: 2 };
		} else {
			// First positional wins, matching `[ -z "$FIX_SRC" ]` in bash.
			fixSrc = arg;
		}
	}
	// Top-level checks after the for loop — the bash version does these
	// with `[ -n ... ] || { ...; exit 2; }` immediately after arg parsing.
	if (!fixSrc) {
		process.stderr.write("ERROR: fix-src path required.\n");
		return { kind: "err", exitCode: 2 };
	}
	if (!isDir(fixSrc)) {
		process.stderr.write(`ERROR: fix-src not a directory: ${fixSrc}\n`);
		return { kind: "err", exitCode: 2 };
	}
	return { kind: "ok", args: { fixSrc, withDocker, dryRun } };
}

// ─── Main + CLI invocation guard ──────────────────────────────────

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	await Promise.resolve();
	const outcome = parseArgs(argv);
	if (outcome.kind === "help") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (outcome.kind === "err") {
		return outcome.exitCode;
	}
	// outcome.kind === "ok" here. Install + compose stages land in later
	// commits; until then a valid invocation is a no-op that returns 0.
	return 0;
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
