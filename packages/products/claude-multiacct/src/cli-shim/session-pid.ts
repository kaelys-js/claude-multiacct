/**
 * `@foundation/claude-multiacct` — session PID file for hot-swap signalling.
 *
 * The daemon needs a way to tell a running shim "this session's account
 * choice just changed — kill your child claude and respawn it with the
 * new OAuth token". PID files at `~/.claude-multiacct/sessions/<uuid>.pid`
 * are the signalling channel:
 *
 *   1. Shim writes its own PID at spawn (mode 0600).
 *   2. Daemon's `POST /choice/:sessionUuid` reads that file, sends
 *      SIGHUP to the pid.
 *   3. Shim traps SIGHUP → kills child `claude` (SIGTERM), waits for
 *      exit, respawns with fresh `CLAUDE_CODE_OAUTH_TOKEN` env.
 *
 * Cleanup: shim removes its own pid file on exit. Stale files (shim
 * crashed) are pruned lazily on next write. Missing file → daemon
 * silently skips signalling (session may have exited between choice
 * and signal).
 *
 * @module
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default parent dir for session PID files.
 *
 * @returns {string} Absolute path — `~/.claude-multiacct/sessions/`.
 */
export function defaultSessionDir(): string {
	return join(homedir(), ".claude-multiacct", "sessions");
}

/**
 * Default parent dir the app materializes per CLI session as `<uuid>/`. The
 * `<uuid>` here is the SAME namespace the shim keys on (the
 * `--session-id`/`--resume` id the desktop launcher passes), so this dir's
 * per-session mtime is the freshness signal the daemon ranks live sessions by.
 *
 * @returns {string} Absolute path — `~/.claude/session-env/`.
 */
export function defaultSessionEnvDir(): string {
	return join(homedir(), ".claude", "session-env");
}

/**
 * Absolute path of the PID file for a given session uuid.
 *
 * @param {string} sessionUuid - Session uuid.
 * @param {string} [dir] - Parent dir override (tests).
 * @returns {string} Absolute path.
 */
export function sessionPidPath(sessionUuid: string, dir: string = defaultSessionDir()): string {
	return join(dir, `${sessionUuid}.pid`);
}

/**
 * Write our PID as the current owner of `sessionUuid`.
 *
 * @param {string} sessionUuid - Session uuid the shim is running for.
 * @param {number} pid - The shim's own PID.
 * @param {string} [dir] - Parent dir override (tests).
 * @returns {Promise<void>}
 */
export async function writeSessionPid(
	sessionUuid: string,
	pid: number,
	dir: string = defaultSessionDir(),
): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(sessionPidPath(sessionUuid, dir), `${String(pid)}\n`, { mode: 0o600 });
}

/**
 * Read the PID currently associated with `sessionUuid`. Returns
 * undefined when the file is missing or unreadable.
 *
 * @param {string} sessionUuid - Session uuid.
 * @param {string} [dir] - Parent dir override.
 * @returns {Promise<number | undefined>} PID or `undefined`.
 */
export async function readSessionPid(
	sessionUuid: string,
	dir: string = defaultSessionDir(),
): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await readFile(sessionPidPath(sessionUuid, dir), "utf8");
	} catch {
		return undefined;
	}
	const n = Math.trunc(Number(raw.trim()));
	if (!Number.isInteger(n) || n <= 0) {
		return undefined;
	}
	return n;
}

/**
 * Delete our PID file. Called by shim on graceful exit; idempotent.
 *
 * @param {string} sessionUuid - Session uuid.
 * @param {string} [dir] - Parent dir override.
 * @returns {Promise<void>}
 */
export async function removeSessionPid(
	sessionUuid: string,
	dir: string = defaultSessionDir(),
): Promise<void> {
	try {
		await rm(sessionPidPath(sessionUuid, dir), { force: true });
	} catch {
		// idempotent
	}
}

/**
 * True iff `pid` is a live process. Uses `process.kill(pid, 0)` — the
 * signal 0 syscall is Unix's "does this pid exist and can I signal it"
 * probe; it doesn't actually send a signal.
 *
 * @param {number} pid - PID to probe.
 * @returns {boolean} Whether the process is alive.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Signal the shim owning `sessionUuid` (via its PID file) with SIGHUP,
 * telling it to swap accounts on next opportunity. Returns:
 *   - `"signalled"` — the file existed, PID was alive, kill succeeded.
 *   - `"no-owner"` — no PID file (session has no live shim; nothing to signal).
 *   - `"stale"` — PID file present but the PID isn't alive; we cleaned it up.
 *
 * @param {string} sessionUuid - Session uuid.
 * @param {(pid: number) => boolean} [alive] - Injectable alive-check.
 * @param {(pid: number, signal: "SIGHUP") => void} [signal] - Injectable kill.
 * @param {string} [dir] - Parent dir override.
 * @returns {Promise<"signalled" | "no-owner" | "stale">} Result.
 */
