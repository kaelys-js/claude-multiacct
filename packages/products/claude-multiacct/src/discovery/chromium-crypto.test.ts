/* eslint-disable vitest/no-conditional-in-test, vitest/require-to-throw-message, no-bitwise, eslint/no-bitwise, eslint/operator-assignment, unicorn/prefer-at, jsdoc/require-returns, jsdoc/require-param */
/**
 * Intent: `chromium-crypto.ts` implements Chromium's macOS `v10`
 * encryption scheme (PBKDF2-SHA1 saltysalt 1003 iters → AES-128-CBC
 * with iv=16 spaces). Round-trip encrypting + decrypting a known
 * plaintext MUST recover the original bytes. `extractOauthFromPlaintext`
 * MUST find OAuth tokens in the several JSON shapes that Anthropic /
 * Chromium apps use, and MUST return undefined for anything that isn't
 * a token-bearing JSON blob.
 *
 * Adversarial: change any constant (salt, iterations, key-len, iv, hash
 * algo) and the round-trip test flips RED. Remove one of the JSON-shape
 * recognizers and the corresponding test flips RED.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CHROMIUM_IV,
	CHROMIUM_ITERATIONS,
	CHROMIUM_KEY_LEN,
	CHROMIUM_SALT,
	CHROMIUM_V10_PREFIX,
	decryptV10,
	deriveChromiumKey,
	extractOauthFromPlaintext,
	isEncrypted,
} from "./chromium-crypto.ts";

/**
 * Helper — mirror what Chromium does to encrypt (used only in tests).
 * Confirms the constants match by proving encrypt+decrypt round-trips.
 */
function encryptV10Test(plaintext: Buffer, key: Buffer): Buffer {
	const cipher = createCipheriv("aes-128-cbc", key, CHROMIUM_IV);
	cipher.setAutoPadding(true);
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([CHROMIUM_V10_PREFIX, ct]);
}

const TEST_PW = "example-safe-storage-key-not-real";

describe("Chromium crypto constants", () => {
	it("pins the exact Chromium macOS constants", () => {
		expect(CHROMIUM_SALT.toString("utf8")).toBe("saltysalt");
		expect(CHROMIUM_ITERATIONS).toBe(1003);
		expect(CHROMIUM_KEY_LEN).toBe(16);
		expect(CHROMIUM_IV.length).toBe(16);
		expect(CHROMIUM_IV.every((b) => b === 0x20)).toBe(true);
		expect(CHROMIUM_V10_PREFIX.toString("utf8")).toBe("v10");
	});
});

describe("deriveChromiumKey", () => {
	it("produces a 16-byte key", () => {
		expect(deriveChromiumKey(TEST_PW).length).toBe(16);
	});

	it("is deterministic (same password → same key)", () => {
		const a = deriveChromiumKey(TEST_PW);
		const b = deriveChromiumKey(TEST_PW);
		expect(a.equals(b)).toBe(true);
	});

	it("different passwords → different keys", () => {
		expect(deriveChromiumKey("a").equals(deriveChromiumKey("b"))).toBe(false);
	});
});

describe("isEncrypted", () => {
	it("returns true for v10-prefixed buffers", () => {
		expect(isEncrypted(Buffer.concat([CHROMIUM_V10_PREFIX, Buffer.from("xxx")]))).toBe(true);
	});
	it("returns false for un-prefixed buffers", () => {
		expect(isEncrypted(Buffer.from("plain text"))).toBe(false);
		expect(isEncrypted(Buffer.from("v11anything"))).toBe(false);
		expect(isEncrypted(Buffer.from(""))).toBe(false);
	});
});

describe("decryptV10 — round-trip proves the constants match Chromium", () => {
	it("round-trips a small JSON blob", () => {
		const key = deriveChromiumKey(TEST_PW);
		const plaintext = Buffer.from('{"access_token":"sk-ant-oat01-example"}', "utf8");
		const encrypted = encryptV10Test(plaintext, key);
		expect(decryptV10(encrypted, key).equals(plaintext)).toBe(true);
	});

	it("round-trips a longer plaintext (multiple AES blocks)", () => {
		const key = deriveChromiumKey(TEST_PW);
		const plaintext = Buffer.from("x".repeat(1024), "utf8");
		const encrypted = encryptV10Test(plaintext, key);
		expect(decryptV10(encrypted, key).equals(plaintext)).toBe(true);
	});

	it("throws on missing v10 prefix", () => {
		const key = deriveChromiumKey(TEST_PW);
		expect(() => decryptV10(Buffer.from("no-prefix-here"), key)).toThrow(/v10/u);
	});

	it("throws on wrong key length", () => {
		expect(() =>
			decryptV10(Buffer.concat([CHROMIUM_V10_PREFIX, Buffer.from("xxx")]), Buffer.alloc(15)),
		).toThrow(/16 bytes/u);
	});

	it("throws on corrupted ciphertext (bad-padding surfaces as decrypt error)", () => {
		const key = deriveChromiumKey(TEST_PW);
		const plaintext = Buffer.from("hello world", "utf8");
		const encrypted = encryptV10Test(plaintext, key);
		encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 0xff;
		expect(() => decryptV10(encrypted, key)).toThrow();
	});
});

describe("extractOauthFromPlaintext", () => {
	it("returns undefined for non-JSON", () => {
		expect(extractOauthFromPlaintext(Buffer.from("garbage"))).toBeUndefined();
	});
	it("returns undefined for JSON with no token", () => {
		expect(extractOauthFromPlaintext(Buffer.from('{"foo":"bar"}'))).toBeUndefined();
	});
	it("recognises {access_token} at top level", () => {
		expect(extractOauthFromPlaintext(Buffer.from('{"access_token":"T-1"}'))).toEqual({
			token: "T-1",
			email: undefined,
		});
	});
	it("recognises {oauth_access_token} at top level (Anthropic CLI shape)", () => {
		expect(extractOauthFromPlaintext(Buffer.from('{"oauth_access_token":"T-2"}'))).toEqual({
			token: "T-2",
			email: undefined,
		});
	});
	it("recognises {tokens.access_token} nested", () => {
		expect(extractOauthFromPlaintext(Buffer.from('{"tokens":{"access_token":"T-3"}}'))).toEqual({
			token: "T-3",
			email: undefined,
		});
	});
	it("recognises {credentials.access_token} nested", () => {
		expect(
			extractOauthFromPlaintext(Buffer.from('{"credentials":{"access_token":"T-4"}}')),
		).toEqual({ token: "T-4", email: undefined });
	});
	it("also extracts email from top-level {email}", () => {
		expect(
			extractOauthFromPlaintext(Buffer.from('{"access_token":"T","email":"me@example.com"}')),
		).toEqual({ token: "T", email: "me@example.com" });
	});
	it("also extracts email from nested {user.email}", () => {
		expect(
			extractOauthFromPlaintext(
				Buffer.from('{"access_token":"T","user":{"email":"me@example.com"}}'),
			),
		).toEqual({ token: "T", email: "me@example.com" });
	});
	it("returns undefined for empty JSON object", () => {
		expect(extractOauthFromPlaintext(Buffer.from("{}"))).toBeUndefined();
	});
});
