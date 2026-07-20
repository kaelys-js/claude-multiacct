/**
 * `@foundation/claude-multiacct` — atomic `AccountRegistry` writer.
 *
 * Complement to PR2's `readRegistry`. Every write goes through:
 *
 *   1. Schema validate BEFORE touching disk. `AccountRegistrySchema` enforces
 *      the exactly-one-primary, unique-uuid, unique-label invariants. A
 *      throw here means no tmp file is created, no snapshot is taken —
 *      the invariant violation is impossible to leave partially applied.
 *   2. Advisory lock via an existence-based lockfile
 *      (`<path>.lock`). Concurrent writers serialize; a stale lock (mtime
 *      older than the stale threshold) is stolen with a warning.
 *   3. Snapshot the current file (if any) into
 *      `<backupRoot>/<isoStamp>/registry.json`. Rule 12 reversibility —
 *      every mutation is undoable byte-for-byte.
 *   4. Write to a sibling tmp path (`<path>.tmp-<pid>`), then `fs.rename`
 *      atomic-swap. Crash between tmp-write and rename → the real file is
 *      untouched and the tmp can be swept.
 *
 * The `RegistryFsPort` narrows the fs surface to the ~six calls the writer
 * actually needs, so tests inject a deterministic fake. `nodeRegistryFsPort()`
 * binds the real `node:fs/promises`.
 *
 * @module
 */

import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { type AccountRegistry, AccountRegistrySchema } from "../domain/registry.ts";

