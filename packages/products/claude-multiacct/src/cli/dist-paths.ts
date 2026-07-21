/**
 * `@foundation/claude-multiacct` — bundled-CLI path resolution.
 *
 * The built `dist/cma.js` needs to point real installers at sibling artifacts
 * (`dist/shim.js`, `dist/watcher.js`, `dist/daemon.js`, `dist/extension/`).
 * All four live in the same `dist/` dir the bundle itself lives in, so every
 * lookup here is "current file's parent dir + name". The earlier form used
 * `new URL("../../dist/X", import.meta.url)` which was correct from src but
 * off-by-one from bundled context and produced paths like
 * `packages/products/dist/shim.js` — silently wrong in prod. This module
 * exists so the rule is one line and directly testable with a synthesised
 * caller URL.
 *
 * @module
 */

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One resolver, one convention: the artifact is a sibling of the entry.
 *
 * @param {string} callerUrl - `import.meta.url` of the caller.
 * @param {string} name - Basename of the artifact.
 * @returns {string} Absolute path to the artifact.
 */
function siblingOfEntry(callerUrl: string, name: string): string {
	return join(dirname(fileURLToPath(callerUrl)), name);
}

/**
 * Path to `dist/extension/` (the Chrome-anchor extension dist that
 * `installExtension` copies into place) as a sibling of the entry file.
 *
 * @param {string} callerUrl - `import.meta.url` of the caller (wiring.ts /
 *   bundled cma.js). We use the caller's dir + `extension/`.
 * @returns {string} Absolute path to the extension dist dir.
 */
export function resolveExtensionDistDir(callerUrl: string): string {
	const dir = dirname(fileURLToPath(callerUrl));
	if (basename(dir) === "dist") {
		return join(dir, "extension");
	}
	// Src / dev context: `src/cli/wiring.ts` → up two into `dist/extension`.
	return join(dir, "..", "..", "dist", "extension");
}

/**
 * Path to `dist/watcher.js` as a sibling of the entry file. Used to deploy
 * the watcher script into `~/.claude-multiacct/watcher.js` so launchd can
 * spawn it.
 *
 * @param {string} callerUrl - `import.meta.url` of the caller.
 * @returns {string} Absolute path to `dist/watcher.js`.
 */
export function resolveWatcherScriptPath(callerUrl: string): string {
	const dir = dirname(fileURLToPath(callerUrl));
	if (basename(dir) === "dist") {
		return siblingOfEntry(callerUrl, "watcher.js");
	}
	return join(dir, "..", "..", "dist", "watcher.js");
}

/**
 * Path to `dist/daemon.js` as a sibling of the entry file. Used to deploy
 * the daemon script into `~/.claude-multiacct/daemon.js`.
 *
 * @param {string} callerUrl - `import.meta.url` of the caller.
 * @returns {string} Absolute path to `dist/daemon.js`.
 */
export function resolveDaemonScriptPath(callerUrl: string): string {
	const dir = dirname(fileURLToPath(callerUrl));
	if (basename(dir) === "dist") {
		return siblingOfEntry(callerUrl, "daemon.js");
	}
	return join(dir, "..", "..", "dist", "daemon.js");
}
