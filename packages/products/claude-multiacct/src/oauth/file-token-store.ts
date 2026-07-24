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
 * The encrypted plaintext is a JSON `TokenRecord` (`{accessToken,
 * refreshToken?, expiresAt?}`). Older installs wrote a BARE access-token
 * string; `parseRecord` reads both, so a legacy file still decodes to
 * `{accessToken: <that string>}`. Carrying the refresh token + expiry is
 * what lets `get` renew an expired access token in place instead of handing
 * the shim a dead credential.
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
import type { TokenRecord } from "../ports.ts";
import { CLAUDE_CODE_CLIENT_ID, CLAUDE_TOKEN_URL } from "./login.ts";
import { type FetchImpl, refreshTokens } from "./refresh.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";

/** Length of the AES-256-GCM key in bytes. */
const KEY_LEN = 32;
/** Length of the AES-256-GCM IV in bytes (Chromium/NIST default). */
const IV_LEN = 12;
/** Length of the AES-256-GCM authentication tag in bytes. */
const TAG_LEN = 16;

/**
 * Optional refresh wiring for {@link FileTokenStore}. Every field defaults to
 * the pinned Claude Code OAuth client + a real `globalThis.fetch` adapter, so
 * production callers construct the store with no third argument and still get
 * refresh-on-read; tests inject a fake `fetchImpl` + `now` to drive expiry.
 */
export type FileTokenStoreRefresh = {
	/** Injected `fetch`-shape (see `./refresh.ts`). Defaults to `globalThis.fetch`. */
	fetchImpl?: FetchImpl;
	/** OAuth token endpoint. Defaults to `CLAUDE_TOKEN_URL`. */
	endpoint?: string;
	/** OAuth `client_id`. Defaults to `CLAUDE_CODE_CLIENT_ID`. */
	clientId?: string;
	/** Injected clock in ms. Defaults to `Date.now`. */
	now?: () => number;
};

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
 * `rootDir` + `keyPath` so tests can point at tmp dirs, plus an optional
 * `refresh` bag so `get` can renew an expired access token on read.
 */
export class FileTokenStore implements MutableTokenStore {
	private readonly rootDir: string;
	private readonly keyPath: string;
	private cachedKey: Buffer | undefined;
	private readonly fetchImpl: FetchImpl;
	private readonly endpoint: string;
	private readonly clientId: string;
	private readonly now: () => number;

	constructor(
		rootDir: string = defaultRoot(),
		keyPath: string = defaultKeystoreKeyPath(),
		refresh?: FileTokenStoreRefresh,
	) {
		this.rootDir = rootDir;
		this.keyPath = keyPath;
		this.fetchImpl = refresh?.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
		this.endpoint = refresh?.endpoint ?? CLAUDE_TOKEN_URL;
		this.clientId = refresh?.clientId ?? CLAUDE_CODE_CLIENT_ID;
		this.now = refresh?.now ?? Date.now;
	}

	async get(accountUuid: AccountUuid): Promise<string> {
		const file = tokenPath(this.rootDir, accountUuid);
		let raw: Buffer;
		try {
			raw = await readFile(file);
		} catch (error) {
			throw new Error(`FileTokenStore: no entry for ${accountUuid}`, { cause: error });
		}
		const record = await this.decryptRecord(accountUuid, raw);
		return await this.refreshIfExpired(accountUuid, record);
	}

	async getRecord(accountUuid: AccountUuid): Promise<TokenRecord | undefined> {
		const file = tokenPath(this.rootDir, accountUuid);
		let raw: Buffer;
		try {
			raw = await readFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw new Error(`FileTokenStore: read failed for ${accountUuid}`, { cause: error });
		}
		return await this.decryptRecord(accountUuid, raw);
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		return this.putRecord(accountUuid, { accessToken: encryptedTokenRef });
	}

	async putRecord(accountUuid: AccountUuid, record: TokenRecord): Promise<void> {
		await mkdir(join(this.rootDir, "tokens"), { recursive: true });
		const key = await this.getKey();
		const iv = randomBytes(IV_LEN);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(Buffer.from(JSON.stringify(record), "utf8")),
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
	 * Decrypt a token file's bytes into a {@link TokenRecord}. Throws loud on a
	 * truncated file or an auth-tag mismatch (Rule 12) — a corrupted credential
	 * must not read back as silent garbage.
	 *
	 * @param {AccountUuid} accountUuid - The account (for error context).
	 * @param {Buffer} raw - The raw `[iv][ciphertext][tag]` bytes.
	 * @returns {Promise<TokenRecord>} The parsed record.
	 */
	private async decryptRecord(accountUuid: AccountUuid, raw: Buffer): Promise<TokenRecord> {
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
		let plaintext: string;
		try {
			plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
		} catch (error) {
			throw new Error(`FileTokenStore: decrypt failed for ${accountUuid}`, { cause: error });
		}
		return this.parseRecord(plaintext);
	}

	/**
	 * Parse decrypted plaintext into a {@link TokenRecord}. A well-formed JSON
	 * object with a non-empty string `accessToken` is taken as a record; ANY
	 * parse error or non-record shape is treated as a BARE legacy access token
	 * (`{accessToken: plaintext}`). This backward-compat path is load-bearing:
	 * installs that predate the record format hold raw token strings on disk.
	 *
	 * @param {string} plaintext - The decrypted UTF-8 plaintext.
	 * @returns {TokenRecord} The parsed record.
	 */
	private parseRecord(plaintext: string): TokenRecord {
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
	 * Renew an expired access token in place. When the record has both a
	 * `refreshToken` and an `expiresAt` that is at or past `now`, run the
	 * refresh grant; on success persist the new record and return its access
	 * token, on ANY failure return the stale access token (never throw — a
	 * refresh failure must not read worse than the pre-refresh behaviour).
	 *
	 * @param {AccountUuid} accountUuid - The account whose token to renew.
	 * @param {TokenRecord} record - The record just read from disk.
	 * @returns {Promise<string>} The fresh (or stale-on-failure) access token.
	 */
	private async refreshIfExpired(accountUuid: AccountUuid, record: TokenRecord): Promise<string> {
		const { refreshToken, expiresAt } = record;
		const expired =
			refreshToken !== undefined && expiresAt !== undefined && Date.parse(expiresAt) <= this.now();
		if (!expired) {
			return record.accessToken;
		}
		try {
			const result = await refreshTokens({
				refreshToken,
				fetchImpl: this.fetchImpl,
				endpoint: this.endpoint,
				clientId: this.clientId,
			});
			if (!result.ok) {
				return record.accessToken;
			}
			const next: TokenRecord = {
				accessToken: result.tokens.accessToken,
				...(result.tokens.refreshToken === undefined
					? {}
					: { refreshToken: result.tokens.refreshToken }),
				...(result.tokens.expiresAt === undefined ? {} : { expiresAt: result.tokens.expiresAt }),
			};
			await this.putRecord(accountUuid, next);
			return next.accessToken;
		} catch {
			return record.accessToken;
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
