/* oxlint-disable jsdoc/require-param, jsdoc/require-returns, vitest/require-mock-type-parameters */
/**
 * Intent: the IO half of account-resolution. `currentActiveTokenSha` must
 * produce the sha of whatever token Claude.app is authenticated as RIGHT NOW,
 * sourced from the `oauth:tokenCacheV2` config.json blob the same way discovery
 * reads credentials — and it must fail closed (undefined) whenever it cannot,
 * so `getPrimary` falls back deterministically instead of matching garbage. The
 * per-account helpers must hash stored tokens with the identical function so the
 * two sides of the match compare like for like, and must omit (never
 * mis-resolve) an account whose token is unreadable.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Account, AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { TokenStore } from "../ports.ts";
import {
	ACTIVE_TOKEN_KEY,
	type ActiveTokenPorts,
	accountTokenShaFrom,
	currentActiveTokenSha,
	LEGACY_TOKEN_KEY,
	SAFE_STORAGE_ACCOUNT,
	SAFE_STORAGE_SERVICE,
	sha256Hex,
	tokenShasFromStore,
} from "./active-token.ts";
import { CHROMIUM_IV, CHROMIUM_V10_PREFIX, deriveChromiumKey } from "./chromium-crypto.ts";

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

/** A v10 blob carrying an OAuth access token, the shape extractOauth recognises. */
function tokenBlob(token: string): Buffer {
	return v10(JSON.stringify({ access_token: token }));
}

/** Build ActiveTokenPorts whose config.json yields the given key→blob entries. */
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

function mkTokenStore(entries: Record<string, string | undefined>): Pick<TokenStore, "get"> {
	return { get: (uuid: AccountUuid) => Promise.resolve(entries[uuid]) };
}

describe("currentActiveTokenSha", () => {
	it("reads the Safe Storage key from the right keychain service/account", async () => {
		// The sha is worthless if it comes from the wrong key; pin the exact
		// keychain identifiers discovery uses so a rename can't silently misread.
		const spy = vi.fn(() => Promise.resolve(PASSWORD));
		await currentActiveTokenSha(
			makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("t")]], {
				readKeychainPassword: spy,
			}),
		);
		expect(spy).toHaveBeenCalledWith(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNT);
	});

	it("returns undefined when the keychain key is absent (nothing to decrypt with)", async () => {
		// No key means the blobs can't be decrypted; fail closed so getPrimary
		// falls back rather than acting on a token it never actually read.
		const sha = await currentActiveTokenSha(
			makePorts([[ACTIVE_TOKEN_KEY, tokenBlob("t")]], {
				readKeychainPassword: () => Promise.resolve(undefined),
			}),
		);
		expect(sha).toBeUndefined();
	});

	it("returns the sha of the current-scheme oauth:tokenCacheV2 token, preferring it over legacy", async () => {
		// A machine mid-migration has both keys; the CURRENT login is tokenCacheV2,
		// so its token must win even when the legacy entry is scanned first.
		const sha = await currentActiveTokenSha(
			makePorts([
				[LEGACY_TOKEN_KEY, tokenBlob("legacy-token")],
				[ACTIVE_TOKEN_KEY, tokenBlob("current-token")],
			]),
		);
		expect(sha).toBe(sha256Hex("current-token"));
	});

	it("falls back to the legacy oauth:tokenCache token when V2 is absent", async () => {
		// Pre-migration client only writes the legacy key; still resolve the
		// active account rather than giving up.
		const sha = await currentActiveTokenSha(
			makePorts([[LEGACY_TOKEN_KEY, tokenBlob("only-legacy")]]),
		);
		expect(sha).toBe(sha256Hex("only-legacy"));
	});

	it("ignores config entries under unrelated keys", async () => {
		// A v10 blob with a token but keyed neither V2 nor legacy is not the auth
		// token; treating it as active would resolve to the wrong account.
		const sha = await currentActiveTokenSha(
			makePorts([["oauth:somethingElse", tokenBlob("nope")]]),
		);
		expect(sha).toBeUndefined();
	});

	it("skips non-encrypted and undecryptable blobs without throwing", async () => {
		// config.json holds unrelated values and can hold a corrupt blob; one bad
		// entry must not abort the scan or crash the daemon.
		const notV10 = Buffer.from("plain-json-value", "utf8");
		const corruptV10 = Buffer.concat([CHROMIUM_V10_PREFIX, Buffer.from("garbage-ciphertext")]);
		const sha = await currentActiveTokenSha(
			makePorts([
				["oauth:tokenCacheV2:extra", notV10],
				[LEGACY_TOKEN_KEY, corruptV10],
				[ACTIVE_TOKEN_KEY, tokenBlob("good")],
			]),
		);
		expect(sha).toBe(sha256Hex("good"));
	});

	it("returns undefined when no config entry yields a token", async () => {
		const sha = await currentActiveTokenSha(makePorts([]));
		expect(sha).toBeUndefined();
	});
});

describe("tokenShasFromStore", () => {
	const registry: AccountRegistry = { accounts: [acct(UUID_A, "Personal"), acct(UUID_B, "Work")] };

	it("hashes each account's stored token so getPrimary can match on it", async () => {
		const shas = await tokenShasFromStore(
			registry,
			mkTokenStore({ [UUID_A]: "token-a", [UUID_B]: "token-b" }),
		);
		expect(shas.get(UUID_A)).toBe(sha256Hex("token-a"));
		expect(shas.get(UUID_B)).toBe(sha256Hex("token-b"));
	});

	it("omits accounts whose token is missing (a miss, never a wrong match)", async () => {
		// An account with no stored token must not land in the map: getPrimary
		// then sees undefined for it and never mislabels it active.
		const shas = await tokenShasFromStore(registry, mkTokenStore({ [UUID_A]: "token-a" }));
		expect(shas.get(UUID_A)).toBe(sha256Hex("token-a"));
		expect(shas.has(UUID_B)).toBe(false);
	});
});

describe("accountTokenShaFrom", () => {
	it("resolves a known account to its sha and an unknown account to undefined", () => {
		const resolver = accountTokenShaFrom(new Map([[UUID_A, "sha-a"]]));
		expect(resolver(acct(UUID_A, "Personal"))).toBe("sha-a");
		expect(resolver(acct(UUID_B, "Work"))).toBeUndefined();
	});
});
