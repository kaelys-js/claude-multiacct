/* eslint-disable vitest/no-conditional-in-test, vitest/require-to-throw-message, no-bitwise, eslint/no-bitwise, eslint/operator-assignment, unicorn/prefer-at, jsdoc/require-returns, jsdoc/require-param */
/**
 * Intent: `FileTokenStore` is the fallback when Keychain writes require
 * interactive unlock. It MUST round-trip tokens losslessly, generate its
 * keystore key on first use (mode 0600), reject corrupted files loud
 * (Rule 12), and cleanly delete entries. `LayeredTokenStore` MUST
 * transparently fall back on the specific "user interaction not
 * allowed" keychain error but NOT on unrelated failures.
 *
 * Adversarial: remove the interaction-error pattern check and unrelated
 * primary-store failures start silently promoting to secondary — the
 * "does NOT fall back on unrelated errors" test flips RED. Remove the
 * decrypt auth-tag verify and a corrupted file silently returns garbage
 * — the "corrupted file throws loud" test flips RED.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { TokenRecord } from "../ports.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";
import {
	defaultKeystoreKeyPath,
	defaultRoot,
	FileTokenStore,
	tokenPath,
} from "./file-token-store.ts";
import { isKeychainInteractionError, LayeredTokenStore } from "./layered-token-store.ts";
import type { FetchImpl } from "./refresh.ts";

const UUID_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as AccountUuid;
const UUID_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" as AccountUuid;

async function mkStore(): Promise<{ root: string; keyPath: string; store: FileTokenStore }> {
	const root = await mkdtemp(join(tmpdir(), "cma-fts-"));
	const keyPath = join(root, "keystore.key");
	const store = new FileTokenStore(root, keyPath);
	return { root, keyPath, store };
}

describe("FileTokenStore", () => {
	it("round-trips a token losslessly", async () => {
		const { store } = await mkStore();
		const token = "sk-ant-oat01-example-fixture-secret-not-real";
		await store.put(UUID_A, token);
		expect(await store.get(UUID_A)).toBe(token);
	});

	it("creates keystore.key with mode 0600 on first put", async () => {
		const { keyPath, store } = await mkStore();
		await store.put(UUID_A, "t");
		const s = await stat(keyPath);
		expect(s.mode & 0o777).toBe(0o600);
		const key = await readFile(keyPath);
		expect(key.length).toBe(32);
	});

	it("creates token file with mode 0600", async () => {
		const { root, store } = await mkStore();
		await store.put(UUID_A, "t");
		const s = await stat(tokenPath(root, UUID_A));
		expect(s.mode & 0o777).toBe(0o600);
	});

	it("stores different accounts under distinct files", async () => {
		const { store } = await mkStore();
		await store.put(UUID_A, "token-a");
		await store.put(UUID_B, "token-b");
		expect(await store.get(UUID_A)).toBe("token-a");
		expect(await store.get(UUID_B)).toBe("token-b");
	});

	it("delete removes the entry; subsequent get throws", async () => {
		const { store } = await mkStore();
		await store.put(UUID_A, "t");
		await store.delete(UUID_A);
		await expect(store.get(UUID_A)).rejects.toThrow(/no entry for/u);
	});

	it("delete on missing entry is idempotent (no throw)", async () => {
		const { store } = await mkStore();
		await expect(store.delete(UUID_A)).resolves.toBeUndefined();
	});

	it("throws loud on a corrupted token file (auth-tag verify catches tampering)", async () => {
		const { root, store } = await mkStore();
		await store.put(UUID_A, "t");
		const path = tokenPath(root, UUID_A);
		const raw = await readFile(path);
		// Flip a byte in the ciphertext region.
		raw[16] = raw[16]! ^ 0xff;
		await writeFile(path, raw);
		await expect(store.get(UUID_A)).rejects.toThrow(/decrypt failed/u);
	});

	it("throws loud on a truncated token file (shorter than iv+tag)", async () => {
		const { root, store } = await mkStore();
		await store.put(UUID_A, "t");
		const path = tokenPath(root, UUID_A);
		await writeFile(path, Buffer.from([0x01, 0x02]));
		await expect(store.get(UUID_A)).rejects.toThrow(/truncated/u);
	});

	it("throws loud on a wrong-length keystore.key", async () => {
		const { keyPath } = await mkStore();
		await mkdir(join(keyPath, ".."), { recursive: true });
		await writeFile(keyPath, Buffer.from([0x01, 0x02, 0x03]), { mode: 0o600 });
		const store = new FileTokenStore(join(keyPath, ".."), keyPath);
		await expect(store.put(UUID_A, "t")).rejects.toThrow(/wrong length/u);
	});

	it("throws loud when keystore.key is unreadable for a reason other than ENOENT", async () => {
		// getKey generates a fresh key only on ENOENT. Any other read failure (here:
		// the key path is actually a directory → EISDIR) must surface, not be
		// swallowed into a silent new-key generation that would orphan every token
		// already encrypted under the real key. Drop the `code !== "ENOENT"` guard
		// and this write would succeed against a bogus key — RED.
		const root = await mkdtemp(join(tmpdir(), "cma-fts-"));
		const keyPath = join(root, "keystore.key");
		await mkdir(keyPath, { recursive: true });
		const store = new FileTokenStore(root, keyPath);
		await expect(store.put(UUID_A, "t")).rejects.toThrow(/keystore\.key unreadable/u);
	});
});

describe("file-token-store default paths", () => {
	it("defaultRoot resolves under ~/.config/claude-multiacct", () => {
		expect(defaultRoot()).toBe(join(homedir(), ".config", "claude-multiacct"));
	});

	it("defaultKeystoreKeyPath is keystore.key inside the default root", () => {
		expect(defaultKeystoreKeyPath()).toBe(join(defaultRoot(), "keystore.key"));
	});
});

describe("isKeychainInteractionError", () => {
	it("matches the exact macOS error string", () => {
		expect(
			isKeychainInteractionError(
				new Error("SecKeychainItemCreateFromContent (<default>): User interaction is not allowed."),
			),
		).toBe(true);
	});
	it("matches the shorter fragment", () => {
		expect(isKeychainInteractionError(new Error("User interaction is not allowed"))).toBe(true);
	});
	it("does NOT match unrelated errors", () => {
		expect(isKeychainInteractionError(new Error("keychain not found"))).toBe(false);
		expect(isKeychainInteractionError(new Error("network unreachable"))).toBe(false);
	});
	it("returns false for non-Error values", () => {
		expect(isKeychainInteractionError("string")).toBe(false);
		expect(isKeychainInteractionError(undefined)).toBe(false);
	});
});

class ThrowingStore implements MutableTokenStore {
	private readonly onPut: () => never;
	constructor(onPut: () => never) {
		this.onPut = onPut;
	}
	get(): Promise<string> {
		return Promise.reject(new Error("not-found"));
	}
	put(): Promise<void> {
		this.onPut();
	}
	getRecord(): Promise<TokenRecord | undefined> {
		return Promise.reject(new Error("not-found"));
	}
	putRecord(): Promise<void> {
		this.onPut();
	}
	delete(): Promise<void> {
		return Promise.resolve();
	}
}

describe("LayeredTokenStore", () => {
	it("uses primary when primary put succeeds", async () => {
		const primaryStore = await mkStore();
		const secondaryStore = await mkStore();
		const layered = new LayeredTokenStore(primaryStore.store, secondaryStore.store);
		await layered.put(UUID_A, "t");
		expect(await primaryStore.store.get(UUID_A)).toBe("t");
		await expect(secondaryStore.store.get(UUID_A)).rejects.toThrow();
	});

	it("falls back to secondary on User-interaction-not-allowed primary put failure", async () => {
		const secondary = await mkStore();
		const primary = new ThrowingStore(() => {
			throw new Error(
				"SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.",
			);
		});
		const layered = new LayeredTokenStore(primary, secondary.store);
		await layered.put(UUID_A, "fallback-token");
		expect(await secondary.store.get(UUID_A)).toBe("fallback-token");
	});

	it("does NOT fall back on unrelated primary put failures — the class-boundary matters", async () => {
		const secondary = await mkStore();
		const primary = new ThrowingStore(() => {
			throw new Error("network unreachable");
		});
		const layered = new LayeredTokenStore(primary, secondary.store);
		await expect(layered.put(UUID_A, "t")).rejects.toThrow(/network unreachable/u);
		// Nothing landed in secondary.
		await expect(secondary.store.get(UUID_A)).rejects.toThrow();
	});

	it("reads primary first, falls back to secondary on primary get failure", async () => {
		const primaryStore = await mkStore();
		const secondaryStore = await mkStore();
		await secondaryStore.store.put(UUID_A, "in-secondary");
		const layered = new LayeredTokenStore(primaryStore.store, secondaryStore.store);
		expect(await layered.get(UUID_A)).toBe("in-secondary");
	});

	it("delete removes from both stores (idempotent when either is empty)", async () => {
		const primary = await mkStore();
		const secondary = await mkStore();
		await primary.store.put(UUID_A, "p");
		// secondary is empty
		const layered = new LayeredTokenStore(primary.store, secondary.store);
		await layered.delete(UUID_A);
		await expect(primary.store.get(UUID_A)).rejects.toThrow();
		await expect(secondary.store.get(UUID_A)).rejects.toThrow();
	});

	it("putRecord uses primary when it succeeds; getRecord reads it back from primary", async () => {
		const primaryStore = await mkStore();
		const secondaryStore = await mkStore();
		const layered = new LayeredTokenStore(primaryStore.store, secondaryStore.store);
		const rec = { accessToken: "at", refreshToken: "rt", expiresAt: "2099-01-01T00:00:00.000Z" };
		await layered.putRecord(UUID_A, rec);
		expect(await primaryStore.store.getRecord(UUID_A)).toStrictEqual(rec);
		expect(await secondaryStore.store.getRecord(UUID_A)).toBeUndefined();
		// Read back THROUGH the layered store so the primary-hit branch of
		// getRecord (return the defined primary record) is exercised.
		expect(await layered.getRecord(UUID_A)).toStrictEqual(rec);
	});

	it("putRecord falls back to secondary on a keychain-interaction primary failure", async () => {
		const secondary = await mkStore();
		const primary = new ThrowingStore(() => {
			throw new Error(
				"SecKeychainItemCreateFromContent (<default>): User interaction is not allowed.",
			);
		});
		const layered = new LayeredTokenStore(primary, secondary.store);
		const rec = { accessToken: "fallback", refreshToken: "rt" };
		await layered.putRecord(UUID_A, rec);
		expect(await secondary.store.getRecord(UUID_A)).toStrictEqual(rec);
	});

	it("putRecord does NOT fall back on an unrelated primary failure (class-boundary)", async () => {
		const secondary = await mkStore();
		const primary = new ThrowingStore(() => {
			throw new Error("network unreachable");
		});
		const layered = new LayeredTokenStore(primary, secondary.store);
		await expect(layered.putRecord(UUID_A, { accessToken: "t" })).rejects.toThrow(
			/network unreachable/u,
		);
		expect(await secondary.store.getRecord(UUID_A)).toBeUndefined();
	});

	it("getRecord falls back to secondary when primary MISSES (undefined, no throw)", async () => {
		const primaryStore = await mkStore();
		const secondaryStore = await mkStore();
		const rec = { accessToken: "in-secondary", refreshToken: "rt" };
		await secondaryStore.store.putRecord(UUID_A, rec);
		const layered = new LayeredTokenStore(primaryStore.store, secondaryStore.store);
		expect(await layered.getRecord(UUID_A)).toStrictEqual(rec);
	});

	it("getRecord falls back to secondary when primary THROWS", async () => {
		const secondary = await mkStore();
		const rec = { accessToken: "in-secondary", refreshToken: "rt" };
		await secondary.store.putRecord(UUID_A, rec);
		// ThrowingStore.getRecord rejects, exercising the catch branch.
		const primary = new ThrowingStore(() => {
			throw new Error("unused");
		});
		const layered = new LayeredTokenStore(primary, secondary.store);
		expect(await layered.getRecord(UUID_A)).toStrictEqual(rec);
	});
});

async function tmpRoot(): Promise<{ root: string; keyPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "cma-fts-rec-"));
	return { root, keyPath: join(root, "keystore.key") };
}

// Encrypt an arbitrary plaintext under the store's key, mimicking whatever a
// prior install may have written (a bare token string, or non-record JSON).
async function writeCipher(root: string, keyPath: string, plaintext: string): Promise<void> {
	const key = await readFile(keyPath);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	const tag = cipher.getAuthTag();
	await writeFile(tokenPath(root, UUID_A), Buffer.concat([iv, ct, tag]), { mode: 0o600 });
}

const okFetch =
	(body: unknown): FetchImpl =>
	() =>
		Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
const rejectFetch: FetchImpl = () => Promise.reject(new Error("network down"));
const nonOkFetch: FetchImpl = () =>
	Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve("boom") });
const neverFetch: FetchImpl = () => Promise.reject(new Error("must not be called"));

describe("FileTokenStore — record surface, backward-compat, refresh-on-read", () => {
	it("putRecord + getRecord round-trips the full bag", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		const rec = { accessToken: "at", refreshToken: "rt", expiresAt: "2099-01-01T00:00:00.000Z" };
		await store.putRecord(UUID_A, rec);
		expect(await store.getRecord(UUID_A)).toStrictEqual(rec);
	});

	it("get returns the record's accessToken", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		await store.putRecord(UUID_A, {
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("at");
	});

	it("reads a LEGACY bare-string token file back as {accessToken} (backward-compat)", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		await store.put(UUID_A, "seed"); // generates keystore.key
		const bare = "sk-ant-oat01-legacy-bare-not-json";
		await writeCipher(root, keyPath, bare);
		expect(await store.get(UUID_A)).toBe(bare);
		expect(await store.getRecord(UUID_A)).toStrictEqual({ accessToken: bare });
	});

	it("reads valid-JSON-but-not-a-record plaintext as a bare token", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		await store.put(UUID_A, "seed");
		await writeCipher(root, keyPath, "12345"); // valid JSON (number) → not a record
		expect(await store.getRecord(UUID_A)).toStrictEqual({ accessToken: "12345" });
	});

	it("treats a record with an empty accessToken as a bare token", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		await store.putRecord(UUID_A, { accessToken: "" });
		expect(await store.getRecord(UUID_A)).toStrictEqual({ accessToken: '{"accessToken":""}' });
	});

	it("get REFRESHES an expired record, persists + returns the new token", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: okFetch({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
			}),
			endpoint: "https://token.test/oauth",
			clientId: "cid",
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "old-access",
			refreshToken: "old-refresh",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("new-access");
		const persisted = await store.getRecord(UUID_A);
		expect(persisted?.accessToken).toBe("new-access");
		expect(persisted?.refreshToken).toBe("new-refresh");
		expect(persisted?.expiresAt).toBeDefined();
	});

	it("refresh response lacking refresh_token/expires_in persists only the new access token", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: okFetch({ access_token: "just-access" }),
			endpoint: "https://token.test/oauth",
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "old",
			refreshToken: "rt",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("just-access");
		expect(await store.getRecord(UUID_A)).toStrictEqual({ accessToken: "just-access" });
	});

	it("refresh whose fetch REJECTS returns the stale token and does not throw", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: rejectFetch,
			endpoint: "https://token.test/oauth",
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "stale",
			refreshToken: "rt",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("stale");
		const staleRecord = await store.getRecord(UUID_A);
		expect(staleRecord?.accessToken).toBe("stale");
	});

	it("refresh returning a non-ok HTTP status returns the stale token", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: nonOkFetch,
			endpoint: "https://token.test/oauth",
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "stale2",
			refreshToken: "rt",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("stale2");
	});

	it("returns the stale token if persisting the refreshed record throws (never throws)", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: okFetch({ access_token: "new-access", refresh_token: "nr", expires_in: 3600 }),
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "stale3",
			refreshToken: "rt",
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		store.putRecord = (): Promise<void> => Promise.reject(new Error("disk full"));
		expect(await store.get(UUID_A)).toBe("stale3");
	});

	it("does NOT refresh when the record is not yet expired", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: neverFetch,
			now: (): number => Date.parse("2020-01-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, {
			accessToken: "fresh",
			refreshToken: "rt",
			expiresAt: "2099-01-01T00:00:00.000Z",
		});
		expect(await store.get(UUID_A)).toBe("fresh");
	});

	it("does NOT refresh a record that has a refreshToken but no expiresAt", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath, {
			fetchImpl: neverFetch,
			now: (): number => Date.parse("2099-06-01T00:00:00.000Z"),
		});
		await store.putRecord(UUID_A, { accessToken: "noexp", refreshToken: "rt" });
		expect(await store.get(UUID_A)).toBe("noexp");
	});

	it("getRecord returns undefined when the file is missing (ENOENT)", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		expect(await store.getRecord(UUID_A)).toBeUndefined();
	});

	it("getRecord throws on a non-ENOENT read error (token path is a directory)", async () => {
		const { root, keyPath } = await tmpRoot();
		const store = new FileTokenStore(root, keyPath);
		await mkdir(tokenPath(root, UUID_A), { recursive: true });
		await expect(store.getRecord(UUID_A)).rejects.toThrow(/read failed/u);
	});
});
