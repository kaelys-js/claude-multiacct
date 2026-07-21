/**
 * `@foundation/claude-multiacct` — narrow filesystem port used by the watcher's
 * pure `scan` module.
 *
 * The watcher classifies siblings of `~/Library/Application Support/Claude/
 * claude-code/`. That is a small handful of synchronous readdir / stat /
 * existsSync calls — the entire point of the port is to keep them injectable so
 * `scan.ts` stays pure and its tests don't touch real disk. `nodeFsPort()` is
 * the runtime binding; tests pass a stub.
 *
 * @module
 */

import { existsSync, readdirSync, statSync } from "node:fs";

/** Only the sync fs surface `scan.ts` actually calls. */
export type FsPort = {
	/** Return direct children of `path`. */
	readdirSync: (path: string) => string[];
	/** Return the minimum stat surface `scan.ts` reads. */
	statSync: (path: string) => { isDirectory: () => boolean; size: number };
	/** Test for path existence. */
	existsSync: (path: string) => boolean;
};

/**
 * Concrete `FsPort` bound to `node:fs`. Called once at watcher entry; tests
 * inject their own instead of stubbing globals.
 *
 * @returns {FsPort} An `FsPort` backed by real synchronous `node:fs` calls.
 */
export function nodeFsPort(): FsPort {
	return {
		readdirSync: (path) => readdirSync(path),
		statSync: (path) => {
			const s = statSync(path);
			return { isDirectory: () => s.isDirectory(), size: s.size };
		},
		existsSync: (path) => existsSync(path),
	};
}
