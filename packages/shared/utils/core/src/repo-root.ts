/**
 * Repo-root resolution shared across the foundation toolchain (qa, sync, and the
 * record validator).
 *
 * Uses `git rev-parse --show-toplevel`, which is LOCATION-INDEPENDENT: it returns
 * the repo root no matter how deep in the workspace the caller lives. This is why
 * it replaces the fragile `join(import.meta.dirname, "..", "..")` arithmetic that
 * silently pointed at the wrong directory once a script moved deeper. Falls back
 * to the process CWD when git is somehow unavailable (matching the toolchain's
 * prior fallback behaviour).
 *
 * @module
 */

import { spawnSync } from "node:child_process";

// The absolute path of the repository root (`git rev-parse --show-toplevel`).
export function repoRoot(): string {
	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	return result.stdout.trim() || process.cwd();
}
