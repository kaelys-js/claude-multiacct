/**
 * `@foundation/claude-multiacct` — pure classification of the on-disk shape of
 * `~/Library/Application Support/Claude/claude-code/`.
 *
 * Claude Desktop drops each downloaded Code CLI version into a sibling
 * directory named for the version (`1.2.3`, `1.2.3-beta.1`, ...). On version
 * bump the previous dir's PR2 shim doesn't carry over — the new sibling has a
 * stock `claude` and no `claude.real`, which is what the watcher exists to
 * repair. This module *only* classifies; the decision to install is
 * `reconcile.ts` and the actual work is `watcher.ts`.
 *
 * Classification is total (every version-shaped child gets a `DirState`) and
 * fail-safe (unrecognized shapes → `other` with a `reason` string). Nothing in
 * here throws; the caller decides what to skip.
 *
 * @module
 */

import { join } from "node:path";
import type { FsPort } from "./fs-port.ts";

/** One classified sibling directory under the claude-code parent. */
export type DirState = {
	/** Absolute path to the version directory. */
	path: string;
	/** The version segment (basename of `path`). */
	version: string;
	/** Coarse classification driving `reconcile`. */
	kind: "installed" | "uninstalled" | "other";
	/** Human-readable reason for `other` (never set for the other kinds). */
	reason?: string;
};

// Pin `<major>.<minor>.<patch>` with a tolerant pre-release suffix. Anything
// outside this shape (`.DS_Store`, `README`, `1.2`, `1.2.3.4.tar.gz`) is
// silently ignored — those aren't ours to touch.
const VERSION_RE = /^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/u;

/**
 * Read `parentDir` and classify every version-shaped child. Non-version
 * children (`.DS_Store`, arbitrary siblings) are omitted from the result —
 * they aren't ours to reason about. An unreadable `parentDir` returns `[]`
 * rather than throwing; the caller (a `launchd` fire-and-forget agent) has
 * nowhere useful to route the error.
 *
 * @param {string} parentDir - Absolute path to the claude-code parent dir.
 * @param {FsPort} fs - Injected fs surface.
 * @returns {DirState[]} One `DirState` per version-shaped child.
 */
export function scanClaudeCodeDirs(parentDir: string, fs: FsPort): DirState[] {
	let children: string[];
	try {
		children = fs.readdirSync(parentDir);
	} catch {
		return [];
	}
	const results: DirState[] = [];
	for (const name of children) {
		if (VERSION_RE.test(name)) {
			results.push(classify(join(parentDir, name), name, fs));
		}
	}
	return results;
}

/**
 * Classify a single already-version-shaped child. Extracted from the loop so
 * scan.ts stays `continue`-free per the repo's eslint config.
 *
 * @param {string} path - Absolute path to the version directory.
 * @param {string} version - Basename of `path`.
 * @param {FsPort} fs - Injected fs port.
 * @returns {DirState} Classification for the dir.
 */
function classify(path: string, version: string, fs: FsPort): DirState {
	let isDir: boolean;
	try {
		isDir = fs.statSync(path).isDirectory();
	} catch {
		return { path, version, kind: "other", reason: "stat-failed" };
	}
	if (!isDir) {
		return { path, version, kind: "other", reason: "not-a-directory" };
	}
	const macosDir = join(path, "claude.app", "Contents", "MacOS");
	if (!fs.existsSync(macosDir)) {
		return { path, version, kind: "other", reason: "missing-macos-dir" };
	}
	const claude = join(macosDir, "claude");
	if (!fs.existsSync(claude)) {
		return { path, version, kind: "other", reason: "missing-claude" };
	}
	const real = join(macosDir, "claude.real");
	if (!fs.existsSync(real)) {
		return { path, version, kind: "uninstalled" };
	}
	let size = 0;
	try {
		({ size } = fs.statSync(real));
	} catch {
		size = 0;
	}
	if (size > 0) {
		return { path, version, kind: "installed" };
	}
	return { path, version, kind: "other", reason: "empty-claude-real" };
}
