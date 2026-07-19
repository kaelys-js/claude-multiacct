/**
 * `bin/mise exec` wrapper shared across the foundation toolchain.
 *
 * Every QA/sync tool runs through the repo-scoped mise shim so versions come from
 * `mise.toml`. This consolidates the several inlined `spawnSync(join(root,
 * "bin/mise"), ["exec", "--", ...])` variants into one call, resolved against the
 * git repo root (so it survives a caller moving to any depth).
 *
 * @module
 */

import {
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	spawnSync,
} from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./repo-root.ts";

// Run a command through `bin/mise exec -- <args>` from the repo root, capturing
// UTF-8 output. Extra spawn options override the defaults (cwd, encoding).
export function miseExec(
	args: readonly string[],
	opts?: Partial<SpawnSyncOptionsWithStringEncoding>,
): SpawnSyncReturns<string> {
	const root = repoRoot();
	return spawnSync(join(root, "bin/mise"), ["exec", "--", ...args], {
		cwd: root,
		encoding: "utf8",
		...opts,
	});
}
