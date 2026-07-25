/**
 * `@foundation/claude-multiacct` — Keychain-backed `MutableTokenStore`.
 *
 * Extends `SecurityCliTokenStore` with `delete`, satisfying the
 * `MutableTokenStore` contract that `provisionAccount` needs for its
 * atomic-rollback (see `oauth/provisioning.ts`): if the registry write
 * fails after the token write succeeded, the pipeline calls `delete` to
 * avoid a keychain credential with no registry account referencing it.
 *
 * The keychain secret holds a JSON `TokenRecord`, encoded and decoded through
 * the codec `FileTokenStore` uses (`oauth/token-record.ts`), so the two back
 * ends behind `LayeredTokenStore` store the same bytes. A secret written by a
 * build that predated the record format is a bare access-token string and still
 * decodes, so no migration is needed on upgrade.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountUuid } from "../domain/account.ts";
import { encodeTokenRecord, parseTokenRecord } from "../oauth/token-record.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
import type { TokenRecord } from "../ports.ts";
import {
	type ExecFileAsync,
	KEYCHAIN_SERVICE,
	parseKeychainServiceAccounts,
	SecurityCliTokenStore,
} from "./token-store.ts";

const defaultExecFile: ExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;

/** Keychain-backed MutableTokenStore. Wraps SecurityCliTokenStore + delete. */
export class SecurityCliMutableTokenStore implements MutableTokenStore {
	private readonly base: SecurityCliTokenStore;
	private readonly exec: ExecFileAsync;

	constructor(exec: ExecFileAsync = defaultExecFile) {
		this.base = new SecurityCliTokenStore(exec);
		this.exec = exec;
	}

	/**
	 * Access-token view over the keychain item. The stored secret is a JSON
	 * `TokenRecord`, so the raw secret is decoded before the access token is
	 * handed back — returning the JSON text itself would send a blob where
	 * callers expect a bearer token. A legacy bare-string secret decodes to
	 * itself, so a pre-record install reads exactly as it did before.
	 *
	 * @param {AccountUuid} accountUuid - Account to read.
	 * @returns {Promise<string>} The access token.
	 */
	async get(accountUuid: AccountUuid): Promise<string> {
		return parseTokenRecord(await this.base.get(accountUuid)).accessToken;
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		return this.putRecord(accountUuid, { accessToken: encryptedTokenRef });
	}

	/**
	 * Read the full credential bag from the keychain. The secret holds a JSON
	 * `TokenRecord` written by {@link putRecord}; a secret written by an older
	 * build is a bare access-token string and decodes to
	 * `{accessToken: <that string>}`, so an install that predates the record
	 * format keeps working without a migration step.
	 *
	 * @param {AccountUuid} accountUuid - Account to read.
	 * @returns {Promise<TokenRecord>} The stored record.
	 */
	async getRecord(accountUuid: AccountUuid): Promise<TokenRecord | undefined> {
		return parseTokenRecord(await this.base.get(accountUuid));
	}

	/**
	 * Persist the WHOLE record into the keychain as JSON, mirroring
	 * `FileTokenStore` byte-for-byte through the shared codec. An earlier build
	 * wrote only `record.accessToken` here and dropped `refreshToken` +
	 * `expiresAt` silently: any account provisioned through the keychain store
	 * lost the only material that can renew its access token, so it died the
	 * moment the ~1h token expired and needed a manual re-register. Production
	 * reads the file store, which kept the full record, so the loss was latent
	 * — it was still a data-loss path in a store the CLI can select.
	 *
	 * @param {AccountUuid} accountUuid - Account to write.
	 * @param {TokenRecord} record - The full credential bag to store.
	 * @returns {Promise<void>} Resolves once the keychain write completes.
	 */
	putRecord(accountUuid: AccountUuid, record: TokenRecord): Promise<void> {
		return this.base.put(accountUuid, encodeTokenRecord(record));
	}

	/**
	 * Enumerate the account uuids of every token item under THIS tool's
	 * dedicated keychain service. Reads `security dump-keychain` (attributes
	 * only — no `-d`, so no secret is decrypted and no prompt is raised) and
	 * filters to `KEYCHAIN_SERVICE`, so Anthropic's `Claude Safe Storage` item
	 * is structurally excluded. Used by the orphan-token prune.
	 *
	 * @returns {Promise<AccountUuid[]>} Account uuids of this service's items.
	 */
	async list(): Promise<AccountUuid[]> {
		const { stdout } = await this.exec("security", ["dump-keychain"]);
		return parseKeychainServiceAccounts(stdout, KEYCHAIN_SERVICE);
	}

	async delete(accountUuid: AccountUuid): Promise<void> {
		try {
			await this.exec("security", [
				"delete-generic-password",
				"-s",
				KEYCHAIN_SERVICE,
				"-a",
				accountUuid,
			]);
		} catch (error) {
			// Distinguish "already gone" from "could not touch the keychain".
			//
			//   - A missing item exits 44 (errSecItemNotFound): idempotent no-op
			//     per the MutableTokenStore contract.
			//   - Anything else (a locked keychain, a denied ACL) must PROPAGATE.
			//     `removeAccount` deletes the token before the registry write, so
			//     a swallowed failure here would leave the registry entry dropped
			//     while the credential lingers — the opposite of fail-closed. Let
			//     it throw: `removeAccount` maps it to `token_store_failed` and the
			//     registry stays intact.
			if (isItemNotFound(error)) {
				return;
			}
			throw new Error(`TokenStore: keychain delete failed for account ${accountUuid}`, {
				cause: error,
			});
		}
	}
}

/**
 * Is this `security` failure a "no such keychain item" (exit 44 /
 * errSecItemNotFound)? Match on the exit code first, then the CLI's message as
 * a fallback, so an already-removed token reads as an idempotent success while
 * a locked keychain (a different code) does not.
 *
 * @param {unknown} error - The value thrown by the injected `exec`.
 * @returns {boolean} True iff the error means the item was simply absent.
 */
function isItemNotFound(error: unknown): boolean {
	const { code } = error as { code?: number | string };
	if (code === 44 || code === "44") {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	const stderr = String((error as { stderr?: unknown }).stderr ?? "");
	return /could not be found|SecItemNotFound/iu.test(`${message} ${stderr}`);
}
