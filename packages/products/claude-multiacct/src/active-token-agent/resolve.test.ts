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
import type { TokenStore } from "../ports.ts";
import { resolveActiveAccount } from "./resolve.ts";

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
