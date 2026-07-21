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
 * Kept as a NEW port in a NEW file so we do not modify the PR2 surface.
 * PR6 will supply a concrete Keychain-backed `MutableTokenStore` (extending
 * `SecurityCliTokenStore`); this PR ships an in-memory impl for tests.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { TokenStore } from "../ports.ts";

/**
 * `TokenStore` extended with `delete`. Provisioning + CLI commands take
 * THIS type; the read-side shim continues to take the narrower `TokenStore`.
 */
export type MutableTokenStore = TokenStore & {
	/** Remove the token for `accountUuid`. Missing entry → no-op (idempotent). */
	delete(accountUuid: AccountUuid): Promise<void>;
};

/**
 * `InMemoryMutableTokenStore` — Map-backed impl for tests. `get` on a
 * missing uuid returns `undefined` (matching the `TokenStore` port's soft
 * miss); provisioning branches on `undefined` before calling `delete`.
 */
export class InMemoryMutableTokenStore implements MutableTokenStore {
	private readonly entries = new Map<string, string>();

	get(accountUuid: AccountUuid): Promise<string | undefined> {
		return Promise.resolve(this.entries.get(accountUuid));
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		this.entries.set(accountUuid, encryptedTokenRef);
		return Promise.resolve();
	}

	delete(accountUuid: AccountUuid): Promise<void> {
		this.entries.delete(accountUuid);
		return Promise.resolve();
	}

	/**
	 * Test helper — expose the internal state read-only.
	 *
	 * @returns {Record<string, string>} Plain-object copy of the store.
	 */
	snapshot(): Record<string, string> {
		return Object.fromEntries(this.entries);
	}
}
