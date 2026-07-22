/**
 * `@foundation/claude-multiacct` — detect the native Claude.app account.
 *
 * The pool's anchor is the account Claude.app is natively signed into. This
 * module identifies EXACTLY that one account and its token, replacing the old
 * "import every cached token" scan:
 *
 *   1. Read `lastKnownAccountUuid` from config.json (plaintext) — the real
 *      account uuid Claude.app records for the current login. No marker → no
 *      confident native account, return `undefined`.
 *   2. Decrypt `oauth:tokenCacheV2` with the `Claude Safe Storage` key and
 *      enumerate its OAuth tokens (one per cache-key account segment, richest
 *      scope preferred).
 *   3. For each candidate token, call the profile API. The token whose
 *      `account.uuid` equals `lastKnownAccountUuid` is the native account; its
 *      profile also yields the real identity (email / display name) and a coarse
 *      subscription. First match wins.
 *
 * Why the profile round-trip rather than trusting the cache-key segment: on a
 * real machine the tokenCacheV2 key's first segment is a per-TOKEN/session id,
 * not the account uuid — several distinct segments can all belong to ONE
 * account, and none of them need equal `lastKnownAccountUuid`. Only the profile
 * API reports the authoritative `account.uuid`, so it is the only reliable way
 * to bind a token to the account Claude.app names as current.
 *
 * Fail-closed throughout: no marker, no keychain key, no decryptable V2 token,
 * or no token whose profile matches the marker → `undefined`, and discovery
 * registers nothing rather than guessing.
 *
 * Every side effect is injected via `ports`.
 *
 * @module
 */

import type { AccountIdentity, ClaudeAccountUuid } from "../domain/account.ts";
import {
	decryptV10,
	deriveChromiumKey,
	extractOauthEntriesFromPlaintext,
	isEncrypted,
	type OauthEntry,
} from "./chromium-crypto.ts";
import type { ProfileResult } from "./identity.ts";

/** config.json key holding the current (V2) OAuth token cache. */
export const TOKEN_CACHE_V2_KEY = "oauth:tokenCacheV2";
/** Keychain service + account holding the main Claude.app Safe Storage key. */
export const SAFE_STORAGE_SERVICE = "Claude Safe Storage";
export const SAFE_STORAGE_ACCOUNT = "Claude Key";

