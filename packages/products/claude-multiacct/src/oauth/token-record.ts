/**
 * `@foundation/claude-multiacct` — `TokenRecord` codec shared by every store.
 *
 * A pooled OAuth account is only alive while its `refreshToken` + `expiresAt`
 * survive the round-trip to storage: drop them and the access token expires in
 * about an hour with nothing left to renew it, so the account fails with a 401
 * and the only recovery is a manual re-register. Both persistent stores
 * therefore encode the whole {@link TokenRecord} as JSON and decode it through
 * {@link parseTokenRecord} — the file store (AES-GCM plaintext) and the keychain
 * store (the generic-password secret). Keeping one codec is what keeps the two
 * back ends interchangeable behind `LayeredTokenStore`.
 *
 * Installs that predate the record format hold a BARE access-token string in
 * both back ends, so decoding must accept that shape forever.
 *
 * @module
 */

import type { OAuthTokens } from "./models.ts";
import type { TokenRecord } from "../ports.ts";

/**
 * Decode stored plaintext into a {@link TokenRecord}. A well-formed JSON object
 * with a non-empty string `accessToken` is taken as a record; ANY parse error or
 * non-record shape is treated as a BARE legacy access token
 * (`{accessToken: plaintext}`). That fallback is load-bearing — a pre-record
 * install must keep working across the upgrade, not read as a corrupt entry.
 *
 * @param {string} plaintext - The stored UTF-8 plaintext (decrypted, or the raw keychain secret).
 * @returns {TokenRecord} The decoded record.
 */
export function parseTokenRecord(plaintext: string): TokenRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		return { accessToken: plaintext };
	}
	const record = parsed as {
		accessToken?: unknown;
		refreshToken?: unknown;
		expiresAt?: unknown;
	} | null;
	if (typeof record?.accessToken !== "string" || record.accessToken.length === 0) {
		// Parsed, but not a TokenRecord shape → legacy bare token.
		return { accessToken: plaintext };
	}
	return {
		accessToken: record.accessToken,
		...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
		...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
	};
}

/**
 * Encode a {@link TokenRecord} for storage. The inverse of
 * {@link parseTokenRecord}; a single function so a store can never invent its
 * own on-disk shape.
 *
 * @param {TokenRecord} record - The record to encode.
 * @returns {string} JSON text to persist.
 */
export function encodeTokenRecord(record: TokenRecord): string {
	return JSON.stringify(record);
}

/**
 * Project the `OAuthTokens` a refresh/login grant returns onto the narrower
 * {@link TokenRecord} the stores persist. `scopes` is deliberately dropped —
 * it is not part of the credential bag any store reads back — while
 * `refreshToken` and `expiresAt` are carried whenever the provider returned
 * them, which is what makes refresh-on-read possible on the next call.
 *
 * @param {OAuthTokens} tokens - Tokens as returned by the OAuth grant.
 * @returns {TokenRecord} The record to persist.
 */
export function tokenRecordFrom(tokens: OAuthTokens): TokenRecord {
	return {
		accessToken: tokens.accessToken,
		...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
		...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
	};
}
