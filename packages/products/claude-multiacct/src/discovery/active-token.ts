/**
 * `@foundation/claude-multiacct` — active-token sha derivation (injectable IO).
 *
 * Account-resolution (`domain/registry.ts::getPrimary`) picks the active
 * account by matching each account's OAuth token sha256 against the token
 * Claude.app is CURRENTLY authenticated as. The domain stays pure; this module
 * is the IO side it delegates to, split into two halves:
 *
 *   - `currentActiveTokenSha` produces the "which token is Claude.app logged in
 *     as right now?" sha, sourced exactly the way discovery reads Claude.app's
 *     credentials: decrypt the `oauth:tokenCacheV2` v10 blob from
 *     `~/Library/Application Support/Claude/config.json` with the `Claude Safe
 *     Storage` keychain key, extract the OAuth access token, and hash it.
 *   - `tokenShasFromStore` + `accountTokenShaFrom` produce the per-account
 *     resolver `getPrimary` needs, hashing each account's stored token so the
 *     two sides compare like for like.
 *
 * Every side effect is injected via `ports`, so the derivation is unit-tested
 * with fakes and no filesystem or keychain call is baked into the module. Both
 * halves hash through the local `sha256Hex`, matching the digest discovery uses
 * to dedup tokens (SHA-256 over the raw UTF-8 token, hex-encoded): the match is
 * only correct when the active token and the account tokens are digested by the
 * identical function over the identical bytes.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { Account, AccountUuid } from "../domain/account.ts";
import type { AccountRegistry, AccountTokenSha } from "../domain/registry.ts";
import type { TokenStore } from "../ports.ts";
import {
	decryptV10,
	deriveChromiumKey,
	extractOauthFromPlaintext,
	isEncrypted,
} from "./chromium-crypto.ts";

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Must stay byte-identical to
 * `discover-accounts.ts`'s dedup hash — resolution matches the active token's
 * sha against each account's, so both sides have to compute the same digest.
 *
 * @param {string} input - Raw token string.
 * @returns {string} 64-char hex digest.
 */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Keychain service + account holding the main Claude.app Safe Storage key. */
export const SAFE_STORAGE_SERVICE = "Claude Safe Storage";
export const SAFE_STORAGE_ACCOUNT = "Claude Key";

/**
 * config.json keys holding the OAuth token cache. `oauth:tokenCacheV2` is the
 * current scheme Claude.app writes; `oauth:tokenCache` is the older one kept as
 * a fallback so a machine mid-migration still resolves.
 */
export const ACTIVE_TOKEN_KEY = "oauth:tokenCacheV2";
export const LEGACY_TOKEN_KEY = "oauth:tokenCache";

/** Injected side effects `currentActiveTokenSha` needs. */
export type ActiveTokenPorts = {
	/**
	 * Read the `Claude Safe Storage` keychain password. Returns `undefined`
	 * when the entry is missing or the read is refused. Mirrors
	 * `DiscoveryPorts.readKeychainPassword` so real wiring passes the same port.
	 */
	readKeychainPassword: (service: string, account: string) => Promise<string | undefined>;
	/**
	 * Yield each base64-decoded v10 blob embedded in Claude.app's `config.json`,
	 * keyed by its JSON key. Mirrors `DiscoveryPorts.iterateAppConfigJson`.
	 */
	iterateAppConfigJson: (path: string) => AsyncIterable<{ key: Buffer; value: Buffer }>;
	/** Absolute path to Claude.app's `config.json`. */
	configJsonPath: string;
};

/**
 * Decrypt one v10 blob and pull the OAuth access token out of it, or
 * `undefined` when the blob is not encrypted, will not decrypt, or carries no
 * recognisable token. Best-effort by design: config.json holds unrelated v10
 * values too, and one bad blob must not abort the scan.
 *
 * @param {Buffer} value - Decoded v10 blob bytes.
 * @param {Buffer} key - 16-byte AES-128 Safe Storage key.
 * @returns {string | undefined} The access token, or `undefined`.
 */
function tokenFromBlob(value: Buffer, key: Buffer): string | undefined {
	if (!isEncrypted(value)) {
		return undefined;
	}
	let plaintext: Buffer;
	try {
		plaintext = decryptV10(value, key);
	} catch {
		return undefined;
	}
	return extractOauthFromPlaintext(plaintext)?.token;
}

/**
 * Compute the sha256 of the OAuth token Claude.app is currently authenticated
 * as, or `undefined` when it cannot be determined.
 *
 * Prefers the current-scheme `oauth:tokenCacheV2` entry; if only the legacy
 * `oauth:tokenCache` is present it uses that. `undefined` when the Safe Storage
 * key is absent (nothing to decrypt with) or no config entry yields a token —
 * both cases fail closed, letting `getPrimary` fall back to its first-account
 * default rather than guessing.
 *
 * @param {ActiveTokenPorts} ports - Injected keychain + config.json IO.
 * @returns {Promise<string | undefined>} The active token sha256 (hex), or `undefined`.
 */
export async function currentActiveTokenSha(ports: ActiveTokenPorts): Promise<string | undefined> {
	const password = await ports.readKeychainPassword(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNT);
	if (password === undefined) {
		return undefined;
	}
	const key = deriveChromiumKey(password);
	let legacySha: string | undefined;
	for await (const entry of ports.iterateAppConfigJson(ports.configJsonPath)) {
		const token = tokenFromBlob(entry.value, key);
		if (token !== undefined) {
			const keyName = entry.key.toString("utf8");
			if (keyName === ACTIVE_TOKEN_KEY) {
				// Current scheme wins outright — no need to keep scanning.
				return sha256Hex(token);
			}
			if (keyName === LEGACY_TOKEN_KEY) {
				legacySha ??= sha256Hex(token);
			}
		}
	}
	return legacySha;
}

/**
 * Materialize each account's OAuth token sha256 by reading and hashing its
 * stored token. Accounts whose token is missing/unreadable are omitted, so a
 * lookup miss (rather than a wrong match) is what `getPrimary` sees for them.
 *
 * This is the async half `getPrimary` cannot do itself: it front-loads the
 * token-store reads into a plain map the synchronous resolver closes over.
 *
 * @param {AccountRegistry} registry - The pool whose tokens to hash.
 * @param {Pick<TokenStore, "get">} tokenStore - Token store to read from.
 * @returns {Promise<Map<AccountUuid, string>>} uuid → token sha256 (hex).
 */
export async function tokenShasFromStore(
	registry: AccountRegistry,
	tokenStore: Pick<TokenStore, "get">,
): Promise<Map<AccountUuid, string>> {
	const shas = new Map<AccountUuid, string>();
	for (const account of registry.accounts) {
		// eslint-disable-next-line no-await-in-loop -- serial per-account read; the pool is small and order is irrelevant
		const token = await tokenStore.get(account.uuid);
		if (typeof token === "string") {
			shas.set(account.uuid, sha256Hex(token));
		}
	}
	return shas;
}

/**
 * Adapt a materialized uuid→sha map into the `AccountTokenSha` resolver
 * `getPrimary` expects. A uuid absent from the map resolves to `undefined`,
 * which cannot equal the active sha, so that account is never mismatched.
 *
 * @param {ReadonlyMap<AccountUuid, string>} shaByUuid - uuid → token sha256.
 * @returns {AccountTokenSha} Synchronous per-account resolver.
 */
export function accountTokenShaFrom(shaByUuid: ReadonlyMap<AccountUuid, string>): AccountTokenSha {
	return (account: Account): string | undefined => shaByUuid.get(account.uuid);
}
