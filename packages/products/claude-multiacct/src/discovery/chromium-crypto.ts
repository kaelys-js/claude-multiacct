/**
 * `@foundation/claude-multiacct` — Chromium `v10` value decryption.
 *
 * Every Chromium-based app on macOS (Chrome, Edge, Electron apps like
 * Claude Desktop) encrypts sensitive Local Storage / IndexedDB / Cookies
 * values with the same scheme:
 *
 *   1. A per-app AES key lives in the login Keychain under service
 *      `<AppName> Safe Storage` account `<AppName> Key`. Claude Desktop
 *      uses `Claude Safe Storage` / `Claude Key`.
 *   2. That keychain password is passed through PBKDF2-HMAC-SHA1 with
 *      salt `saltysalt`, 1003 iterations, keylen 16 (AES-128).
 *   3. Encrypted values are stored on disk as
 *      `"v10" || AES-128-CBC(key, iv=b" " * 16, PKCS7(plaintext))`.
 *
 * The `saltysalt`/`1003`/`b" " * 16` triple is Chromium's macOS default
 * (`components/os_crypt/sync/keychain_password_mac.mm` +
 * `os_crypt_mac.mm`). Cross-referenced against multiple open-source
 * projects that decrypt Chrome cookies + the current Chromium source
 * tree.
 *
 * The classifier for OAuth is application-level: we look for JSON blobs
 * with `access_token` / `oauth_access_token` fields in the decrypted
 * plaintext.
 *
 * @module
 */

import { createDecipheriv, pbkdf2Sync } from "node:crypto";

/** Chromium's macOS PBKDF2 salt. Constant across every Chromium build. */
export const CHROMIUM_SALT = Buffer.from("saltysalt", "utf8");
/** Chromium's macOS PBKDF2 iterations. Constant across every Chromium build. */
export const CHROMIUM_ITERATIONS = 1003;
/** Chromium's macOS AES key length (AES-128). Constant. */
export const CHROMIUM_KEY_LEN = 16;
/**
 * Chromium's macOS AES-CBC IV. Constant (documented weakness — every
 * Chromium encryption uses the same IV, but it doesn't affect the
 * decryption implementation).
 */
export const CHROMIUM_IV = Buffer.alloc(16, 0x20); // 16 spaces
/** Prefix that identifies a Chromium-encrypted value. */
export const CHROMIUM_V10_PREFIX = Buffer.from("v10", "utf8");

/**
 * Derive Chromium's per-app AES-128 key from the Safe Storage keychain
 * password.
 *
 * @param {string} keychainPassword - Value from `security find-generic-password -w -s "<App> Safe Storage" -a "<App> Key"`.
 * @returns {Buffer} 16-byte AES-128 key.
 */
export function deriveChromiumKey(keychainPassword: string): Buffer {
	return pbkdf2Sync(
		Buffer.from(keychainPassword, "utf8"),
		CHROMIUM_SALT,
		CHROMIUM_ITERATIONS,
		CHROMIUM_KEY_LEN,
		"sha1",
	);
}

/**
 * Whether `buf` looks like a Chromium `v10`-prefixed encrypted value.
 *
 * @param {Buffer} buf - Raw bytes to inspect.
 * @returns {boolean} True if prefix matches.
 */
export function isEncrypted(buf: Buffer): boolean {
	return (
		buf.length > CHROMIUM_V10_PREFIX.length &&
		buf.subarray(0, CHROMIUM_V10_PREFIX.length).equals(CHROMIUM_V10_PREFIX)
	);
}

/**
 * Decrypt a `v10`-prefixed Chromium value.
 *
 * @param {Buffer} encrypted - The `v10`-prefixed ciphertext bytes.
 * @param {Buffer} key - 16-byte AES-128 key from `deriveChromiumKey`.
 * @returns {Buffer} Decrypted plaintext.
 * @throws {Error} When the input isn't `v10`-prefixed, is too short, or decryption fails.
 */
export function decryptV10(encrypted: Buffer, key: Buffer): Buffer {
	if (!isEncrypted(encrypted)) {
		throw new Error("decryptV10: input does not start with 'v10' prefix");
	}
	if (key.length !== CHROMIUM_KEY_LEN) {
		throw new Error(
			`decryptV10: key must be ${String(CHROMIUM_KEY_LEN)} bytes (got ${String(key.length)})`,
		);
	}
	const ciphertext = encrypted.subarray(CHROMIUM_V10_PREFIX.length);
	const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_IV);
	decipher.setAutoPadding(true);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Best-effort extract OAuth-token-like fields from a decrypted JSON
 * blob. Returns undefined if the blob isn't JSON, doesn't parse, or
 * contains no recognisable OAuth token fields.
 *
 * Recognises common shapes: bare `access_token` at top level;
 * `oauth_access_token` at top level (Anthropic CLI style); nested
 * `tokens.access_token` or `credentials.access_token`.
 *
 * @param {Buffer} plaintext - Decrypted value.
 * @returns {{ token: string; email: string | undefined } | undefined} Extracted OAuth data or `undefined`.
 */
export function extractOauthFromPlaintext(
	plaintext: Buffer,
): { token: string; email: string | undefined } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext.toString("utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const obj = parsed as Record<string, unknown>;
	const token = findTokenIn(obj);
	if (token === undefined) {
		return undefined;
	}
	const email = findEmailIn(obj);
	return { token, email };
}

function findTokenIn(obj: Record<string, unknown>): string | undefined {
	const direct = pickString(obj, "access_token") ?? pickString(obj, "oauth_access_token");
	if (direct !== undefined) {
		return direct;
	}
	for (const key of ["tokens", "credentials", "auth", "oauth"] as const) {
		const nested = obj[key];
		if (typeof nested === "object" && nested !== null) {
			const inner = findTokenIn(nested as Record<string, unknown>);
			if (inner !== undefined) {
				return inner;
			}
		}
	}
	return undefined;
}

function findEmailIn(obj: Record<string, unknown>): string | undefined {
	const direct =
		pickString(obj, "email") ?? pickString(obj, "user_email") ?? pickString(obj, "account_email");
	if (direct !== undefined) {
		return direct;
	}
	for (const key of ["user", "account", "profile", "identity"] as const) {
		const nested = obj[key];
		if (typeof nested === "object" && nested !== null) {
			const inner = findEmailIn(nested as Record<string, unknown>);
			if (inner !== undefined) {
				return inner;
			}
		}
	}
	return undefined;
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
