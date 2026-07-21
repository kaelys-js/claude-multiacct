/**
 * `@foundation/claude-multiacct` — in-memory `TokenStore` for tests.
 *
 * Split from `./token-store.ts` because the runtime adapter (Keychain via
 * the `security` CLI) is a second class in the same file — oxlint's
 * `max-classes-per-file` gets grumpy. The two live side by side and
 * `token-store.ts` re-exports this class so the import surface is one file.
 *
 * `get` on a missing uuid THROWS with the uuid in the message (Rule 12).
 * The port's `get` signature allows `undefined` for soft-miss, but the
 * shim's runtime only calls it AFTER resolving a choice — a miss at that
 * point is an invariant violation, not a soft case.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { TokenStore } from "../ports.ts";

/** Map-backed `TokenStore` for tests. Throws on unknown uuid (fail loud). */
export class InMemoryTokenStore implements TokenStore {
	private readonly entries = new Map<string, string>();

	get(accountUuid: AccountUuid): Promise<string> {
		const value = this.entries.get(accountUuid);
		if (value === undefined) {
			return Promise.reject(new Error(`TokenStore: no token for account ${accountUuid}`));
		}
		return Promise.resolve(value);
	}

	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		this.entries.set(accountUuid, encryptedTokenRef);
		return Promise.resolve();
	}
}
