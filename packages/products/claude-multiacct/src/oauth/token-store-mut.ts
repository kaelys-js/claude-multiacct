/**
 * `@foundation/claude-multiacct` — mutable `TokenStore` port.
 *
 * PR2's `TokenStore` (`../ports.ts`) has `get` + `put` — enough for the
 * runtime shim, which never removes tokens. PR4 introduces provisioning,
 * which must be able to DELETE a stored token for the atomic-rollback
 * contract (see `./provisioning.ts`): if the registry write fails after the
 * token store succeeded, the pipeline undoes the token write to avoid an
 * orphan credential in the keychain.
 *
 * A pooled OAuth account needs more than its access token to stay alive: the
 * access token expires in about an hour and can only be renewed with the
 * account's `refreshToken` + `expiresAt`. So the mutable port also carries a
 * RECORD surface (`getRecord` / `putRecord`) that reads and writes the whole
 * `TokenRecord` bag. `get` / `put` remain the access-token-only convenience
 * views the shim reads through.
 *
 * Kept as a NEW port in a NEW file so we do not modify the PR2 surface.
 * PR6 will supply a concrete Keychain-backed `MutableTokenStore` (extending
 * `SecurityCliTokenStore`); this PR ships an in-memory impl for tests.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { TokenRecord, TokenStore } from "../ports.ts";

/**
 * `TokenStore` extended with `delete` plus the full-record surface. `getRecord`
 * / `putRecord` read and write the whole `TokenRecord` (access + refresh +
 * expiry); provisioning + CLI commands take THIS type, the read-side shim
 * continues to take the narrower `TokenStore`.
 */
export type MutableTokenStore = TokenStore & {
	/** Remove the token for `accountUuid`. Missing entry → no-op (idempotent). */
	delete(accountUuid: AccountUuid): Promise<void>;
	/** Read the full credential bag, or `undefined` when there is no entry. */
	getRecord(accountUuid: AccountUuid): Promise<TokenRecord | undefined>;
	/** Write the full credential bag for `accountUuid`. */
	putRecord(accountUuid: AccountUuid, record: TokenRecord): Promise<void>;
};

/**
 * `InMemoryMutableTokenStore` — Map-backed impl for tests. State is keyed on
 * the full `TokenRecord`; `get` on a missing uuid returns `undefined` (matching
 * the `TokenStore` port's soft miss), and `getRecord` mirrors that. `put`
 * stores an access-token-only record; provisioning branches on `undefined`
 * before calling `delete`.
 */
export class InMemoryMutableTokenStore implements MutableTokenStore {
	private readonly entries = new Map<string, TokenRecord>();

	get(accountUuid: AccountUuid): Promise<string | undefined> {
		return Promise.resolve(this.entries.get(accountUuid)?.accessToken);
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		this.entries.set(accountUuid, { accessToken: encryptedTokenRef });
		return Promise.resolve();
	}

	getRecord(accountUuid: AccountUuid): Promise<TokenRecord | undefined> {
		return Promise.resolve(this.entries.get(accountUuid));
	}

	putRecord(accountUuid: AccountUuid, record: TokenRecord): Promise<void> {
		this.entries.set(accountUuid, record);
		return Promise.resolve();
	}

	delete(accountUuid: AccountUuid): Promise<void> {
		this.entries.delete(accountUuid);
		return Promise.resolve();
	}

	/**
	 * Test helper — expose the internal state read-only as access-token values,
	 * preserving the pre-record snapshot shape.
	 *
	 * @returns {Record<string, string>} Plain-object copy of the accessToken values.
	 */
	snapshot(): Record<string, string> {
		return Object.fromEntries(
			[...this.entries].map(([uuid, record]) => [uuid, record.accessToken]),
		);
	}
}
