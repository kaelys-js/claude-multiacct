/* oxlint-disable jsdoc/require-param, jsdoc/require-returns, unicorn/no-array-for-each, vitest/require-mock-type-parameters */
/**
 * Intent: `detectNativeAccount` identifies EXACTLY the account Claude.app is
 * signed into — no more scanning every cached token into the pool. It binds a
 * decrypted V2 token to the account via the profile API and accepts only the
 * token whose real `account.uuid` equals the plaintext `lastKnownAccountUuid`.
 * The tests pin that match, the identity it carries, and every fail-closed exit
 * (no marker, keychain blind, nothing decryptable, no profile match) so a
 * degraded machine registers nothing rather than importing the wrong token.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CHROMIUM_IV, CHROMIUM_V10_PREFIX, deriveChromiumKey } from "./chromium-crypto.ts";
import type { ProfileResult } from "./identity.ts";
import {
	detectNativeAccount,
	type NativeDetectionPorts,
	SAFE_STORAGE_ACCOUNT,
	SAFE_STORAGE_SERVICE,
	TOKEN_CACHE_V2_KEY,
} from "./native-account.ts";

const PASSWORD = "safe-storage-key";
const KEY = deriveChromiumKey(PASSWORD);
const CONFIG_PATH = "/fake/Claude/config.json";
const NATIVE_UUID = "918f32f7-44c2-442e-8d5d-48ca3792ea95";
const OTHER_UUID = "a473d7bb-17ac-43a7-abc0-a1343d7c2805";

/** Encrypt a plaintext the way Claude.app's Safe Storage does. */
function v10(plaintext: string): Buffer {
	const cipher = createCipheriv("aes-128-cbc", KEY, CHROMIUM_IV);
	cipher.setAutoPadding(true);
	const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	return Buffer.concat([CHROMIUM_V10_PREFIX, ct]);
}

/**
 * A tokenCacheV2 plaintext map: one entry per token, keyed by a distinct
 * first-segment (per-token id) so the extractor yields each token once.
 */
function v2Cache(tokens: string[]): string {
	const map: Record<string, unknown> = {};
	tokens.forEach((token, i) => {
		map[`seg${String(i)}:ws:https://api.anthropic.com:profile inference`] = { token };
	});
	return JSON.stringify(map);
}

function okProfile(accountUuid: string, extra: Partial<ProfileResult> = {}): ProfileResult {
	return {
		ok: true,
		profile: {
			accountUuid: accountUuid as never,
			email: "cole@icloud.com",
			displayName: "Cole",
			subscriptionType: "claude_max",
			rateLimitTier: "unknown",
		},
		...extra,
	} as ProfileResult;
}

type PortOverrides = Partial<NativeDetectionPorts> & {
	lastKnown?: string | undefined;
	password?: string | undefined;
	cacheTokens?: string[];
	profiles?: Record<string, ProfileResult>;
};

function makePorts(o: PortOverrides = {}): NativeDetectionPorts {
	const lastKnown = "lastKnown" in o ? o.lastKnown : NATIVE_UUID;
	const password = "password" in o ? o.password : PASSWORD;
	const cacheTokens = o.cacheTokens ?? ["tok-native"];
	const profiles = o.profiles ?? { "tok-native": okProfile(NATIVE_UUID) };
	return {
		readLastKnownAccountUuid: o.readLastKnownAccountUuid ?? (() => Promise.resolve(lastKnown)),
		readKeychainPassword: o.readKeychainPassword ?? (() => Promise.resolve(password)),
		iterateAppConfigJson:
			o.iterateAppConfigJson ??
			// eslint-disable-next-line require-yield -- generator built inline below
			async function* gen() {
				yield { key: Buffer.from("locale", "utf8"), value: Buffer.from("djEwUNRELATED", "base64") };
				yield { key: Buffer.from(TOKEN_CACHE_V2_KEY, "utf8"), value: v10(v2Cache(cacheTokens)) };
			},
		configJsonPath: CONFIG_PATH,
		fetchProfile:
			o.fetchProfile ??
			((token: string) =>
				Promise.resolve(
					profiles[token] ?? { ok: false, kind: "malformed", detail: "no fake profile" },
				)),
		logger: o.logger ?? { log: vi.fn(), warn: vi.fn() },
	};
}

describe("detectNativeAccount — the match", () => {
	it("returns the token whose profile account.uuid equals lastKnownAccountUuid, with real identity", async () => {
		const result = await detectNativeAccount(makePorts());
		expect(result).toEqual({
			accountUuid: NATIVE_UUID,
			token: "tok-native",
			identity: { email: "cole@icloud.com", displayName: "Cole" },
			subscriptionType: "claude_max",
			rateLimitTier: "unknown",
		});
	});

	it("reads the Safe Storage key by the documented service + account", async () => {
		const readKeychainPassword = vi.fn(() => Promise.resolve(PASSWORD));
		await detectNativeAccount(makePorts({ readKeychainPassword }));
		expect(readKeychainPassword).toHaveBeenCalledWith(SAFE_STORAGE_SERVICE, SAFE_STORAGE_ACCOUNT);
	});

	it("skips a token whose profile does not match and picks the one that does", async () => {
		// Two cached tokens for two different real accounts; only the second is the
		// native one. Detection must not stop at the first.
		const result = await detectNativeAccount(
			makePorts({
				cacheTokens: ["tok-other", "tok-native"],
				profiles: {
					"tok-other": okProfile(OTHER_UUID),
					"tok-native": okProfile(NATIVE_UUID),
				},
			}),
		);
		expect(result?.accountUuid).toBe(NATIVE_UUID);
		expect(result?.token).toBe("tok-native");
	});

	it("continues past a failed profile fetch to a matching token", async () => {
		const result = await detectNativeAccount(
			makePorts({
				cacheTokens: ["tok-bad", "tok-native"],
				profiles: {
					"tok-bad": { ok: false, kind: "unauthorized", detail: "revoked" },
					"tok-native": okProfile(NATIVE_UUID),
				},
			}),
		);
		expect(result?.token).toBe("tok-native");
	});

	it("omits identity fields the profile did not supply", async () => {
		const result = await detectNativeAccount(
			makePorts({
				profiles: {
					"tok-native": {
						ok: true,
						profile: {
							accountUuid: NATIVE_UUID as never,
							email: undefined,
							displayName: undefined,
							subscriptionType: "unknown",
							rateLimitTier: "unknown",
						},
					},
				},
			}),
		);
		expect(result?.identity).toEqual({});
	});
});

describe("detectNativeAccount — fail-closed exits", () => {
	it("no lastKnownAccountUuid → undefined (cannot identify the native account)", async () => {
		expect(await detectNativeAccount(makePorts({ lastKnown: undefined }))).toBeUndefined();
	});

	it("no Safe Storage key → undefined (cannot decrypt the cache)", async () => {
		expect(await detectNativeAccount(makePorts({ password: undefined }))).toBeUndefined();
	});

	it("tokenCacheV2 held no decryptable token → undefined", async () => {
		expect(await detectNativeAccount(makePorts({ cacheTokens: [] }))).toBeUndefined();
	});

	it("no cached token resolves to the marker → undefined (never guesses)", async () => {
		const result = await detectNativeAccount(
			makePorts({
				cacheTokens: ["tok-other"],
				profiles: { "tok-other": okProfile(OTHER_UUID) },
			}),
		);
		expect(result).toBeUndefined();
	});
});