export async function signalSwap(
	sessionUuid: string,
	alive: (pid: number) => boolean = isPidAlive,
	signal: (pid: number, sig: "SIGHUP") => void = (pid, sig) => {
		process.kill(pid, sig);
	},
	dir: string = defaultSessionDir(),
): Promise<"signalled" | "no-owner" | "stale"> {
	const pid = await readSessionPid(sessionUuid, dir);
	if (pid === undefined) {
		return "no-owner";
	}
	if (!alive(pid)) {
		await removeSessionPid(sessionUuid, dir);
		return "stale";
	}
	try {
		signal(pid, "SIGHUP");
		return "signalled";
	} catch {
		await removeSessionPid(sessionUuid, dir);
		return "stale";
	}
}

/**
 * Modification time (ms) of `path`, or `undefined` when it can't be stat'd
 * (missing dir/entry). Swallows the error so the caller ranks by "no signal"
 * rather than throwing on an absent session-env dir.
 *
 * @param {string} path - Filesystem path to stat.
 * @returns {Promise<number | undefined>} `mtimeMs`, or `undefined` when absent.
 */
async function defaultStatMtime(path: string): Promise<number | undefined> {
	try {
		const stats = await stat(path);
		return stats.mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * List a directory's entries, or `[]` when the dir is absent/unreadable. An
 * empty sessions dir and a missing sessions dir are the same thing to the
 * resolver: no live session.
 *
 * @param {string} dir - Directory to list.
 * @returns {Promise<string[]>} Entry names, or `[]` on error.
 */
async function defaultReaddir(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/**
 * Recency rank for a live session uuid: the session-env dir's mtime when it
 * exists, else the pid file's own mtime. Newest-first ranking uses this.
 *
 * @param {string} uuid - Session uuid.
 * @param {(path: string) => Promise<number | undefined>} statMtime - Injectable stat.
 * @param {string} sessionPidDir - Parent dir of the pid files.
 * @param {string} sessionEnvDir - Parent dir of the per-session env dirs.
 * @returns {Promise<number>} Rank mtime (ms); `0` when neither is available.
 */
async function rankMtime(
	uuid: string,
	statMtime: (path: string) => Promise<number | undefined>,
	sessionPidDir: string,
	sessionEnvDir: string,
): Promise<number> {
	const envMtime = await statMtime(join(sessionEnvDir, uuid));
	if (envMtime !== undefined) {
		return envMtime;
	}
	return (await statMtime(sessionPidPath(uuid, sessionPidDir))) ?? 0;
}

/**
 * Resolve the uuid of the newest LIVE registered CLI session — the session the
 * shim is actually reading its account choice under. The account picker's tab
 * uuid lives in a different namespace than the shim's key, so a UI pick can't
 * bind directly; the daemon binds it here instead, by construction: it keeps
 * only sessions whose registered pid is alive and returns the most recent,
 * ranked by the app's per-session `~/.claude/session-env/<uuid>` mtime (that
 * `<uuid>` IS the shim's key), falling back to the pid file's own mtime when
 * the session-env dir is absent.
 *
 * Concurrency caveat: with two live sessions the picker can't say WHICH tab it
 * came from, so "newest" is the best available guess; the direct
 * `POST /choice/:sessionUuid` path stays for callers that already know the id.
 *
 * @param {(pid: number) => boolean} [alive] - Injectable liveness probe.
 * @param {(path: string) => Promise<number | undefined>} [statMtime] - Injectable stat.
 * @param {string} [sessionPidDir] - Parent dir of the pid files.
 * @param {string} [sessionEnvDir] - Parent dir of the per-session env dirs.
 * @param {(dir: string) => Promise<string[]>} [readdirFn] - Injectable dir list.
 * @returns {Promise<string | undefined>} Newest live session uuid, or `undefined`.
 */
export async function resolveActiveSessionUuid(
	alive: (pid: number) => boolean = isPidAlive,
	statMtime: (path: string) => Promise<number | undefined> = defaultStatMtime,
	sessionPidDir: string = defaultSessionDir(),
	sessionEnvDir: string = defaultSessionEnvDir(),
	readdirFn: (dir: string) => Promise<string[]> = defaultReaddir,
): Promise<string | undefined> {
	const entries = await readdirFn(sessionPidDir);
	const uuids = entries
		.filter((name) => name.endsWith(".pid"))
		.map((name) => name.slice(0, -".pid".length));

	// Resolve every candidate in parallel: keep the ones whose pid is alive,
	// tagged with a recency rank. Sequential awaits would serialise a dir full
	// of pid files for no reason — each probe is independent.
	const probed = await Promise.all(
		uuids.map(async (uuid) => {
			const pid = await readSessionPid(uuid, sessionPidDir);
			if (pid === undefined || !alive(pid)) {
				return;
			}
			const rank = await rankMtime(uuid, statMtime, sessionPidDir, sessionEnvDir);
			return { uuid, rank };
		}),
	);
	const live = probed.filter(
		(entry): entry is { uuid: string; rank: number } => entry !== undefined,
	);
	if (live.length === 0) {
		return undefined;
	}
	live.sort((a, b) => b.rank - a.rank);
	const [newest] = live;
	return newest?.uuid;
}
