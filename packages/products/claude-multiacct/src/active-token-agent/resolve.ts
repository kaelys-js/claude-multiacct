/**
 * `@foundation/claude-multiacct` — active-account resolution for the companion.
 *
 * This is the gui-session half of the fix. It runs the SAME derivation the
 * daemon used to run inline (`discovery/active-token.ts` +
 * `domain/registry.ts::getPrimary`), but from a keychain-capable context, and
 * returns a plain data record the companion writes to the IPC file.
 *
 * Why the resolution moved OUT of the daemon: under `SessionCreate=true` the
 * daemon can read neither the `Claude Safe Storage` key (needed for the active
 * marker) nor the `com.claude-multiacct.tokens` pool tokens (needed to hash each
 * account) — both are login-keychain items. So BOTH halves of the match have to
 * happen here, in the session that can see the keychain. The companion emits the
 * finished uuid; the daemon only reads it.
 *
 * The `activeUuid` we emit is a POSITIVE match only: the account whose stored
 * token sha256 equals Claude.app's live token sha256. When there is no live sha
 * (Safe Storage unreadable / unresolvable) or no pooled account holds it, we
 * emit `null` and let the daemon apply its own first-account fallback. This
 * keeps the fallback in one place (the daemon's `getPrimary` call) instead of
 * baking a guess into the file.
 *
 * @module
 */

import {
	currentActiveEntry,
	currentActiveTokenSha,
	type ActiveTokenPorts,
	tokenShasFromStore,
} from "../discovery/active-token.ts";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
import type { TokenStore } from "../ports.ts";

/** Injected dependencies `resolveActiveAccount` needs. */
export type ResolveActiveAccountDeps = {
	/** The current account pool (already read from disk by the caller). */
	registry: AccountRegistry;
	/** Keychain + config.json IO for `currentActiveTokenSha`. */
	activeTokenPorts: ActiveTokenPorts;
	/** Per-account token reader for `tokenShasFromStore`. */
	tokenStore: Pick<TokenStore, "get">;
};

/** The resolution result the companion publishes. */
export type ResolvedActiveAccount = {
	/** Positively-matched account uuid, or `null` when none matched. */
	activeUuid: string | null;
	/** Claude.app's live token sha256 (hex), or `null` when undeterminable. */
	activeTokenSha: string | null;
};

/**
 * Resolve which pooled account Claude.app is currently authenticated as.
 *
 * 1. Derive the live token sha via `currentActiveTokenSha`. `undefined` (no
 *    keychain key, no config, ambiguous cache) → no confident answer, emit
 *    both fields `null` and skip the pool-token reads entirely.
 * 2. Hash every pooled account's stored token, then return the account whose
 *    sha equals the live sha. No such account → `activeUuid: null` (but keep
 *    the live sha for observability).
 *
 * @param {ResolveActiveAccountDeps} deps - Registry + injected keychain/token IO.
 * @returns {Promise<ResolvedActiveAccount>} The positive match, or nulls.
 */
export async function resolveActiveAccount(
	deps: ResolveActiveAccountDeps,
): Promise<ResolvedActiveAccount> {
	const activeSha = await currentActiveTokenSha(deps.activeTokenPorts);
	if (activeSha === undefined) {
		return { activeUuid: null, activeTokenSha: null };
	}
	const shaByUuid = await tokenShasFromStore(deps.registry, deps.tokenStore);
	const matched = deps.registry.accounts.find((a) => shaByUuid.get(a.uuid) === activeSha);
	return { activeUuid: matched?.uuid ?? null, activeTokenSha: activeSha };
}

/** Injected dependencies `poolActiveToken` needs. */
export type PoolActiveTokenDeps = {
	/** The current account pool (already read from disk by the caller). */
	registry: AccountRegistry;
	/** Keychain + config.json IO for `currentActiveEntry`. */
	activeTokenPorts: ActiveTokenPorts;
	/** Encrypted store to write the pooled token into (the shim reads it here). */
	tokenStore: Pick<MutableTokenStore, "put">;
};

/**
 * Capture the token Claude.app is CURRENTLY authenticated as into the pool, so
 * the shim can swap a session TO that account.
 *
 * The native/primary account is discovered from Claude.app's own login, but the
 * explicit `cma add` flow never stores its token — so `TokenStore.get(nativeUuid)`
 * misses and a choice pinning a session to the primary account silently passes
 * through instead of switching. This closes that gap: the gui-session companion
 * (the only context that can read `Claude Safe Storage`) reads the live entry,
 * finds the pool account whose Claude account uuid matches, and writes the token
 * into the same encrypted `FileTokenStore` the shim reads. It runs every time
 * the companion fires (login + on Claude's config.json change), so the pooled
 * token refreshes as Claude.app rotates it.
 *
 * Fail-closed: no live entry, an entry without an `accountUuid`, or no pool
 * account matching that uuid all resolve to `{ pooledUuid: null }` and write
 * nothing. Matching is on the real Claude account uuid (`accountUuid`, falling
 * back to `uuid` for records minted before the field existed).
 *
 * @param {PoolActiveTokenDeps} deps - Registry + injected keychain/token IO.
 * @returns {Promise<{ pooledUuid: string | null }>} The pooled account uuid, or `null`.
 */
export async function poolActiveToken(
	deps: PoolActiveTokenDeps,
): Promise<{ pooledUuid: string | null }> {
	const entry = await currentActiveEntry(deps.activeTokenPorts);
	if (entry === undefined || entry.accountUuid === undefined) {
		return { pooledUuid: null };
	}
	const account = deps.registry.accounts.find(
		(a) => (a.accountUuid ?? a.uuid) === entry.accountUuid,
	);
	if (account === undefined) {
		return { pooledUuid: null };
	}
	await deps.tokenStore.put(account.uuid as AccountUuid, entry.token);
	return { pooledUuid: account.uuid };
}