/** Injected side effects `detectNativeAccount` needs. */
export type NativeDetectionPorts = {
	/** Read Claude.app's plaintext `lastKnownAccountUuid` from config.json. */
	readLastKnownAccountUuid: () => Promise<string | undefined>;
	/** Read the `Claude Safe Storage` keychain password (undefined = missing/refused). */
	readKeychainPassword: (service: string, account: string) => Promise<string | undefined>;
	/** Yield each base64-decoded v10 blob in config.json, keyed by its JSON key. */
	iterateAppConfigJson: (path: string) => AsyncIterable<{ key: Buffer; value: Buffer }>;
	/** Absolute path to Claude.app's config.json. */
	configJsonPath: string;
	/** Resolve an account's identity from its OAuth token via the profile API. */
	fetchProfile: (token: string) => Promise<ProfileResult>;
	/** Log sink for warnings / progress. */
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

/** The native account, fully resolved: real uuid, its token, and real identity. */
export type DetectedNativeAccount = {
	accountUuid: ClaudeAccountUuid;
	token: string;
	identity: AccountIdentity;
	subscriptionType: string;
	rateLimitTier: string;
};

/**
 * Decrypt one v10 blob and enumerate its OAuth entries, or `[]` when the blob is
 * not encrypted, will not decrypt, or holds no token. Best-effort: config.json
 * carries unrelated v10 values too.
 *
 * @param {Buffer} value - Decoded v10 blob bytes.
 * @param {Buffer} key - 16-byte AES-128 Safe Storage key.
 * @returns {OauthEntry[]} Zero or more OAuth entries.
 */
function entriesFromBlob(value: Buffer, key: Buffer): OauthEntry[] {
	if (!isEncrypted(value)) {
		return [];
	}
	let plaintext: Buffer;
	try {
		plaintext = decryptV10(value, key);
	} catch {
		return [];
	}
	return extractOauthEntriesFromPlaintext(plaintext);
}

/**
 * Collect every OAuth token in `oauth:tokenCacheV2` (one per cache-key account
 * segment, richest scope preferred by the extractor).
 *
 * @param {NativeDetectionPorts} ports - Injected IO.
 * @param {Buffer} key - The derived Safe Storage AES key.
 * @returns {Promise<string[]>} Candidate tokens, de-duplicated by value.
 */
async function v2Tokens(ports: NativeDetectionPorts, key: Buffer): Promise<string[]> {
	const tokens: string[] = [];
	const seen = new Set<string>();
	for await (const entry of ports.iterateAppConfigJson(ports.configJsonPath)) {
		if (entry.key.toString("utf8") === TOKEN_CACHE_V2_KEY) {
			for (const oauth of entriesFromBlob(entry.value, key)) {
				if (!seen.has(oauth.token)) {
					seen.add(oauth.token);
					tokens.push(oauth.token);
				}
			}
		}
	}
	return tokens;
}

/**
 * Detect the native Claude.app account. See module docstring for the algorithm.
 *
 * @param {NativeDetectionPorts} ports - Injected side-effects.
 * @returns {Promise<DetectedNativeAccount | undefined>} The native account, or `undefined`.
 */
export async function detectNativeAccount(
	ports: NativeDetectionPorts,
): Promise<DetectedNativeAccount | undefined> {
	const lastKnown = await ports.readLastKnownAccountUuid();
	if (lastKnown === undefined) {
		ports.logger.warn("native-detect: no lastKnownAccountUuid in config.json; skipping");
		return undefined;
	}
	const password = await ports.readKeychainPassword(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNT);
	if (password === undefined) {
		ports.logger.warn("native-detect: no Claude Safe Storage key; cannot decrypt tokenCacheV2");
		return undefined;
	}
	const key = deriveChromiumKey(password);
	const tokens = await v2Tokens(ports, key);
	if (tokens.length === 0) {
		ports.logger.warn("native-detect: tokenCacheV2 held no decryptable OAuth token");
		return undefined;
	}

	for (const token of tokens) {
		// eslint-disable-next-line no-await-in-loop -- serial: stop at the first token whose profile matches the marker
		const result = await ports.fetchProfile(token);
		if (!result.ok) {
			ports.logger.warn(`native-detect: profile fetch failed (${result.kind}): ${result.detail}`);
		} else if (result.profile.accountUuid === lastKnown) {
			ports.logger.log(
				`native-detect: matched native account ${lastKnown}${
					result.profile.email === undefined ? "" : ` (${result.profile.email})`
				}`,
			);
			return {
				accountUuid: result.profile.accountUuid,
				token,
				identity: buildIdentity(result.profile.email, result.profile.displayName),
				subscriptionType: result.profile.subscriptionType,
				rateLimitTier: result.profile.rateLimitTier,
			};
		}
	}
	ports.logger.warn(
		`native-detect: no cached token resolved to lastKnownAccountUuid ${lastKnown}; skipping`,
	);
	return undefined;
}

/**
 * Build an `AccountIdentity`, omitting fields the profile did not supply so the
 * strict schema is not handed empty strings.
 *
 * @param {string | undefined} email - Profile email.
 * @param {string | undefined} displayName - Profile display name.
 * @returns {AccountIdentity} Identity with only the present fields.
 */
function buildIdentity(
	email: string | undefined,
	displayName: string | undefined,
): AccountIdentity {
	return {
		...(email === undefined ? {} : { email }),
		...(displayName === undefined ? {} : { displayName }),
	};
}
