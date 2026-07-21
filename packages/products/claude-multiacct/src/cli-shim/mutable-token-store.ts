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
import { type ExecFileAsync, KEYCHAIN_SERVICE, SecurityCliTokenStore } from "./token-store.ts";

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

	async delete(accountUuid: AccountUuid): Promise<void> {
		try {
			await this.exec("security", [
				"delete-generic-password",
				"-s",
				KEYCHAIN_SERVICE,
				"-a",
				accountUuid,
			]);
		} catch {
			// Missing entry → no-op (idempotent per MutableTokenStore contract).
		}
	}
}
