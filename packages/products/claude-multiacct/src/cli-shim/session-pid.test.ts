/* eslint-disable vitest/no-conditional-in-test, jsdoc/require-returns, jsdoc/require-param */
/**
 * Intent: PID files are the signalling channel for mid-session hot-swap.
 * write→read must round-trip; missing files return undefined; stale
 * PIDs are cleaned up on signalSwap; a live PID gets SIGHUP.
 *
 * Adversarial: remove the isPidAlive gate and stale PIDs get signalled
 * (targeting whatever process now holds that PID) — "stale PID cleaned
 * up, no signal sent" flips RED.
 */

import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	defaultSessionDir,
	defaultSessionEnvDir,
	isPidAlive,
	readSessionPid,
	removeSessionPid,
	resolveActiveSessionUuid,
	sessionPidPath,
	signalSwap,
	writeSessionPid,
} from "./session-pid.ts";

// A pid that cannot correspond to a live process. process.kill(_, 0) throws
// ESRCH for it, which is exactly the "reaped / impossible" path isPidAlive and
// the default signal arrow must treat as dead rather than as a live target.
const DEAD_PID = 2_147_483_647;

const UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

// Shared probes for the resolveActiveSessionUuid cases (module scope so they are
// not rebuilt per test — oxlint's consistent-function-scoping wants them here).
const aliveIsB = (pid: number): boolean => pid === 222;
const noMtime = (): Promise<number | undefined> => Promise.resolve(undefined);

async function mkDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cma-sess-"));
}

describe("session-pid file", () => {
	it("writeSessionPid creates a 0600 file with the PID + trailing newline", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 12_345, dir);
		const raw = await readFile(sessionPidPath(UUID, dir), "utf8");
		expect(raw).toBe("12345\n");
	});

	it("readSessionPid round-trips a fresh write", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 67_890, dir);
		expect(await readSessionPid(UUID, dir)).toBe(67_890);
	});

	it("readSessionPid returns undefined for missing file", async () => {
		const dir = await mkDir();
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});

	it("readSessionPid returns undefined for garbage content", async () => {
		const dir = await mkDir();
		await writeFile(sessionPidPath(UUID, dir), "not-a-number");
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});

	it("readSessionPid returns undefined for zero or negative pids", async () => {
		const dir = await mkDir();
		await writeFile(sessionPidPath(UUID, dir), "0");
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});

	it("removeSessionPid is idempotent on missing file", async () => {
		const dir = await mkDir();
		await expect(removeSessionPid(UUID, dir)).resolves.toBeUndefined();
	});

	it("removeSessionPid deletes when present", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 42, dir);
		await removeSessionPid(UUID, dir);
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});
});

describe("signalSwap", () => {
	it("returns no-owner when the PID file is missing", async () => {
		const dir = await mkDir();
		const signal = vi.fn<(pid: number, sig: "SIGHUP") => void>();
		expect(await signalSwap(UUID, () => true, signal, dir)).toBe("no-owner");
		expect(signal).not.toHaveBeenCalled();
	});

	it("sends SIGHUP when the PID is alive", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 111, dir);
		const signal = vi.fn<(pid: number, sig: "SIGHUP") => void>();
		expect(await signalSwap(UUID, () => true, signal, dir)).toBe("signalled");
		expect(signal).toHaveBeenCalledWith(111, "SIGHUP");
	});

	it("returns stale + cleans up the file when PID is dead", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 222, dir);
		const signal = vi.fn<(pid: number, sig: "SIGHUP") => void>();
		expect(await signalSwap(UUID, () => false, signal, dir)).toBe("stale");
		expect(signal).not.toHaveBeenCalled();
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});

	it("returns stale + cleans up when signal itself throws (race)", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID, 333, dir);
		const signal = vi.fn<(pid: number, sig: "SIGHUP") => void>(() => {
			throw new Error("ESRCH");
		});
		expect(await signalSwap(UUID, () => true, signal, dir)).toBe("stale");
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});

	it("uses the default liveness check (isPidAlive) when no override is given", async () => {
		// Exercises the default `alive` param bound to isPidAlive: our own pid is
		// live, so signalSwap proceeds to the (spied) signal step rather than
		// treating the owner as stale.
		const dir = await mkDir();
		await writeSessionPid(UUID, process.pid, dir);
		const signal = vi.fn<(pid: number, sig: "SIGHUP") => void>();
		expect(await signalSwap(UUID, undefined, signal, dir)).toBe("signalled");
		expect(signal).toHaveBeenCalledWith(process.pid, "SIGHUP");
	});

	it("uses the default signal (process.kill) when no override is given", async () => {
		// Force `alive` true but leave the default signal in place, pointed at a pid
		// that cannot exist. The real process.kill throws ESRCH, which the catch
		// turns into "stale" + cleanup — proving the default arrow actually calls
		// process.kill rather than a no-op.
		const dir = await mkDir();
		await writeSessionPid(UUID, DEAD_PID, dir);
		expect(await signalSwap(UUID, () => true, undefined, dir)).toBe("stale");
		expect(await readSessionPid(UUID, dir)).toBeUndefined();
	});
});

