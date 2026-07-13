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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sh, stdioJournal } from "@foundation/shell";

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

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// ─── Stage 2 — run() helper + PM detect + frozen install ─────────

// `set -euo pipefail` in bash aborts the whole script on any non-zero
// exit. Since we do not have that semantics for free in Node, `run()`
// throws `RunError` on non-zero exit and `main()` catches it, mapping
// the exit code back to the process. Signal-terminated children (which
// the bash version would see as 128 + N) surface as -1 from execa, so
// we normalise those to 1.
class RunError extends Error {
	readonly exitCode: number;
	readonly line: string;
	constructor(exitCode: number, line: string) {
		super(`command failed (exit ${exitCode}): ${line}`);
		this.exitCode = exitCode;
		this.line = line;
	}
}

type RunOptions = {
	readonly cwd?: string;
	readonly dryRun: boolean;
};

// Bash `run` function: echo the command with a leading `+ `, then execute
// unless DRY_RUN=1. Every side effect in the bash source flows through
// `run`, so dry-run coverage is total; the TS port preserves that.
async function run(cmd: string, args: readonly string[], opts: RunOptions): Promise<void> {
	const line = args.length === 0 ? cmd : `${cmd} ${args.join(" ")}`;
	process.stdout.write(`+ ${line}\n`);
	if (opts.dryRun) {
		return;
	}
	const result = await sh(cmd, args, {
		cwd: opts.cwd,
		journal: stdioJournal(),
		timeout: 0,
		rejectOnError: false,
	});
	if (result.exitCode !== 0) {
		const code = result.exitCode > 0 ? result.exitCode : 1;
		throw new RunError(code, line);
	}
}

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm" | "none";

// Detect package manager by lockfile. Order matters — pnpm before npm
// because some repos keep a stale package-lock.json alongside
// pnpm-lock.yaml (mirrors the bash source comment).
export function detectPm(fixSrc: string): PackageManager {
	if (isFile(join(fixSrc, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (isFile(join(fixSrc, "yarn.lock"))) {
		return "yarn";
	}
	if (isFile(join(fixSrc, "bun.lockb")) || isFile(join(fixSrc, "bun.lock"))) {
		return "bun";
	}
	if (isFile(join(fixSrc, "package-lock.json"))) {
		return "npm";
	}
	return "none";
}

// Frozen + ignore-scripts. Ignore-scripts blocks postinstall from running
// arbitrary code out of node_modules (SR8 supply-chain posture). npm has
// no `--frozen-lockfile`; `npm ci` is the equivalent lockfile-strict form.
function installCommand(pm: Exclude<PackageManager, "none">): {
	readonly cmd: string;
	readonly args: readonly string[];
} {
	switch (pm) {
		case "pnpm": {
			return { cmd: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
		}
		case "yarn": {
			return { cmd: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
		}
		case "bun": {
			return { cmd: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] };
		}
		case "npm": {
			return { cmd: "npm", args: ["ci", "--ignore-scripts"] };
		}
	}
}

// Runs the PM install branch. Prints `SKIP: no lockfile ...` to stderr
// (parity with the bash `>&2` redirect) and returns without executing
// when no lockfile is present; otherwise prints `PM: <pm>` to stdout
// and hands off to `run()` inside the fix-src cwd.
async function installStage(fixSrc: string, dryRun: boolean): Promise<void> {
	const pm = detectPm(fixSrc);
	if (pm === "none") {
		process.stderr.write(`SKIP: no lockfile in ${fixSrc} — nothing to install.\n`);
		return;
	}
	process.stdout.write(`PM: ${pm}\n`);
	const { cmd, args } = installCommand(pm);
	await run(cmd, args, { cwd: fixSrc, dryRun });
}

// ─── Stage 3 — Docker compose detect + optional `up -d` ──────────

// First match wins, mirroring the bash `for candidate in ...` loop. The
// list is authored in the same order the source declares so an operator
// diffing the two versions can compare at a glance.
const COMPOSE_CANDIDATES: readonly string[] = [
	"docker-compose.yml",
	"docker-compose.yaml",
	"compose.yml",
	"compose.yaml",
	"docker-compose-test.yml",
	"docker-compose.test.yml",
];

// Empty string signals "no compose file", matching the bash sentinel
// `COMPOSE_FILE=""`. Callers check the string, not a separate flag.
export function findComposeFile(fixSrc: string): string {
	for (const candidate of COMPOSE_CANDIDATES) {
		if (isFile(join(fixSrc, candidate))) {
			return candidate;
		}
	}
	return "";
}

// Reports what would be started; when `--with-docker` is set and a
// compose file was found, invokes `docker compose -f <file> up -d` via
// `run()` inside the fix-src cwd. Non-zero from docker propagates as a
// `RunError` for `main()` to translate into an exit code.
async function composeStage(fixSrc: string, withDocker: boolean, dryRun: boolean): Promise<void> {
	const composeFile = findComposeFile(fixSrc);
	if (!composeFile) {
		process.stdout.write("COMPOSE: none found.\n");
		return;
	}
	process.stdout.write(`COMPOSE: ${composeFile}\n`);
	if (!withDocker) {
		process.stdout.write("COMPOSE: --with-docker not set; skipping 'up -d'.\n");
		return;
	}
	await run("docker", ["compose", "-f", composeFile, "up", "-d"], {
		cwd: fixSrc,
		dryRun,
	});
}

// ─── Main + CLI invocation guard ──────────────────────────────────

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const outcome = parseArgs(argv);
	if (outcome.kind === "help") {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (outcome.kind === "err") {
		return outcome.exitCode;
	}
	const { fixSrc, withDocker, dryRun } = outcome.args;
	try {
		await installStage(fixSrc, dryRun);
		await composeStage(fixSrc, withDocker, dryRun);
	} catch (error) {
		if (error instanceof RunError) {
			return error.exitCode;
		}
		throw error;
	}
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
