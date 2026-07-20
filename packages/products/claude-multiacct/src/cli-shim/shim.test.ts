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

import { describe, expect, it, vi } from "vitest";
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

describe("moduleDir", () => {
	it("returns the directory of a file:// URL", async () => {
		const { moduleDir } = await import("./shim.ts");
		expect(moduleDir("file:///a/b/c.ts")).toBe("/a/b");
	});
});
