/* oxlint-disable jsdoc/require-param, jsdoc/require-returns, vitest/require-mock-type-parameters */
/**
 * Intent: `resolveActiveAccount` is the gui-session brain of the fix — it turns
 * "which token is Claude.app logged in as?" into a POOLED ACCOUNT UUID, doing
 * BOTH keychain-dependent halves (the active-marker read and the per-account
 * token hashing) that the `SessionCreate=true` daemon cannot. Three outcomes
 * are load-bearing:
 *
 *   1. No live sha (Safe Storage unreadable) → both fields null, AND the
 *      per-account token reads are skipped entirely (those reads would each hit
 *      the keychain; running them when there's nothing to match against is
 *      wasted work and, on a real box, extra prompt surface).
 *   2. Live sha that a pooled account holds → that account's uuid.
 *   3. Live sha that NO pooled account holds → uuid null, sha retained. The
 *      companion never emits a fallback guess; the daemon owns the fallback.
 *
 * Uses real Safe-Storage-shaped encryption + a real token-store fake (not
 * mock-the-world), so the sha match is exercised end to end exactly as it runs
 * on a user's machine.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_TOKEN_KEY, type ActiveTokenPorts, sha256Hex } from "../discovery/active-token.ts";
import {
	CHROMIUM_IV,
	CHROMIUM_V10_PREFIX,
	deriveChromiumKey,
} from "../discovery/chromium-crypto.ts";
import type { Account, AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
import type { TokenRecord, TokenStore } from "../ports.ts";
import { poolActiveToken, resolveActiveAccount } from "./resolve.ts";

const PASSWORD = "test-safe-storage-key";
const KEY = deriveChromiumKey(PASSWORD);
const CONFIG_PATH = "/fake/Claude/config.json";

/** Encrypt a payload the way Claude.app's Safe Storage does (v10 + AES-128-CBC). */
function v10(plaintext: string): Buffer {
	const cipher = createCipheriv("aes-128-cbc", KEY, CHROMIUM_IV);
	cipher.setAutoPadding(true);
	const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	return Buffer.concat([CHROMIUM_V10_PREFIX, ct]);
}

/** A v10 blob carrying a single OAuth access token (sole-V2 → unambiguously active). */
function tokenBlob(token: string): Buffer {
	return v10(JSON.stringify({ access_token: token }));
}

function makePorts(
	entries: ReadonlyArray<[string, Buffer]>,
	overrides: Partial<ActiveTokenPorts> = {},
): ActiveTokenPorts {
	return {
		readKeychainPassword: () => Promise.resolve(PASSWORD),
		configJsonPath: CONFIG_PATH,
		iterateAppConfigJson: async function* () {
			for (const [k, value] of entries) {
				yield { key: Buffer.from(k, "utf8"), value };
			}
		},
		...overrides,
	};
}

const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;
const UUID_B = "22222222-2222-4222-8222-222222222222" as AccountUuid;

function acct(uuid: AccountUuid, label: string): Account {
	return {
		uuid,
		label,
		subscriptionType: "Pro",
		rateLimitTier: "tier-2",
		encryptedTokenRef: `keychain:${label}`,
	} as Account;
}

const registry: AccountRegistry = { accounts: [acct(UUID_A, "A"), acct(UUID_B, "B")] };

function mkTokenStore(entries: Record<string, string | undefined>): Pick<TokenStore, "get"> {
	return { get: (uuid: AccountUuid) => Promise.resolve(entries[uuid]) };
}

/**
 * A read store whose `get` RESOLVES for uuids present in `entries` and REJECTS
 * for everything else — models the keychain/file store contract where a miss
 * throws rather than returning undefined. Lives at module scope so the throw
 * decision stays out of the test body (vitest/no-conditional-in-test).
 */
function mkThrowingReadStore(entries: Record<string, string>): Pick<TokenStore, "get"> {
	return {
		get: (uuid: AccountUuid) => {
			const token = entries[uuid];
			return token === undefined
				? Promise.reject(new Error(`no entry for ${uuid}`))
				: Promise.resolve(token);
		},
	};
}

/**
 * A read store that returns `token` for `uuid` on the FIRST get and rejects on
 * every later get (any other uuid resolves to undefined). Models a token that
 * is readable during the sha match but vanishes before the mirror re-read.
 * Module scope so the branching stays out of the test body.
 */
function mkReadableOnceStore(uuid: AccountUuid, token: string): Pick<TokenStore, "get"> {
	let served = false;
	const first = new Map<string, string>([[uuid, token]]);
	return {
		get: (requested: AccountUuid) => {
			const value = first.get(requested);
			if (value === undefined) {
				return Promise.resolve(undefined);
			}
			if (served) {
				return Promise.reject(new Error("token vanished between resolve and mirror"));
			}
			served = true;
			return Promise.resolve(value);
		},
	};
}

