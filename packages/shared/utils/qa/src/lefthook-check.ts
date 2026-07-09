#!/usr/bin/env node
/**
 * Wraps `lefthook dump` to close a real gap the Stage-0 config relocation opened:
 * the root `lefthook.yml` is a thin stub that `extends` the authoritative base at
 * `packages/shared/config/lefthook.yml`. `lefthook validate` (what `qa:hooks`
 * runs) returns "All good" EVEN WHEN that extends target is missing — so if the
 * base is ever moved or renamed, validate stays green while every git hook
 * silently stops firing (no commit-msg gate, no pre-commit format/lint, no
 * pre-push typecheck/test/coverage).
 *
 * `lefthook dump` reflects the actual MERGED config the hooks use. This gate
 * asserts every expected hook survives the merge; a broken `extends` collapses
 * the dump to just the stub's `extends:` line, and the missing hooks fail loud.
 *
 * Registry id `lefthook` runs this in the `qa:lint` pipeline (pre-push + CI).
 *
 * @module
 */

import { repoRoot } from "@foundation/core";
import { spawnSync } from "node:child_process";

const ROOT = repoRoot();

// The hooks the merged lefthook config MUST define (the union declared in the
// moved base). If the stub's `extends` fails to resolve, these disappear from
// `lefthook dump` while `lefthook validate` still passes — the exact gap here.
const REQUIRED_HOOKS: readonly string[] = [
	"commit-msg",
	"pre-commit",
	"pre-push",
	"post-checkout",
	"post-merge",
];

// lefthook is a node_modules bin (not a mise tool), so it's reached via pnpm —
// the same way the registry invokes tsc/syncpack.
const result = spawnSync("pnpm", ["exec", "lefthook", "dump"], { cwd: ROOT, encoding: "utf8" });

if (result.status !== 0) {
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	process.stderr.write("lefthook-check: `lefthook dump` failed — cannot verify hook integrity.\n");
	process.exit(result.status ?? 1);
}

// `dump` emits the merged config as YAML; a hook is present iff a top-level
// `<hook>:` line appears (string match, so no dynamic-regex construction).
const lines = result.stdout.split("\n");
const missing = REQUIRED_HOOKS.filter((hook) => !lines.some((line) => line.startsWith(`${hook}:`)));

if (missing.length > 0) {
	process.stderr.write(
		`lefthook-check: merged config is MISSING hook(s): ${missing.join(", ")}.\n`,
	);
	process.stderr.write(
		"The root lefthook.yml stub's `extends` target (packages/shared/config/lefthook.yml) likely failed to resolve. `lefthook validate` does NOT catch this — run `pnpm exec lefthook dump` to inspect.\n",
	);
	process.exit(1);
}

process.stdout.write(
	`lefthook-check: OK — all ${String(REQUIRED_HOOKS.length)} expected hooks present in the merged config.\n`,
);
process.exit(0);
