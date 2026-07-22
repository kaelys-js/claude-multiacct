/**
 * `@foundation/claude-multiacct` — Keychain-backed `MutableTokenStore`.
 *
 * Extends `SecurityCliTokenStore` with `delete`, satisfying the
 * `MutableTokenStore` contract that `provisionAccount` needs for its
 * atomic-rollback (see `oauth/provisioning.ts`): if the registry write
 * fails after the token write succeeded, the pipeline calls `delete` to
 * avoid a keychain credential with no registry account referencing it.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountUuid } from "../domain/account.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
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

	get(accountUuid: AccountUuid): Promise<string> {
		return this.base.get(accountUuid);
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		return this.base.put(accountUuid, encryptedTokenRef);
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