describe("resolveActiveAccount", () => {
	it("no live sha (Safe Storage key absent) → nulls, and pool tokens are NOT read", async () => {
		const getSpy = vi.fn((uuid: AccountUuid) => Promise.resolve(`token-${uuid}`));
		const result = await resolveActiveAccount({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]], {
				readKeychainPassword: () => Promise.resolve(undefined),
			}),
			tokenStore: { get: getSpy },
		});
		expect(result).toStrictEqual({ activeUuid: null, activeTokenSha: null });
		expect(getSpy).not.toHaveBeenCalled();
	});

	it("live sha that a pooled account holds → that account's uuid + the sha", async () => {
		const result = await resolveActiveAccount({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			tokenStore: mkTokenStore({ [UUID_A]: "token-A", [UUID_B]: "token-B" }),
		});
		expect(result).toStrictEqual({
			activeUuid: UUID_A,
			activeTokenSha: sha256Hex("token-A"),
		});
	});

	it("live sha that no pooled account holds → uuid null, sha retained (daemon owns the fallback)", async () => {
		const result = await resolveActiveAccount({
			registry,
			// Config's active token is token-A, but neither stored token matches it.
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			tokenStore: mkTokenStore({ [UUID_A]: "other-1", [UUID_B]: "other-2" }),
		});
		expect(result).toStrictEqual({
			activeUuid: null,
			activeTokenSha: sha256Hex("token-A"),
		});
	});
});

/**
 * A record-surface MutableTokenStore fake. Seed it with existing records to
 * prove the mirror preserves a refresh token; every `putRecord` is captured.
 */
function mkMutableStore(seed: Record<string, TokenRecord> = {}): {
	store: Pick<MutableTokenStore, "getRecord" | "putRecord">;
	puts: Array<{ uuid: string; record: TokenRecord }>;
} {
	const backing = new Map<string, TokenRecord>(Object.entries(seed));
	const puts: Array<{ uuid: string; record: TokenRecord }> = [];
	return {
		puts,
		store: {
			getRecord: (uuid: AccountUuid) => Promise.resolve(backing.get(uuid)),
			putRecord: (uuid: AccountUuid, record: TokenRecord) => {
				puts.push({ uuid, record });
				backing.set(uuid, record);
				return Promise.resolve();
			},
		},
	};
}

describe("poolActiveToken", () => {
	it("mirrors the live account's token from the read store into the write store", async () => {
		// Active token is token-A; the read store (keychain) holds it for UUID_A.
		// The mirror must write UUID_A's token into the write store (the file store
		// the shim reads) — this is what lets a session switch TO that account.
		const { store, puts } = mkMutableStore();
		const result = await poolActiveToken({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			readStore: mkTokenStore({ [UUID_A]: "token-A", [UUID_B]: "token-B" }),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: UUID_A });
		expect(puts).toStrictEqual([{ uuid: UUID_A, record: { accessToken: "token-A" } }]);
	});

	it("preserves an existing refresh token + expiry when refreshing the mirrored access token", async () => {
		// The account was OAuth-added, so the file store already holds a full
		// record. The mirror must swap only the access token and keep the refresh
		// token + expiry, or the encrypted store loses the ability to auto-refresh
		// and the account dies when the mirrored access token expires.
		const { store, puts } = mkMutableStore({
			[UUID_A]: {
				accessToken: "stale-A",
				refreshToken: "refresh-A",
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
		});
		const result = await poolActiveToken({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			readStore: mkTokenStore({ [UUID_A]: "token-A", [UUID_B]: "token-B" }),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: UUID_A });
		expect(puts).toStrictEqual([
			{
				uuid: UUID_A,
				record: {
					accessToken: "token-A",
					refreshToken: "refresh-A",
					expiresAt: "2099-01-01T00:00:00.000Z",
				},
			},
		]);
	});

	it("no live sha (Safe Storage key absent) → mirrors nothing", async () => {
		const { store, puts } = mkMutableStore();
		const result = await poolActiveToken({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]], {
				readKeychainPassword: () => Promise.resolve(undefined),
			}),
			readStore: mkTokenStore({ [UUID_A]: "token-A" }),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: null });
		expect(puts).toStrictEqual([]);
	});

	it("live sha that no pooled account holds → mirrors nothing (fail-closed)", async () => {
		const { store, puts } = mkMutableStore();
		const result = await poolActiveToken({
			registry,
			// Active token is token-A, but the read store holds neither account's
			// token as token-A, so no account resolves as active.
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			readStore: mkTokenStore({ [UUID_A]: "other-1", [UUID_B]: "other-2" }),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: null });
		expect(puts).toStrictEqual([]);
	});

	it("resolves an active account but its token becomes unreadable on re-read → mirrors nothing", async () => {
		// The sha match reads token-A once; the subsequent mirror read throws.
		// Defensive: rather than write a garbage/undefined token, fail closed.
		const { store, puts } = mkMutableStore();
		const result = await poolActiveToken({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			readStore: mkReadableOnceStore(UUID_A, "token-A"),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: null });
		expect(puts).toStrictEqual([]);
	});

	it("tolerates a read store whose get() throws for an unmatched account (split pool)", async () => {
		// UUID_B's token is keychain-only and throws here; UUID_A resolves fine.
		// A throw on B must NOT sink the mirror of the active account A.
		const { store, puts } = mkMutableStore();
		const result = await poolActiveToken({
			registry,
			activeTokenPorts: makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("token-A")]]),
			readStore: mkThrowingReadStore({ [UUID_A]: "token-A" }),
			writeStore: store,
		});
		expect(result).toStrictEqual({ pooledUuid: UUID_A });
		expect(puts).toStrictEqual([{ uuid: UUID_A, record: { accessToken: "token-A" } }]);
	});
});