describe("isPidAlive", () => {
	it("returns true for the current process", () => {
		expect(isPidAlive(process.pid)).toBe(true);
	});

	it("returns false for a pid that cannot exist (kill throws → caught)", () => {
		expect(isPidAlive(DEAD_PID)).toBe(false);
	});
});

describe("defaultSessionDir", () => {
	it("resolves to ~/.claude-multiacct/sessions", () => {
		expect(defaultSessionDir()).toBe(join(homedir(), ".claude-multiacct", "sessions"));
	});
});

describe("defaultSessionEnvDir", () => {
	it("resolves to ~/.claude/session-env", () => {
		expect(defaultSessionEnvDir()).toBe(join(homedir(), ".claude", "session-env"));
	});
});

// The choice made in the UI must land on the uuid the shim actually reads. The
// resolver is that bridge: newest LIVE registered CLI session, ranked by the
// per-session `session-env/<uuid>` mtime (that uuid IS the shim's key).
//
// Adversarial: drop the alive gate and a dead session with the freshest
// session-env would win, binding the choice to a uuid no shim will ever read —
// the "dead pid is skipped even if its session-env is newest" test flips RED.
describe("resolveActiveSessionUuid", () => {
	const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
	const UUID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

	it("returns undefined when the sessions dir is absent (default readdir swallows ENOENT)", async () => {
		const missing = join(tmpdir(), `cma-sess-missing-${String(Date.now())}`);
		expect(await resolveActiveSessionUuid(undefined, undefined, missing)).toBeUndefined();
	});

	it("returns undefined for an empty sessions dir", async () => {
		const dir = await mkDir();
		expect(await resolveActiveSessionUuid(() => true, undefined, dir)).toBeUndefined();
	});

	it("picks the newest live session by session-env mtime, ignoring non-pid + garbage files", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID_A, 111, dir);
		await writeSessionPid(UUID_B, 222, dir);
		// A non-pid entry (filtered out) and a garbage .pid (readSessionPid →
		// undefined → skipped) must not derail ranking.
		await writeFile(join(dir, "notes.txt"), "ignore me");
		await writeFile(join(dir, "cccccccc-3333-4333-8333-cccccccccccc.pid"), "not-a-number");
		const envDir = "/synthetic/session-env";
		// A newer than B by session-env mtime.
		const statMtime = (path: string): Promise<number | undefined> =>
			Promise.resolve(path.includes(UUID_A) ? 2000 : 1000);
		expect(await resolveActiveSessionUuid(() => true, statMtime, dir, envDir)).toBe(UUID_A);
	});

	it("skips a dead pid even when its session-env is the newest", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID_A, 111, dir);
		await writeSessionPid(UUID_B, 222, dir);
		const envDir = "/synthetic/session-env";
		// A has the freshest session-env but its pid is dead → B must win.
		const statMtime = (path: string): Promise<number | undefined> =>
			Promise.resolve(path.includes(UUID_A) ? 9999 : 1);
		expect(await resolveActiveSessionUuid(aliveIsB, statMtime, dir, envDir)).toBe(UUID_B);
	});

	it("falls back to the pid-file mtime when the session-env dir is absent (real fs, default probes)", async () => {
		const dir = await mkDir();
		// Live pids (our own) so the default alive-check passes.
		await writeSessionPid(UUID_A, process.pid, dir);
		await writeSessionPid(UUID_B, process.pid, dir);
		// B's pid file is newer than A's.
		await utimes(sessionPidPath(UUID_A, dir), new Date(1_000_000), new Date(1_000_000));
		await utimes(sessionPidPath(UUID_B, dir), new Date(2_000_000), new Date(2_000_000));
		const absentEnvDir = join(dir, "no-session-env-here");
		// Defaults for alive/statMtime/readdir exercise the real fs probes.
		expect(await resolveActiveSessionUuid(undefined, undefined, dir, absentEnvDir)).toBe(UUID_B);
	});

	it("still returns the sole live session when no mtime is available (rank 0)", async () => {
		const dir = await mkDir();
		await writeSessionPid(UUID_A, 111, dir);
		expect(await resolveActiveSessionUuid(() => true, noMtime, dir, "/synthetic")).toBe(UUID_A);
	});
});
