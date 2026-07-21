/**
 * `@foundation/claude-multiacct` — file-backed `MutableTokenStore`.
 *
 * Fallback for `SecurityCliMutableTokenStore` when writing to macOS
 * Keychain requires interactive unlock and the process is running non-
 * interactively (SSH session, daemon, launchd). `SecKeychainItemCreate`
 * refuses those writes with `User interaction is not allowed`; a keychain
 * failure that cascaded into the account-registration path would leave
 * the pool in a broken half-registered state. Fall back to a file store
 * so the flow always completes.
 *
 * Layout:
 *   - `~/.config/claude-multiacct/keystore.key` (mode 0600, 32 random
 *     bytes) — machine-local key. Never committed, never synced.
 *   - `~/.config/claude-multiacct/tokens/<accountUuid>` (mode 0600) —
 *     one file per token. Format: `[12-byte iv][ciphertext][16-byte tag]`.
 *     AES-256-GCM with the keystore key.
 *
 * On first put, `ensureKey` creates the keystore file with 32 random
 * bytes. Subsequent puts read the same key. Losing `keystore.key` means
 * every stored token is unreadable (rotate + re-register).
 *
 * @module
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountUuid } from "../domain/account.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";

/** Length of the AES-256-GCM key in bytes. */
const KEY_LEN = 32;
/** Length of the AES-256-GCM IV in bytes (Chromium/NIST default). */
const IV_LEN = 12;
/** Length of the AES-256-GCM authentication tag in bytes. */
const TAG_LEN = 16;

/**
 * Default root dir for the file token store.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/`.
 */
export function defaultRoot(): string {
	return join(homedir(), ".config", "claude-multiacct");
}

/**
 * Default path of the AES-256-GCM key file (32 random bytes, mode 0600).
 *
 * @returns {string} Absolute path.
 */
export function defaultKeystoreKeyPath(): string {
	return join(defaultRoot(), "keystore.key");
}

/**
 * Default per-uuid token file path.
 *
 * @param {string} root - Store root dir.
 * @param {AccountUuid} uuid - Account uuid.
 * @returns {string} Absolute path.
 */
export function tokenPath(root: string, uuid: AccountUuid): string {
	return join(root, "tokens", uuid);
}

/**
 * File-based `MutableTokenStore`. Encrypts every token with AES-256-GCM
 * using a machine-local key stored at `keystore.key`. Constructor takes
 * `rootDir` + `keyPath` so tests can point at tmp dirs.
 */
export class FileTokenStore implements MutableTokenStore {
	private readonly rootDir: string;
	private readonly keyPath: string;
	private cachedKey: Buffer | undefined;

	constructor(rootDir: string = defaultRoot(), keyPath: string = defaultKeystoreKeyPath()) {
		this.rootDir = rootDir;
		this.keyPath = keyPath;
	}

	async get(accountUuid: AccountUuid): Promise<string> {
		const file = tokenPath(this.rootDir, accountUuid);
		let raw: Buffer;
		try {
			raw = await readFile(file);
		} catch (error) {
			throw new Error(`FileTokenStore: no entry for ${accountUuid}`, { cause: error });
		}
		if (raw.length < IV_LEN + TAG_LEN) {
			throw new Error(
				`FileTokenStore: token file for ${accountUuid} is truncated (${String(raw.length)} bytes)`,
			);
		}
		const iv = raw.subarray(0, IV_LEN);
		const tag = raw.subarray(raw.length - TAG_LEN);
		const ciphertext = raw.subarray(IV_LEN, raw.length - TAG_LEN);
		const key = await this.getKey();
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		try {
			const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
			return plaintext.toString("utf8");
		} catch (error) {
			throw new Error(`FileTokenStore: decrypt failed for ${accountUuid}`, { cause: error });
		}
	}

	async put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		await mkdir(join(this.rootDir, "tokens"), { recursive: true });
		const key = await this.getKey();
		const iv = randomBytes(IV_LEN);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(Buffer.from(encryptedTokenRef, "utf8")),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		const combined = Buffer.concat([iv, ciphertext, tag]);
		await writeFile(tokenPath(this.rootDir, accountUuid), combined, { mode: 0o600 });
	}

	async delete(accountUuid: AccountUuid): Promise<void> {
		try {
			await rm(tokenPath(this.rootDir, accountUuid), { force: true });
		} catch {
			// Missing entry → idempotent no-op per MutableTokenStore contract.
		}
	}

	/**
	 * Materialize the AES-256-GCM key from disk; generate + persist a new
	 * one if the file is missing. Cached per-instance after first read.
	 *
	 * @returns {Promise<Buffer>} The 32-byte key.
	 */
	private async getKey(): Promise<Buffer> {
		if (this.cachedKey !== undefined) {
			return this.cachedKey;
		}
		let key: Buffer;
		try {
			key = await readFile(this.keyPath);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code !== "ENOENT") {
				throw new Error(`FileTokenStore: keystore.key unreadable`, { cause: error });
			}
			key = randomBytes(KEY_LEN);
			await mkdir(this.rootDir, { recursive: true });
			await writeFile(this.keyPath, key, { mode: 0o600 });
		}
		if (key.length !== KEY_LEN) {
			throw new Error(
				`FileTokenStore: keystore.key is wrong length (expected ${String(KEY_LEN)}, got ${String(key.length)})`,
			);
		}
		this.cachedKey = key;
		return key;
	}
}
