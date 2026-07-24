/* oxlint-disable unicorn/prefer-event-target -- the fake child/stdio streams model Node's child_process, which IS EventEmitter-based; matches daemon-boot.test.ts */
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
import type { Account, AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { ChoiceStore, TokenStore } from "../ports.ts";
import { runShim, type ShimDeps } from "./shim.ts";

// A throwaway writable stream that records everything written to it.
function sink(): { stream: NodeJS.WritableStream; chunks: Buffer[] } {
	const chunks: Buffer[] = [];
	const stream = {
		write: (c: Buffer): boolean => {
			chunks.push(c);
			return true;
		},
	} as unknown as NodeJS.WritableStream;
	return { stream, chunks };
}

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;
const UUID_B = "22222222-2222-4222-8222-222222222222" as AccountUuid;
const UUID_MISSING = "99999999-9999-4999-8999-999999999999" as AccountUuid;

const registry: AccountRegistry = {
	accounts: [
		{
			uuid: UUID_A,
			label: "Personal",
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "handle-a",
		},
		{
			uuid: UUID_B,
			label: "Work",
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

describe("runShim — per-account CLAUDE_CONFIG_DIR (so the model reports the swapped account)", () => {
	const swapChoice: ChoiceStore = {
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

	it("sets CLAUDE_CONFIG_DIR from prepareConfigDir, resolving the full account (identity view keyed on that account)", async () => {
		const prepareConfigDir = vi.fn<(account: Account) => Promise<string | undefined>>((account) =>
			Promise.resolve(`/cfg/${account.uuid}`),
		);
		const { deps, calls } = makeDeps({
			choiceStore: swapChoice,
			tokenStore: { get: () => Promise.resolve("swapped-token"), put: async () => {} },
			prepareConfigDir,
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(true);
		// prepareConfigDir receives the ACCOUNT the choice resolved to — the identity
		// view (oauthAccount override + shared-store symlinks) is built from the whole
		// account, not just its uuid. Passing the wrong account is a cross-account
		// identity leak.
		expect(prepareConfigDir).toHaveBeenCalledWith(expect.objectContaining({ uuid: UUID_B }));
		expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBe(`/cfg/${UUID_B}`);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("swapped-token");
	});

	it("leaves CLAUDE_CONFIG_DIR unset when prepareConfigDir returns undefined (native reads the shared config)", async () => {
		// The native account's identity view is `undefined` — the swap still
		// happens (token, tier), but no CLAUDE_CONFIG_DIR so the child reads the
		// shared config directly rather than a forked per-account one.
		const prepareConfigDir = vi.fn<(account: Account) => Promise<string | undefined>>(() =>
			Promise.resolve(undefined),
		);
		const { deps, calls } = makeDeps({
			choiceStore: swapChoice,
			tokenStore: { get: () => Promise.resolve("swapped-token"), put: async () => {} },
			prepareConfigDir,
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(true);
		expect(prepareConfigDir).toHaveBeenCalledWith(expect.objectContaining({ uuid: UUID_B }));
		expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("swapped-token");
	});

	it("still swaps the token when prepareConfigDir throws (token is load-bearing; identity dir is best-effort)", async () => {
		const { deps, calls, warn } = makeDeps({
			choiceStore: swapChoice,
			tokenStore: { get: () => Promise.resolve("swapped-token"), put: async () => {} },
			prepareConfigDir: () => Promise.reject(new Error("mkdir EACCES")),
		});
		const result = await runShim(deps);
		expect(result.swapped).toBe(true);
		expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("swapped-token");
		expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("prepareConfigDir failed"));
	});

	it("leaves CLAUDE_CONFIG_DIR unset on the pass-through path (no config dir without a swap)", async () => {
		const prepareConfigDir = vi.fn<(account: Account) => Promise<string | undefined>>((account) =>
			Promise.resolve(`/cfg/${account.uuid}`),
		);
		// No choice for the session → pass-through; prepareConfigDir must not run.
		const { deps, calls } = makeDeps({ prepareConfigDir });
		const result = await runShim(deps);
		expect(result.swapped).toBe(false);
		expect(prepareConfigDir).not.toHaveBeenCalled();
		expect(calls[0]?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
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
	// Minimal writable stdin the stdio-proxy writes to. `.on("error")` is
	// exercised by attachChildStdio; write/end are spied for assertions.
	stdin = Object.assign(new EventEmitter(), {
		writable: true,
		write: vi.fn<(chunk: unknown) => boolean>(() => true),
		end: vi.fn<() => void>(() => {}),
	});
	// Readable stdout/stderr the proxy relays into the launcher's streams.
	stdout = new EventEmitter();
	stderr = new EventEmitter();
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

// The fresh interactive session the launcher spawns id-less: it carries the
// --replay-user-messages marker but no --session-id/--resume, so the shim must
// mint an id, register a pid file under it, and adopt it via --session-id.
const MINTED = "abababab-abab-4bab-8bab-abababababab";
const FRESH_INTERACTIVE_ARGV = [
	"node",
	"/path/claude",
	"--output-format",
	"stream-json",
	"--input-format",
	"stream-json",
	"--model",
	"claude-opus-4-8",
	"--replay-user-messages",
];
const PROBE_ARGV = [
	"node",
	"/path/claude",
	"--output-format",
	"stream-json",
	"--input-format",
	"stream-json",
	"--strict-mcp-config",
	"--permission-mode",
	"default",
];
const CHOICE_FOR_MINTED: ChoiceStore = {
	read: () =>
		Promise.resolve({
			[MINTED]: {
				sessionUuid: MINTED,
				accountUuid: UUID_B,
				chosenAt: "2026-07-19T00:00:00.000Z",
			},
		}),
	write: async () => {},
};

describe("runShim — fresh interactive session mints its own id (THE fresh-session fix)", () => {
	it("registers a pid file under the minted uuid and adopts it via --session-id, even with NO choice yet", async () => {
		// This is the break the whole item fixes: a brand-new app session arrives
		// id-less, so pre-fix it never registered and was unreachable by the picker.
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const writePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			writePidFile,
			newSessionUuid: () => MINTED,
			// No choice for the session → env is pass-through, but the session is
			// STILL registered + adopted so a later pick can reach it.
			choiceStore: { read: () => Promise.resolve({}), write: async () => {} },
		});
		const p = runShim(deps);
		await tick();
		expect(writePidFile).toHaveBeenCalledWith(MINTED);
		const [file, args] = spawn.mock.calls[0] as [string, string[], unknown];
		expect(file).toBe("/opt/claude/MacOS/claude.real");
		expect(args).toStrictEqual([...FRESH_INTERACTIVE_ARGV.slice(2), "--session-id", MINTED]);
		child.finish(0);
		const result = await p;
		expect(result).toStrictEqual({ exitCode: 0, swapped: false });
	});

	it("on SIGHUP respawns with --resume=<minted> (transcript continuity) and the swapped token", async () => {
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			onSighup,
			newSessionUuid: () => MINTED,
			choiceStore: CHOICE_FOR_MINTED,
			tokenStore: TOKEN_B,
		});
		const p = runShim(deps);
		await tick();
		// First spawn CREATES the session under our id.
		expect((spawn.mock.calls[0] as [string, string[], unknown])[1]).toStrictEqual([
			...FRESH_INTERACTIVE_ARGV.slice(2),
			"--session-id",
			MINTED,
		]);
		fire();
		child1.finish(null, "SIGTERM");
		await tick();
		// Respawn RESUMES the same id — same transcript, no fork — with the swap.
		const [, respawnArgs, respawnOpts] = spawn.mock.calls[1] as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		expect(respawnArgs).toStrictEqual([...FRESH_INTERACTIVE_ARGV.slice(2), "--resume", MINTED]);
		expect(respawnOpts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("swapped-token");
		child2.finish(0);
		const result = await p;
		expect(result.exitCode).toBe(0);
	});

	it("does NOT mint for a probe/preamble spawn (would pollute active-session resolution)", async () => {
		const spawn = spawnFromQueue([]);
		const writePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const { deps, calls } = hotSwapDeps({
			argv: PROBE_ARGV,
			spawn,
			writePidFile,
			newSessionUuid: () => MINTED,
		});
		const result = await runShim(deps);
		// No uuid → not hot-swappable → classic single-shot, no pid registration,
		// argv forwarded untouched (no injected --session-id).
		expect(writePidFile).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toStrictEqual(PROBE_ARGV.slice(2));
		expect(result.swapped).toBe(false);
	});

	it("does not mint when newSessionUuid is absent (pre-fix behaviour preserved)", async () => {
		const spawn = spawnFromQueue([]);
		const writePidFile = vi.fn<(u: string) => Promise<void>>(() => Promise.resolve());
		const { deps, calls } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			writePidFile,
			// newSessionUuid deliberately omitted.
		});
		await runShim(deps);
		expect(writePidFile).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(calls[0]?.args).toStrictEqual(FRESH_INTERACTIVE_ARGV.slice(2));
	});
});

describe("runShim — stdio proxy delivers turns AND output to the respawned child (persistent-process gap)", () => {
	const manyTicks = async (n = 6): Promise<void> => {
		for (let i = 0; i < n; i += 1) {
			// eslint-disable-next-line no-await-in-loop -- draining the microtask queue deterministically
			await tick();
		}
	};
	it("gives each child its OWN pipes, forwards turn-1 to child1, re-targets turn-2 to child2, and relays child stdout", async () => {
		const child1 = new FakeChild();
		const child2 = new FakeChild();
		const spawn = spawnFromQueue([child1, child2]);
		const { onSighup, fire } = sighupCapture();
		const source = new EventEmitter();
		const out = sink();
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			onSighup,
			newSessionUuid: () => MINTED,
			choiceStore: CHOICE_FOR_MINTED,
			tokenStore: TOKEN_B,
			stdin: source as unknown as NodeJS.ReadableStream,
			stdout: out.stream,
			stderr: sink().stream,
		});
		const p = runShim(deps);
		await tick();
		// Each child gets its OWN pipe for all three std streams — that fresh
		// stdout pipe is what stops the first child's O_NONBLOCK from silencing
		// the respawned one.
		const firstCall = spawn.mock.calls[0] as [string, string[], { stdio: unknown }];
		expect(firstCall[2].stdio).toStrictEqual(["pipe", "pipe", "pipe"]);
		// Turn 1 forwarded to live child1; child1 stdout relayed to the launcher.
		source.emit("data", Buffer.from("turn1\n"));
		expect(child1.stdin.write).toHaveBeenCalledWith(Buffer.from("turn1\n"));
		child1.stdout.emit("data", Buffer.from("out1"));
		expect(out.chunks).toContainEqual(Buffer.from("out1"));

		// Swap: child1 dies. Data arriving in the respawn gap is buffered.
		fire();
		child1.finish(null, "SIGTERM");
		await tick();
		source.emit("data", Buffer.from("gap\n")); // no live child → buffered
		await manyTicks();
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(child2.stdin.write).toHaveBeenCalledWith(Buffer.from("gap\n"));
		// Live turn-2 goes to child2, and child2's stdout is relayed (the fix).
		source.emit("data", Buffer.from("turn2\n"));
		expect(child2.stdin.write).toHaveBeenCalledWith(Buffer.from("turn2\n"));
		expect(child1.stdin.write).not.toHaveBeenCalledWith(Buffer.from("turn2\n"));
		child2.stdout.emit("data", Buffer.from("out2"));
		expect(out.chunks).toContainEqual(Buffer.from("out2"));

		child2.finish(0);
		await p;
	});

	it("ends the child's stdin when the launcher stdin ends", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const source = new EventEmitter();
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			newSessionUuid: () => MINTED,
			stdin: source as unknown as NodeJS.ReadableStream,
			stdout: sink().stream,
			stderr: sink().stream,
		});
		const p = runShim(deps);
		await tick();
		source.emit("end");
		expect(child.stdin.end).toHaveBeenCalled();
		child.finish(0);
		await p;
	});

	it("relays child stderr into the launcher stderr", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const source = new EventEmitter();
		const err = sink();
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			newSessionUuid: () => MINTED,
			stdin: source as unknown as NodeJS.ReadableStream,
			stdout: sink().stream,
			stderr: err.stream,
		});
		const p = runShim(deps);
		await tick();
		child.stderr.emit("data", Buffer.from("boom"));
		expect(err.chunks).toContainEqual(Buffer.from("boom"));
		child.finish(0);
		await p;
	});

	it("keeps stdio:inherit when no stdin is injected (legacy behaviour untouched)", async () => {
		const child = new FakeChild();
		const spawn = spawnFromQueue([child]);
		const { deps } = hotSwapDeps({
			argv: FRESH_INTERACTIVE_ARGV,
			spawn,
			newSessionUuid: () => MINTED,
		});
		const p = runShim(deps);
		await tick();
		const firstCall = spawn.mock.calls[0] as [string, string[], { stdio: unknown }];
		expect(firstCall[2].stdio).toBe("inherit");
		child.finish(0);
		await p;
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
