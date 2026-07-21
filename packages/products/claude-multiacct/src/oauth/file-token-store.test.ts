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

import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";
import {
	defaultKeystoreKeyPath,
	defaultRoot,
	FileTokenStore,
	tokenPath,
} from "./file-token-store.ts";
import { isKeychainInteractionError, LayeredTokenStore } from "./layered-token-store.ts";

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
});
