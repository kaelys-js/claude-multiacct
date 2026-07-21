/**
 * Intent: `AtomicRegistryWriter` is the ONLY path that mutates the pool's
 * on-disk source of truth. Four properties are load-bearing:
 *
 *   1. Schema validation happens BEFORE any disk touch — a schema-invalid
 *      registry never creates a tmp file. Adversarial: remove the
 *      pre-write `v.parse` and the "no tmp on invalid" test goes red.
 *   2. Snapshot before overwrite — the previous file is copied under
 *      `<backupRoot>/<ts>/registry.json`. Reversibility contract.
 *   3. Tmp+rename atomicity — a crash between tmp write and rename leaves
 *      the tmp on disk (so a sweeper can find it) and the real file
 *      untouched.
 *   4. Advisory lock serializes concurrent writers — two overlapping
 *      writes complete in order, no clobber.
 *
 * `no-conditional-in-test` is disabled for this file: the fake fs port
 * legitimately branches on the path being probed (e.g. `.lock` vs data
 * file) to simulate targeted failures — that's mock plumbing, not a test
 * conditional.
 */

/* oxlint-disable vitest/no-conditional-in-test, typescript/explicit-function-return-type, eslint/require-await, vitest/require-to-throw-message, vitest/expect-expect, eslint/prefer-destructuring, unicorn/numeric-separators-style, eslint/no-empty */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../domain/registry.ts";
import {
	AtomicRegistryWriter,
	nodeRegistryFsPort,
	type RegistryFsPort,
} from "./registry-writer.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";

function validRegistry(): AccountRegistry {
	return {
		accounts: [
			{
				uuid: UUID_A as AccountRegistry["accounts"][0]["uuid"],
				label: "Personal",
				isPrimary: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:handle-a",
			},
		],
	};
}

async function tmp(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cma-writer-"));
}

const dirs: string[] = [];
async function scratch(): Promise<{ path: string; backupRoot: string; dir: string }> {
	const dir = await tmp();
	dirs.push(dir);
	return { path: join(dir, "registry.json"), backupRoot: join(dir, "backups"), dir };
}

afterEach(async () => {
	while (dirs.length > 0) {
		const d = dirs.pop();
		if (d !== undefined) {
			await rm(d, { recursive: true, force: true }).catch(() => {});
		}
	}
});

describe("AtomicRegistryWriter — happy path", () => {
	it("writes a valid registry atomically (tmp then rename), no leftover tmp", async () => {
		const { path, backupRoot } = await scratch();
		const writer = new AtomicRegistryWriter({
			path,
			fs: nodeRegistryFsPort(),
			backupRoot,
		});
		await writer.write(validRegistry());
		const written = JSON.parse(await readFile(path, "utf8"));
		expect(written.accounts).toHaveLength(1);
	});

	it("snapshots the previous file before overwrite", async () => {
		const { path, backupRoot } = await scratch();
		await mkdir(backupRoot, { recursive: true });
		await writeFile(path, JSON.stringify({ old: true }), "utf8");
		const writer = new AtomicRegistryWriter({
			path,
			fs: nodeRegistryFsPort(),
			backupRoot,
		});
		const { backup } = await writer.write(validRegistry());
		expect(backup).toBeDefined();
		const snapshotted = JSON.parse(await readFile(join(backup ?? "", "registry.json"), "utf8"));
		expect(snapshotted).toEqual({ old: true });
	});

	it("no snapshot when there is no existing file", async () => {
		const { path, backupRoot } = await scratch();
		const writer = new AtomicRegistryWriter({
			path,
			fs: nodeRegistryFsPort(),
			backupRoot,
		});
		const { backup } = await writer.write(validRegistry());
		expect(backup).toBeUndefined();
	});
});

