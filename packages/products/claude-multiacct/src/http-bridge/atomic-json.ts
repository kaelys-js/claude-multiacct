/**
 * `@foundation/claude-multiacct` — atomic JSON writer.
 *
 * `atomicWriteJson(path, data, mode)` writes `data` to `path` such that any
 * observer sees either the previous file contents or the fully-written new
 * contents — never a truncated or half-written file. Implementation is the
 * standard tmp + rename dance:
 *
 *   1. `mkdir -p dirname(path)` so the target dir always exists.
 *   2. Write to `<path>.tmp-<pid>-<time>` with `mode` set on the tmp file.
 *   3. `fs.rename(tmp, path)`. `rename` within a single directory is atomic
 *      on macOS APFS (POSIX-defined behavior).
 *
 * A crash between (2) and (3) leaves the tmp on disk and the target file
 * untouched; callers can sweep stale tmps. `fs.rename` REPLACES the target
 * file in place, preserving neither its mode nor its inode — so the mode
 * arg is honored on every write, not just the first.
 *
 * Used by `server.ts` for `bridge.json` (the daemon's port+secret handoff
 * file) where the mode must be `0o600` — the secret is a shared bearer
 * token; a world-readable sidecar would give any local process the keys.
 *
 * `deps` is an optional injection point so a test can force `rename` to
 * throw AFTER the tmp is on disk (proving the tmp-first invariant); real
 * callers rely on the `node:fs/promises` defaults.
 *
 * @module
 */

import * as realFsp from "node:fs/promises";
import { dirname } from "node:path";

/** Minimal fs surface `atomicWriteJson` needs. Test-injectable. */
export type AtomicWriteFs = {
	mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
	writeFile: (
		path: string,
		data: string,
		opts: { encoding: "utf8"; mode: number },
	) => Promise<void>;
	chmod: (path: string, mode: number) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
};

const defaultFs: AtomicWriteFs = {
	mkdir: (p, o) => realFsp.mkdir(p, o),
	writeFile: (p, d, o) => realFsp.writeFile(p, d, o),
	chmod: (p, m) => realFsp.chmod(p, m),
	rename: (f, t) => realFsp.rename(f, t),
};

/**
 * Atomically write JSON `data` to `path` with the given POSIX `mode`.
 *
 * @param {string} path - Absolute destination path.
 * @param {unknown} data - JSON-serializable value.
 * @param {number} mode - POSIX mode bits (e.g. `0o600` for owner-only).
 * @param {AtomicWriteFs} [deps] - Injected fs surface; defaults to `node:fs/promises`.
 * @returns {Promise<void>} Resolves once the rename has landed.
 */
export async function atomicWriteJson(
	path: string,
	data: unknown,
	mode: number,
	deps: AtomicWriteFs = defaultFs,
): Promise<void> {
	await deps.mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`;
	await deps.writeFile(tmpPath, JSON.stringify(data), { encoding: "utf8", mode });
	// Force the mode explicitly: some platforms honor `writeFile`'s mode
	// opt only on file creation, not on overwrite. Deterministic regardless
	// of umask, platform, or a stale sibling.
	await deps.chmod(tmpPath, mode);
	await deps.rename(tmpPath, path);
}