/** Narrow fs surface the writer needs. Test-injectable. */
export type RegistryFsPort = {
	mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
	writeFile: (path: string, data: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	copyFile: (from: string, to: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
	readFile: (path: string) => Promise<string>;
	stat: (path: string) => Promise<{ mtimeMs: number }>;
	exists: (path: string) => Promise<boolean>;
};

/**
 * `RegistryFsPort` bound to real `node:fs/promises`.
 *
 * @returns {RegistryFsPort} A port whose methods call directly into `node:fs/promises`.
 */
export function nodeRegistryFsPort(): RegistryFsPort {
	return {
		mkdir: async (path, opts) => {
			await mkdir(path, opts);
		},
		writeFile: async (path, data) => {
			await writeFile(path, data, "utf8");
		},
		rename: async (from, to) => {
			await rename(from, to);
		},
		copyFile: async (from, to) => {
			await copyFile(from, to);
		},
		unlink: async (path) => {
			await unlink(path);
		},
		readFile: (path) => readFile(path, "utf8"),
		stat: async (path) => {
			const s = await stat(path);
			return { mtimeMs: s.mtimeMs };
		},
		exists: async (path) => {
			try {
				await stat(path);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** Writer construction options. */
export type WriterOptions = {
	/** Absolute path to the registry file. */
	path: string;
	/** Injected fs surface. */
	fs: RegistryFsPort;
	/** Snapshot root. Defaults to `~/.claude-multiacct-backups`. */
	backupRoot?: string;
	/** Lockfile acquisition config. Tunable so tests can stress serialization. */
	lock?: {
		maxAttempts?: number;
		retryDelayMs?: number;
		staleAfterMs?: number;
	};
	/** Clock injection so tests are deterministic. */
	now?: () => number;
	/** Delay injection so tests do not really wait. */
	sleep?: (ms: number) => Promise<void>;
	/** Optional warning sink. Defaults silent. */
	logger?: { warn: (message: string) => void };
};

const silentLogger: { warn: (message: string) => void } = {
	warn: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
};

/**
 * Default sleep helper — extracted so it is a named function coverage tracks.
 *
 * @param {number} ms - Milliseconds to wait before the returned promise resolves.
 * @returns {Promise<void>} A promise that resolves after `ms` ms.
 */
function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isoStamp(nowMs: number): string {
	return new Date(nowMs).toISOString().replaceAll(/[:.]/gu, "-");
}

/**
 * Atomic + advisory-locked registry writer. Instantiate once, call `write`
 * as often as needed.
 */
export class AtomicRegistryWriter {
	private readonly path: string;
	private readonly fs: RegistryFsPort;
	private readonly backupRoot: string;
	private readonly maxAttempts: number;
	private readonly retryDelayMs: number;
	private readonly staleAfterMs: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly logger: { warn: (message: string) => void };
	private tmpSeq = 0;

	constructor(opts: WriterOptions) {
		this.path = opts.path;
		this.fs = opts.fs;
		this.backupRoot = opts.backupRoot ?? join(homedir(), ".claude-multiacct-backups");
		this.maxAttempts = opts.lock?.maxAttempts ?? 30;
		this.retryDelayMs = opts.lock?.retryDelayMs ?? 50;
		this.staleAfterMs = opts.lock?.staleAfterMs ?? 30_000;
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? defaultSleep;
		this.logger = opts.logger ?? silentLogger;
	}

	/**
	 * Atomically write `registry` to disk. See class docstring for the
	 * validate → lock → snapshot → tmp+rename pipeline.
	 *
	 * @param {AccountRegistry} registry - Registry to write. Validated first.
	 * @returns {Promise<{backup: string | undefined}>} Snapshot dir path or undefined.
	 */
	async write(registry: AccountRegistry): Promise<{ backup: string | undefined }> {
		// Step 1 — validate BEFORE touching disk. A schema-invalid write must
		// never create a tmp file, take a snapshot, or touch the lock.
		v.parse(AccountRegistrySchema, registry);

		// Step 2 — acquire lock.
		await this.acquireLock();
		try {
			// Step 3 — snapshot if a real file exists.
			const backup = await this.snapshot();

			// Step 4 — tmp write + atomic rename. Include a per-instance
			// monotonic counter so two writes in the same millisecond do not
			// collide on the same tmp path.
			this.tmpSeq += 1;
			const tmp = `${this.path}.tmp-${String(process.pid)}-${String(this.now())}-${String(
				this.tmpSeq,
			)}`;
			await this.fs.mkdir(dirname(this.path), { recursive: true });
			const payload = `${JSON.stringify(registry, undefined, "\t")}\n`;
			await this.fs.writeFile(tmp, payload);
			await this.fs.rename(tmp, this.path);
			return { backup };
		} finally {
			await this.releaseLock();
		}
	}

	private lockPath(): string {
		return `${this.path}.lock`;
	}

	private async acquireLock(): Promise<void> {
		await this.tryAcquireLock(0, 0);
	}

	/**
	 * Recursive acquire — one attempt per call. Sequenced awaits are inherent
	 * to lock acquisition (each step depends on the previous), so recursion
	 * beats a `for`+`await` loop for the lint gate.
	 *
	 * @param {number} attempt - 0-based attempt counter, capped at `maxAttempts`.
	 * @param {number} jitterCounter - Running counter for deterministic jitter.
	 * @returns {Promise<void>} Resolves once the lock is held; throws if not.
	 */
	private async tryAcquireLock(attempt: number, jitterCounter: number): Promise<void> {
		const lock = this.lockPath();
		if (attempt >= this.maxAttempts) {
			throw new Error(
				`AtomicRegistryWriter: could not acquire lock at ${lock} after ${String(
					this.maxAttempts,
				)} attempts`,
			);
		}
		const held = await this.fs.exists(lock);
		if (!held) {
			await this.fs.mkdir(dirname(lock), { recursive: true });
			await this.fs.writeFile(lock, String(process.pid));
			return;
		}
		// Stale-lock takeover attempt.
		const staleTakeover = await this.checkStale(lock);
		if (staleTakeover === "retry_now") {
			return this.tryAcquireLock(attempt + 1, jitterCounter);
		}
		// Jittered backoff, then retry.
		const nextJitter = jitterCounter + 1;
		const jitter = (nextJitter * 7) % 13; // small deterministic jitter
		await this.sleep(this.retryDelayMs + jitter);
		return this.tryAcquireLock(attempt + 1, nextJitter);
	}

	/**
	 * Check the age of the lockfile. Steals it when older than the stale
	 * threshold and returns `retry_now`; returns `wait` otherwise.
	 *
	 * @param {string} lock - Absolute path to the lockfile.
	 * @returns {Promise<"retry_now" | "wait">} Whether to retry immediately.
	 */
	private async checkStale(lock: string): Promise<"retry_now" | "wait"> {
		try {
			const s = await this.fs.stat(lock);
			const age = this.now() - s.mtimeMs;
			if (age > this.staleAfterMs) {
				this.logger.warn(
					`AtomicRegistryWriter: stealing stale lock at ${lock} (age=${String(age)}ms)`,
				);
				await this.fs.unlink(lock);
				return "retry_now";
			}
			return "wait";
		} catch {
			// stat race: lock disappeared under us — retry from top.
			return "retry_now";
		}
	}

	private async releaseLock(): Promise<void> {
		try {
			await this.fs.unlink(this.lockPath());
		} catch {
			// swallow — a failed release surfaces on the next acquire as a stale
			// lock, and we should not mask the original write error (if any).
		}
	}

	private async snapshot(): Promise<string | undefined> {
		if (!(await this.fs.exists(this.path))) {
			return undefined;
		}
		const dir = join(this.backupRoot, isoStamp(this.now()));
		await this.fs.mkdir(dir, { recursive: true });
		const dest = join(dir, "registry.json");
		await this.fs.copyFile(this.path, dest);
		return dir;
	}
}
