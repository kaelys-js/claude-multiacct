#!/usr/bin/env node
/**
 * Self-gating sync trigger for git hooks (post-checkout / post-merge).
 *
 * Git hooks can't reliably tell lefthook which files changed across a checkout
 * or merge, so instead of gating on a diff we gate on content: hash `mise.toml`
 * and compare it to the hash recorded the last time sync ran. If they differ
 * (or no marker exists yet), run the full `pnpm sync` and record the new hash;
 * if they match, exit immediately as a fast no-op.
 *
 * The marker lives at `.mise/.sync-hash`, which is gitignored (`.mise/` is), so
 * it is per-clone state and never committed.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const MISE = join(ROOT, "bin/mise");
const MISE_TOML = join(ROOT, "mise.toml");
const MARKER = join(ROOT, ".mise", ".sync-hash");

// Compute the SHA-256 hex digest of `mise.toml`'s current contents.
function hashMiseToml(): string {
	const contents = readFileSync(MISE_TOML);
	return createHash("sha256").update(contents).digest("hex");
}

// Read the hash recorded by the last successful sync, if any.
function readMarker(): string | null {
	if (!existsSync(MARKER)) {
		return null;
	}
	return readFileSync(MARKER, "utf8").trim();
}

// Record the given hash as the marker for the last successful sync, creating
// the `.mise` directory if it does not yet exist.
function writeMarker(hash: string): void {
	mkdirSync(dirname(MARKER), { recursive: true });
	writeFileSync(MARKER, `${hash}\n`);
}

// Run the full `pnpm sync` (versions + schemas + turbo) via the pinned mise
// toolchain, inheriting stdio so its output surfaces in the hook.
function runSync(): void {
	const res = spawnSync(MISE, ["exec", "--", "pnpm", "sync"], {
		cwd: ROOT,
		stdio: "inherit",
	});
	if (res.status !== 0) {
		throw new Error(`pnpm sync failed (exit ${res.status ?? "signal"})`);
	}
}

const current = hashMiseToml();
if (readMarker() === current) {
	process.exit(0);
}

process.stdout.write("mise.toml changed — running sync.\n");
runSync();
writeMarker(current);