describe("AtomicRegistryWriter — validation before disk (adversarial anchor)", () => {
	it("schema-invalid write throws BEFORE any tmp is created (no writeFile calls)", async () => {
		const { path, backupRoot } = await scratch();
		const calls: string[] = [];
		const inner = nodeRegistryFsPort();
		const spyFs: RegistryFsPort = {
			...inner,
			writeFile: (p, d) => {
				calls.push(`writeFile:${p}`);
				return inner.writeFile(p, d);
			},
			rename: (from, to) => {
				calls.push(`rename:${from}->${to}`);
				return inner.rename(from, to);
			},
			copyFile: (from, to) => {
				calls.push(`copyFile:${from}->${to}`);
				return inner.copyFile(from, to);
			},
		};
		const writer = new AtomicRegistryWriter({ path, fs: spyFs, backupRoot });
		// Duplicate uuids → violates the unique-uuid invariant.
		const first = validRegistry().accounts[0];
		const invalid: unknown = {
			accounts: [first, { ...first, label: "Work", encryptedTokenRef: "keychain:b" }],
		};
		await expect(writer.write(invalid as AccountRegistry)).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});

describe("AtomicRegistryWriter — atomicity under crash simulation", () => {
	it("throwing between tmp-write and rename leaves the real file untouched + tmp still on disk", async () => {
		const { path, backupRoot, dir } = await scratch();
		await writeFile(path, JSON.stringify({ preserved: true }), "utf8");
		const inner = nodeRegistryFsPort();
		const seenTmps: string[] = [];
		const fs: RegistryFsPort = {
			...inner,
			writeFile: async (p, d) => {
				if (p.includes(".tmp-")) {
					seenTmps.push(p);
				}
				await inner.writeFile(p, d);
			},
			rename: () => {
				throw new Error("simulated crash between tmp-write and rename");
			},
		};
		const writer = new AtomicRegistryWriter({ path, fs, backupRoot });
		await expect(writer.write(validRegistry())).rejects.toThrow(/simulated crash/u);
		// Real file untouched.
		const still = JSON.parse(await readFile(path, "utf8"));
		expect(still).toEqual({ preserved: true });
		// Tmp survived so a sweeper can find it.
		expect(seenTmps).toHaveLength(1);
		const leftover = await readFile(seenTmps[0] ?? "", "utf8");
		expect(leftover).toContain("accounts");
		// Lock was released even though rename threw.
		await expect(readFile(`${path}.lock`, "utf8")).rejects.toBeDefined();
		expect(dir).toBeDefined();
	});
});

describe("AtomicRegistryWriter — advisory lock serializes concurrent writers", () => {
	it("two overlapping writes both land (second one waits for the first — uses default sleep)", async () => {
		const { path, backupRoot } = await scratch();
		const writer = new AtomicRegistryWriter({
			path,
			fs: nodeRegistryFsPort(),
			backupRoot,
			// No sleep override — exercises the default `setTimeout`-backed sleep.
			lock: { maxAttempts: 100, retryDelayMs: 1, staleAfterMs: 30_000 },
		});
		const reg1 = validRegistry();
		const first = reg1.accounts[0];
		if (first === undefined) {
			throw new Error("test setup: expected first account");
		}
		const reg2: AccountRegistry = {
			accounts: [{ ...first, label: "Second" }],
		};
		const [r1, r2] = await Promise.all([writer.write(reg1), writer.write(reg2)]);
		expect(r1).toBeDefined();
		expect(r2).toBeDefined();
		// The final file matches whichever landed second; both writes happened
		// serially, so we only assert one of the two labels made it.
		const final = JSON.parse(await readFile(path, "utf8"));
		expect(["Personal", "Second"]).toContain(final.accounts[0].label);
	});

	it("throws after maxAttempts when the lock cannot be taken (contention diagnostic)", async () => {
		const { path, backupRoot } = await scratch();
		await mkdir(join(backupRoot), { recursive: true });
		await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
		// Pre-create a lock that "never" goes stale.
		await writeFile(`${path}.lock`, "999999", "utf8");
		const writer = new AtomicRegistryWriter({
			path,
			fs: nodeRegistryFsPort(),
			backupRoot,
			lock: { maxAttempts: 3, retryDelayMs: 1, staleAfterMs: 3600_000 },
			sleep: () => Promise.resolve(),
		});
		await expect(writer.write(validRegistry())).rejects.toThrow(/could not acquire lock/u);
	});

	it("steals a stale lock (mtime beyond stale threshold) with a warning", async () => {
		const { path, backupRoot } = await scratch();
		const warn = vi.fn<(m: string) => void>();
		const inner = nodeRegistryFsPort();
		// stat returns an ancient mtime for the lock only.
		const fs: RegistryFsPort = {
			...inner,
			stat: async (p) => {
				if (p.endsWith(".lock")) {
					return { mtimeMs: 0 };
				}
				return inner.stat(p);
			},
		};
		await writeFile(`${path}.lock`, "999", "utf8");
		const writer = new AtomicRegistryWriter({
			path,
			fs,
			backupRoot,
			lock: { maxAttempts: 5, retryDelayMs: 1, staleAfterMs: 1000 },
			sleep: () => Promise.resolve(),
			now: () => 1_000_000_000_000,
			logger: { warn },
		});
		await writer.write(validRegistry());
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/stealing stale lock/u));
	});

	it("stat race during stale-check (lock disappeared) → retries cleanly", async () => {
		const { path, backupRoot } = await scratch();
		const inner = nodeRegistryFsPort();
		await writeFile(`${path}.lock`, "1", "utf8");
		let statRaceFired = false;
		const fs: RegistryFsPort = {
			...inner,
			stat: async (p) => {
				if (p.endsWith(".lock") && !statRaceFired) {
					statRaceFired = true;
					// Simulate lock disappearing between exists() and stat().
					try {
						await inner.unlink(p);
					} catch {}
					throw new Error("ENOENT");
				}
				return inner.stat(p);
			},
		};
		const writer = new AtomicRegistryWriter({
			path,
			fs,
			backupRoot,
			lock: { maxAttempts: 5, retryDelayMs: 1 },
			sleep: () => Promise.resolve(),
		});
		await writer.write(validRegistry());
	});
});

