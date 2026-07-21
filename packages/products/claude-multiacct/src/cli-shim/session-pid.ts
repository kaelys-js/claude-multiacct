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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
