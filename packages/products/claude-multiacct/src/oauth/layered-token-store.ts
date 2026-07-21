/**
 * `@foundation/claude-multiacct` — `LayeredTokenStore` primary+fallback wrapper.
 *
 * Try `primary.put()`; if it fails with the specific macOS keychain
 * "user interaction is not allowed" error, transparently fall back to
 * `secondary.put()`. Any other error propagates unchanged — the
 * class-boundary matters (Rule 12: fail loud on unrelated errors, not
 * silently promote them to the fallback).
 *
 * Reads prefer primary and fall back to secondary on primary's failure
 * so a token written to secondary during a locked-keychain session is
 * still readable later.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";

/**
 * True iff the error looks like the macOS keychain refusing an
 * interactive-required op from a non-interactive session.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {boolean} Whether the error matches the interaction-refusal pattern.
 */
export function isKeychainInteractionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return /user\s+interaction\s+is\s+not\s+allowed|SecKeychainItemCreateFromContent/iu.test(
		error.message,
	);
}

/**
 * `LayeredTokenStore` — try the primary store first, fall back to
 * secondary on write-failure patterns that indicate keychain-unlock
 * refusal. Reads always prefer primary (falls back to secondary on
 * primary's ENOENT-shaped failure), so a token written to secondary
 * during a locked-keychain session is still readable later.
 */
export class LayeredTokenStore implements MutableTokenStore {
	private readonly primary: MutableTokenStore;
	private readonly secondary: MutableTokenStore;

	constructor(primary: MutableTokenStore, secondary: MutableTokenStore) {
		this.primary = primary;
		this.secondary = secondary;
	}

	async get(accountUuid: AccountUuid): Promise<string | undefined> {
		try {
			return await this.primary.get(accountUuid);
		} catch {
			return await this.secondary.get(accountUuid);
		}
	}

	async put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		try {
			await this.primary.put(accountUuid, encryptedTokenRef);
		} catch (error) {
			if (isKeychainInteractionError(error)) {
				await this.secondary.put(accountUuid, encryptedTokenRef);
				return;
			}
			throw error;
		}
	}

	async delete(accountUuid: AccountUuid): Promise<void> {
		await Promise.all([
			(async (): Promise<void> => {
				try {
					await this.primary.delete(accountUuid);
				} catch {
					// idempotent
				}
			})(),
			(async (): Promise<void> => {
				try {
					await this.secondary.delete(accountUuid);
				} catch {
					// idempotent
				}
			})(),
		]);
	}
}