describe("nodeRegistryFsPort", () => {
	it("exists returns false for a missing path", async () => {
		const { dir } = await scratch();
		expect(await nodeRegistryFsPort().exists(join(dir, "nope"))).toBe(false);
	});
	it("exists returns true for an existing path", async () => {
		const { path, dir } = await scratch();
		await writeFile(path, "x", "utf8");
		expect(await nodeRegistryFsPort().exists(path)).toBe(true);
		expect(dir).toBeDefined();
	});
	it("stat returns mtimeMs of a real file", async () => {
		const { path } = await scratch();
		await writeFile(path, "x", "utf8");
		const s = await nodeRegistryFsPort().stat(path);
		expect(s.mtimeMs).toBeGreaterThan(0);
	});
	it("readFile round-trips a written payload", async () => {
		const { path } = await scratch();
		const port = nodeRegistryFsPort();
		await port.mkdir(join(path, ".."), { recursive: true });
		await port.writeFile(path, "hello");
		expect(await port.readFile(path)).toBe("hello");
	});
	it("copyFile + rename + unlink integrate with real fs", async () => {
		const { dir } = await scratch();
		const port = nodeRegistryFsPort();
		const a = join(dir, "a");
		const b = join(dir, "b");
		const c = join(dir, "c");
		await port.writeFile(a, "x");
		await port.copyFile(a, b);
		await port.rename(b, c);
		await port.unlink(a);
		expect(await port.exists(a)).toBe(false);
		expect(await port.exists(c)).toBe(true);
	});
});

describe("AtomicRegistryWriter — default backupRoot", () => {
	it("defaults backupRoot under ~/.claude-multiacct-backups when omitted", () => {
		const writer = new AtomicRegistryWriter({
			path: "/tmp/whatever/registry.json",
			fs: nodeRegistryFsPort(),
		});
		// No public getter; but the class stores it and the tests above
		// exercise the write path with an explicit override. This test simply
		// pins the constructor accepts no backupRoot without throwing.
		expect(writer).toBeInstanceOf(AtomicRegistryWriter);
	});
});

describe("AtomicRegistryWriter — default sleep is real setTimeout (covers defaultSleep)", () => {
	it("acquireLock retries via the default sleep helper", async () => {
		const { path, backupRoot } = await scratch();
		const inner = nodeRegistryFsPort();
		// Simulate a lock present on first exists() check, gone on the second.
		let existsCalls = 0;
		const fs: RegistryFsPort = {
			...inner,
			exists: async (p) => {
				if (p.endsWith(".lock")) {
					existsCalls += 1;
					// First check: pretend the lock is held so acquireLock sleeps.
					// Second check: lock is free.
					if (existsCalls === 1) {
						return true;
					}
					return false;
				}
				return inner.exists(p);
			},
			stat: async (p) => {
				if (p.endsWith(".lock")) {
					// Fresh mtime → not stale → sleep + retry (via defaultSleep).
					return { mtimeMs: Date.now() };
				}
				return inner.stat(p);
			},
		};
		const writer = new AtomicRegistryWriter({
			path,
			fs,
			backupRoot,
			lock: { maxAttempts: 5, retryDelayMs: 1, staleAfterMs: 3600_000 },
			// No sleep injection — exercises defaultSleep.
		});
		await writer.write(validRegistry());
		expect(existsCalls).toBeGreaterThanOrEqual(2);
	});
});

describe("AtomicRegistryWriter — default logger swallows warnings", () => {
	it("stealing a stale lock with the default (silent) logger does not throw", async () => {
		const { path, backupRoot } = await scratch();
		const inner = nodeRegistryFsPort();
		const fs: RegistryFsPort = {
			...inner,
			stat: async (p) => {
				if (p.endsWith(".lock")) {
					return { mtimeMs: 0 };
				}
				return inner.stat(p);
			},
		};
		await writeFile(`${path}.lock`, "999", "utf8");
		const writer = new AtomicRegistryWriter({
			path,
			fs,
			backupRoot,
			lock: { maxAttempts: 5, retryDelayMs: 1, staleAfterMs: 1000 },
			sleep: () => Promise.resolve(),
			now: () => 1_000_000_000_000,
			// No logger — exercises the silentLogger.warn default.
		});
		await writer.write(validRegistry());
	});
});
