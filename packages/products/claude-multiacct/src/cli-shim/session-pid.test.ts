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

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	defaultSessionDir,
	isPidAlive,
	readSessionPid,
	removeSessionPid,
	sessionPidPath,
	signalSwap,
	writeSessionPid,
} from "./session-pid.ts";

// A pid that cannot correspond to a live process. process.kill(_, 0) throws
// ESRCH for it, which is exactly the "reaped / impossible" path isPidAlive and
// the default signal arrow must treat as dead rather than as a live target.
const DEAD_PID = 2_147_483_647;

const UUID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

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
