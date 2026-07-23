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
	/** Keychain + config.json IO for the active-token derivation. */
	activeTokenPorts: ActiveTokenPorts;
	/**
	 * Store the tokens currently live in — the keychain pool the discovery flow
	 * writes. This is the SOURCE of the mirror and the store the active-account
	 * sha match reads from.
	 */
	readStore: Pick<TokenStore, "get">;
	/**
	 * Store the shim reads (the encrypted `FileTokenStore`) — the DESTINATION of
	 * the mirror. The shim only looks here, so a token must land here to be
	 * swappable.
	 */
	writeStore: Pick<MutableTokenStore, "put">;
};

/**
 * Mirror the token Claude.app is CURRENTLY authenticated as into the store the
 * shim reads, so a session can be switched TO that account.
 *
 * The native/primary account (and any account discovered from Claude.app's own
 * login) has its token in the keychain pool, but the shim reads only the
 * `FileTokenStore` — so `FileTokenStore.get(nativeUuid)` misses and a choice
 * pinning a session to that account silently passes through instead of
 * switching. This closes the gap: the gui-session companion (the only context
 * that can read `Claude Safe Storage`) resolves which pooled account is live
 * (the same positive sha match `resolveActiveAccount` uses), reads that
 * account's token from the keychain pool, and writes it into the FileTokenStore.
 * It runs on every companion fire (login + on Claude's config.json change), so
 * the mirrored token refreshes as Claude.app rotates it.
 *
 * Fail-closed: no confident active match, or the matched account's token not
 * being readable from the source store, both resolve to `{ pooledUuid: null }`
 * and write nothing.
 *
 * @param {PoolActiveTokenDeps} deps - Registry + injected keychain/token IO.
 * @returns {Promise<{ pooledUuid: string | null }>} The mirrored account uuid, or `null`.
 */
export async function poolActiveToken(
	deps: PoolActiveTokenDeps,
): Promise<{ pooledUuid: string | null }> {
	const resolved = await resolveActiveAccount({
		registry: deps.registry,
		activeTokenPorts: deps.activeTokenPorts,
		tokenStore: deps.readStore,
	});
	if (resolved.activeUuid === null) {
		return { pooledUuid: null };
	}
	const activeUuid = resolved.activeUuid as AccountUuid;
	let token: string | undefined;
	try {
		token = await deps.readStore.get(activeUuid);
	} catch {
		// Source unreadable — leave undefined and fail closed below.
	}
	if (typeof token !== "string") {
		return { pooledUuid: null };
	}
	await deps.writeStore.put(activeUuid, token);
	return { pooledUuid: resolved.activeUuid };
}
