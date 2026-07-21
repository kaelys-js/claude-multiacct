/**
 * Intent: `runShim` orchestrates the swap-or-passthrough decision. Six
 * scenarios exercise every branch, and one adversarial mutation proves the
 * fall-back safety net is real.
 *
 * The pass-through cases are the load-bearing ones: THIS PR must not
 * degrade primary-account behavior even when the shim's dependencies are
 * missing or broken. If any of these tests started passing "swap" when the
 * environment says fall back, the shim would silently misroute the user's
 * primary session.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { ChoiceStore, TokenStore } from "../ports.ts";
import { runShim, type ShimDeps } from "./shim.ts";

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;
const UUID_B = "22222222-2222-4222-8222-222222222222" as AccountUuid;
const UUID_MISSING = "99999999-9999-4999-8999-999999999999" as AccountUuid;

const registry: AccountRegistry = {
	accounts: [
		{
			uuid: UUID_A,
			label: "Personal",
			isPrimary: true,
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "handle-a",
		},
		{
			uuid: UUID_B,
			label: "Work",
			isPrimary: false,
			subscriptionType: "Max",
			rateLimitTier: "tier-3",
			encryptedTokenRef: "handle-b",
		},
	],
} as AccountRegistry;

const ORIGINAL_ENV: Record<string, string> = {
	PATH: "/usr/bin",
	CLAUDE_CODE_OAUTH_TOKEN: "primary-token",
	CLAUDE_CODE_SUBSCRIPTION_TYPE: "Pro",
	CLAUDE_CODE_RATE_LIMIT_TIER: "tier-2",
	HOME: "/Users/dev",
};

type SpawnCall = {
	file: string;
	args: readonly string[];
	env: Record<string, string> | undefined;
};

function makeDeps(overrides: Partial<ShimDeps> = {}): {
	deps: ShimDeps;
	calls: SpawnCall[];
	warn: ReturnType<typeof vi.fn>;
} {
	const calls: SpawnCall[] = [];
	const warn = vi.fn<(message: string) => void>();
	const spawnSync: ShimDeps["spawnSync"] = (file, args, opts) => {
		calls.push({ file, args, env: opts.env as Record<string, string> | undefined });
		return { status: 0 };
	};
	const choiceStore: ChoiceStore = {
		read: () => Promise.resolve({}),
		write: async () => {},
	};
	const tokenStore: TokenStore = {
		get: () => Promise.resolve("handle-b-token"),
		put: async () => {},
	};
	const deps: ShimDeps = {
		argv: ["node", "/path/claude", `--resume=${SESSION_A}`],
		env: ORIGINAL_ENV,
		binDir: "/opt/claude/MacOS",
		choiceStore,
		readRegistry: () => Promise.resolve(registry),
		tokenStore,
		spawnSync,
		warn,
		...overrides,
	};
	return { deps, calls, warn };
}

describe("runShim — the swap path (choice present, valid account, token available)", () => {
	it("execs claude.real with a SWAPPED env and forwards the exit code", async () => {
		const { deps, calls } = makeDeps({
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_B,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
			tokenStore: {
				get: () => Promise.resolve("swapped-token"),
				put: async () => {},
			},
			spawnSync: (file, args, opts) => {
				expect(file).toBe("/opt/claude/MacOS/claude.real");
				expect(args).toStrictEqual([`--resume=${SESSION_A}`]);
				const env = opts.env as Record<string, string>;
				expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("swapped-token");
				expect(env.CLAUDE_CODE_SUBSCRIPTION_TYPE).toBe("Max");
				expect(env.CLAUDE_CODE_RATE_LIMIT_TIER).toBe("tier-3");
				expect(env.PATH).toBe("/usr/bin"); // preserved
				return { status: 42 };
			},
		});
		const result = await runShim(deps);
		expect(result).toStrictEqual({ exitCode: 42, swapped: true });
		expect(calls).toStrictEqual([]); // spawnSync inline check ran instead
	});
});

describe("runShim — the pass-through paths (load-bearing: primary must never be worse)", () => {
	it("no choice for the session → exec with ORIGINAL env (adversarial: this is the negative case the whole design hangs on)", async () => {
		const { deps, calls, warn } = makeDeps();
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).not.toHaveBeenCalled();
	});

	it("no --resume in argv → pass-through (nothing to look up)", async () => {
		const { deps, calls } = makeDeps({
			argv: ["node", "/path/claude", "--print", "hi"],
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
	});

	it("registry missing (readRegistry returns undefined) → pass-through", async () => {
		const { deps, calls, warn } = makeDeps({
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_B,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
			readRegistry: () => Promise.resolve() as Promise<AccountRegistry | undefined>,
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).not.toHaveBeenCalled();
	});

	it("stale choice (accountUuid not in registry) → pass-through + warn", async () => {
		const { deps, calls, warn } = makeDeps({
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_MISSING,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unknown account/u));
	});

	it("choice-store read throws (corrupted) → pass-through + warn (adversarial: if runShim ever removes the try/catch this MUST go red)", async () => {
		const { deps, calls, warn } = makeDeps({
			choiceStore: {
				read: () => Promise.reject(new Error("boom-corrupted")),
				write: async () => {},
			},
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/boom-corrupted/u));
	});

	it("token store throws (keychain missing) → pass-through + warn (never crash)", async () => {
		const { deps, calls, warn } = makeDeps({
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_B,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
			tokenStore: {
				get: () => Promise.reject(new Error("no-keychain")),
				put: async () => {},
			},
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no-keychain/u));
	});

	it("token store soft-miss (returns undefined) → pass-through + warn", async () => {
		const softStore: TokenStore = {
			get: () => Promise.resolve() as Promise<string | undefined>,
			put: async () => {},
		};
		const { deps, calls, warn } = makeDeps({
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_B,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
			tokenStore: softStore,
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("primary-token");
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/returned undefined/u));
	});

	it("spawn fails (real binary missing) → 127 + warn, still pass-through-shaped", async () => {
		const { deps, warn } = makeDeps({
			spawnSync: () => ({ status: null, error: new Error("ENOENT: no real bin") }),
		});
		const result = await runShim(deps);
		expect(result.exitCode).toBe(127);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exec of/u));
	});

	it("null exit status coerces to 0 (never propagates NaN)", async () => {
		const { deps } = makeDeps({ spawnSync: () => ({ status: null }) });
		const result = await runShim(deps);
		expect(result.exitCode).toBe(0);
	});
});

describe("runShim — describe() error-string helper (guards non-Error rejections)", () => {
	it("non-Error rejection is stringified into the warn message", async () => {
		const { deps, warn } = makeDeps({
			choiceStore: {
				// oxlint-disable-next-line prefer-promise-reject-errors
				read: () => Promise.reject({ odd: "shape" }),
				write: async () => {},
			},
		});
		await runShim(deps);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/odd/u));
	});

	it("unstringifiable rejection (circular) still passes through without crashing", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const { deps, warn } = makeDeps({
			choiceStore: {
				// oxlint-disable-next-line prefer-promise-reject-errors
				read: () => Promise.reject(circular),
				write: async () => {},
			},
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(warn).toHaveBeenCalled();
	});
});

describe("runShim — logSpawn audit hook", () => {
	// Intent: every child spawn is auditable, and the audit sees the token
	// that actually reaches claude.real (not the primary token when the swap
	// wins, not a stale token when a hot-swap respawns). The runtime writes
	// this to shim-spawns.log; without the hook fired at every spawn point,
	// Item 13's "two entries with different token-sha256" proof is impossible.
	it("fires exactly once per invocation with a hash of the env token", async () => {
		const logSpawn = vi.fn<(uuid: string | undefined, hash: string) => void>();
		const { deps } = makeDeps({ logSpawn });
		await runShim(deps);
		expect(logSpawn).toHaveBeenCalledTimes(1);
		expect(logSpawn).toHaveBeenNthCalledWith(
			1,
			SESSION_A,
			expect.stringMatching(/^[0-9a-f]{16}$/u),
		);
	});

	it("swap path logs the SWAPPED token hash, not the primary", async () => {
		const logSpawn = vi.fn<(uuid: string | undefined, hash: string) => void>();
		const primaryLogSpawn = vi.fn<(uuid: string | undefined, hash: string) => void>();
		const swapDeps = makeDeps({
			logSpawn,
			choiceStore: {
				read: () =>
					Promise.resolve({
						[SESSION_A]: {
							sessionUuid: SESSION_A,
							accountUuid: UUID_B,
							chosenAt: "2026-07-19T00:00:00.000Z",
						},
					}),
				write: async () => {},
			},
			tokenStore: {
				get: () => Promise.resolve("swapped-token"),
				put: async () => {},
			},
		});
		const primaryDeps = makeDeps({ logSpawn: primaryLogSpawn });
		await runShim(swapDeps.deps);
		await runShim(primaryDeps.deps);
		const [swappedCall] = logSpawn.mock.calls;
		const [primaryCall] = primaryLogSpawn.mock.calls;
		expect(swappedCall).toBeDefined();
		expect(primaryCall).toBeDefined();
		const [, swappedHash] = swappedCall as [string | undefined, string];
		const [, primaryHash] = primaryCall as [string | undefined, string];
		expect(swappedHash).not.toBe(primaryHash);
	});

	it("logSpawn throwing does not fail the spawn (audit is best-effort)", async () => {
		const { deps } = makeDeps({
			logSpawn: () => {
				throw new Error("disk full");
			},
		});
		const result = await runShim(deps);
		expect(result.exitCode).toBe(0);
	});
});

type SpawnFn = NonNullable<ShimDeps["spawn"]>;
type SpawnReturn = ReturnType<SpawnFn>;

// A stand-in for child_process.ChildProcess exposing only what the shim's
// hot-swap path touches: exit/error events, kill(), and the exitCode/signalCode
// the SIGHUP handler inspects before deciding to kill. ChildProcess IS an
// EventEmitter, so the fake mirrors that API rather than EventTarget.
// eslint-disable-next-line unicorn/prefer-event-target -- mirrors node:child_process.ChildProcess, which is an EventEmitter
class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>(() => true);
	// Simulate the child exiting (a code, or a signal death).
	finish(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
	// Simulate a spawn-level error event.
	fail(error: Error): void {
		this.emit("error", error);
	}
}

const tick = (): Promise<void> =>
	new Promise<void>((resolve) => {
		setImmediate(resolve);
	});

// A typed `spawn` mock that hands out the queued fake children in order.
function spawnFromQueue(queue: FakeChild[]): Mock<SpawnFn> {
	return vi.fn<SpawnFn>(() => queue.shift() as unknown as SpawnReturn);
}

// Capture the SIGHUP handler the shim registers so a test can fire it.
function sighupCapture(): { onSighup: NonNullable<ShimDeps["onSighup"]>; fire: () => void } {
	let handler: (() => void) | undefined;
	const onSighup: NonNullable<ShimDeps["onSighup"]> = (h) => {
		handler = h;
		return () => {};
	};
	return { onSighup, fire: () => handler?.() };
}

const CHOICE_FOR_B: ChoiceStore = {
	read: () =>
		Promise.resolve({
			[SESSION_A]: {
				sessionUuid: SESSION_A,
				accountUuid: UUID_B,
				chosenAt: "2026-07-19T00:00:00.000Z",
			},
		}),
	write: async () => {},
};
const TOKEN_B: TokenStore = { get: () => Promise.resolve("swapped-token"), put: async () => {} };

// Hot-swap deps require spawn + onSighup + writePidFile + removePidFile.
function hotSwapDeps(overrides: Partial<ShimDeps> = {}): {
	deps: ShimDeps;
	calls: SpawnCall[];
	warn: ReturnType<typeof vi.fn>;
} {
	return makeDeps({
		onSighup: () => () => {},
		writePidFile: () => Promise.resolve(),
		removePidFile: () => Promise.resolve(),
		...overrides,
	});
}

describe("runShim — hot-swap async path", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes the pid, spawns via the async spawn, forwards the exit code, removes the pid", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const writePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const removePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const { deps, calls } = hotSwapDeps({ spawn, writePidFile, removePidFile });
		const p = runShim(deps);
		await tick();
		expect(writePidFile).toHaveBeenCalledWith(SESSION_A);
		expect(spawn).toHaveBeenCalledTimes(1);
		child.finish(7);
		const result = await p;
		expect(result.exitCode).toBe(7);
		expect(removePidFile).toHaveBeenCalledWith(SESSION_A);
		// The classic spawnSync path must NOT run on the hot-swap route.
		expect(calls).toStrictEqual([]);
	});

	it("SIGHUP SIGTERMs the running child and respawns with a freshly-computed env", async () => {
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const removePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const { deps } = hotSwapDeps({
			spawn,
			onSighup,
			removePidFile,
			choiceStore: CHOICE_FOR_B,
			tokenStore: TOKEN_B,
		});
		const p = runShim(deps);
		await tick();
		expect(spawn).toHaveBeenCalledTimes(1);
		// Daemon signalled a choice change mid-session.
		fire();
		expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
		// child1 dies from the SIGTERM; the loop recomputes + respawns.
		child1.finish(null, "SIGTERM");
		await tick();
		expect(spawn).toHaveBeenCalledTimes(2);
		child2.finish(0);
		const result = await p;
		expect(result.exitCode).toBe(0);
		expect(removePidFile).toHaveBeenCalledWith(SESSION_A);
	});

	it("SIGHUP escalates to SIGKILL when the child ignores SIGTERM for 3s", async () => {
		vi.useFakeTimers();
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const { deps } = hotSwapDeps({
			spawn,
			onSighup,
			choiceStore: CHOICE_FOR_B,
			tokenStore: TOKEN_B,
		});
		const p = runShim(deps);
		await vi.advanceTimersByTimeAsync(0);
		expect(spawn).toHaveBeenCalledTimes(1);
		fire();
		expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
		// Child is still alive (exitCode/signalCode null) → 3s grace elapses → SIGKILL.
		await vi.advanceTimersByTimeAsync(3000);
		expect(child1.kill).toHaveBeenCalledWith("SIGKILL");
		child1.finish(null, "SIGKILL");
		await vi.advanceTimersByTimeAsync(0);
		child2.finish(0);
		const result = await p;
		expect(result.exitCode).toBe(0);
	});

	it("writePidFile failure disables hot-swap: warns and falls back to spawnSync single-shot", async () => {
		const spawn = spawnFromQueue([]);
		const { deps, calls, warn } = hotSwapDeps({
			spawn,
			writePidFile: () => Promise.reject(new Error("pid boom")),
		});
		const result = await runShim(deps);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/writePidFile failed/u));
		expect(spawn).not.toHaveBeenCalled();
		// Single-shot spawnSync fallback ran instead.
		expect(calls).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});

	it("writePidFile failure + spawnSync error → 127", async () => {
		const spawn = spawnFromQueue([]);
		const { deps } = hotSwapDeps({
			spawn,
			writePidFile: () => Promise.reject(new Error("pid boom")),
			spawnSync: () => ({ status: null, error: new Error("ENOENT: no real bin") }),
		});
		const result = await runShim(deps);
		expect(result.exitCode).toBe(127);
	});

	it("a failed swap recompute on SIGHUP passes through with the original env", async () => {
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		// First read (initial env) resolves; the SIGHUP recompute rejects.
		const read = vi
			.fn<ChoiceStore["read"]>()
			.mockResolvedValueOnce({
				[SESSION_A]: {
					sessionUuid: SESSION_A,
					accountUuid: UUID_B,
					chosenAt: "2026-07-19T00:00:00.000Z",
				},
			})
			.mockRejectedValueOnce(new Error("recompute boom"));
		const choiceStore: ChoiceStore = { read, write: async () => {} };
		const { deps, warn } = hotSwapDeps({ spawn, onSighup, choiceStore, tokenStore: TOKEN_B });
		const p = runShim(deps);
		await tick();
		fire();
		child1.finish(null, "SIGTERM");
		await tick();
		child2.finish(0);
		const result = await p;
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recompute failed/u));
		// Recompute failed → the respawn used the original (pass-through) env.
		expect(result.swapped).toBe(false);
	});

	it("a child that dies from a signal yields 128 + signal number", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const { deps } = hotSwapDeps({ spawn });
		const p = runShim(deps);
		await tick();
		child.finish(null, "SIGKILL"); // 128 + 9
		const result = await p;
		expect(result.exitCode).toBe(137);
	});

	it("a child 'error' event yields 127 and warns", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const { deps, warn } = hotSwapDeps({ spawn });
		const p = runShim(deps);
		await tick();
		child.fail(new Error("spawn ENOENT"));
		const result = await p;
		expect(result.exitCode).toBe(127);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/exec of/u));
	});

	it("a child that exits with neither code nor signal yields 0", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const { deps } = hotSwapDeps({ spawn });
		const p = runShim(deps);
		await tick();
		child.finish(null, null);
		const result = await p;
		expect(result.exitCode).toBe(0);
	});

	it("an unmapped signal contributes 0 to the 128+signal exit code", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const { deps } = hotSwapDeps({ spawn });
		const p = runShim(deps);
		await tick();
		child.finish(null, "SIGUSR1"); // not in the POSIX table → 128 + 0
		const result = await p;
		expect(result.exitCode).toBe(128);
	});

	it("writePidFile failure fallback coerces a null spawnSync status to 0", async () => {
		const spawn = spawnFromQueue([]);
		const { deps } = hotSwapDeps({
			spawn,
			writePidFile: () => Promise.reject(new Error("pid boom")),
			spawnSync: () => ({ status: null }),
		});
		const result = await runShim(deps);
		expect(result.exitCode).toBe(0);
	});

	it("a SIGHUP that arrives after the child already exited does not try to kill it", async () => {
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const { deps } = hotSwapDeps({
			spawn,
			onSighup,
			choiceStore: CHOICE_FOR_B,
			tokenStore: TOKEN_B,
		});
		const p = runShim(deps);
		await tick();
		// Simulate the child having exited already, then fire SIGHUP.
		child1.exitCode = 0;
		fire();
		expect(child1.kill).not.toHaveBeenCalled();
		// The exit event still drives the loop; swapPending → respawn → exit.
		child1.finish(0);
		await tick();
		child2.finish(0);
		const result = await p;
		expect(result.exitCode).toBe(0);
	});

	it("the SIGKILL grace timer does not fire when the child exits within 3s", async () => {
		vi.useFakeTimers();
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const { deps } = hotSwapDeps({
			spawn,
			onSighup,
			choiceStore: CHOICE_FOR_B,
			tokenStore: TOKEN_B,
		});
		const p = runShim(deps);
		await vi.advanceTimersByTimeAsync(0);
		fire();
		expect(child1.kill).toHaveBeenCalledWith("SIGTERM");
		child1.kill.mockClear();
		// Child obeys SIGTERM and exits well before the 3s grace elapses.
		child1.finish(null, "SIGTERM");
		await vi.advanceTimersByTimeAsync(3000);
		// The grace-timer callback saw the child already gone → no SIGKILL.
		expect(child1.kill).not.toHaveBeenCalledWith("SIGKILL");
		child2.finish(0);
		const result = await p;
		expect(result.exitCode).toBe(0);
	});
});

describe("runShim — fireLogSpawn with an empty (pass-through) token", () => {
	it("hashes an empty string when the child env carries no OAuth token", async () => {
		const logSpawn = vi.fn<(uuid: string | undefined, hash: string) => void>();
		// Pass-through invocation (no --resume) with an env that has no token.
		const { deps } = makeDeps({
			argv: ["node", "/path/claude", "--print", "hi"],
			env: { PATH: "/usr/bin", HOME: "/Users/dev" },
			logSpawn,
		});
		await runShim(deps);
		// sha256("") = e3b0c442... → first 16 hex chars.
		expect(logSpawn).toHaveBeenCalledWith(undefined, "e3b0c44298fc1c14");
	});
});

describe("moduleDir", () => {
	it("returns the directory of a file:// URL", async () => {
		const { moduleDir } = await import("./shim.ts");
		expect(moduleDir("file:///a/b/c.ts")).toBe("/a/b");
	});
});
