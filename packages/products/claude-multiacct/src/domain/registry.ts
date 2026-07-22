/**
 * `@foundation/claude-multiacct` — AccountRegistry domain model.
 *
 * The registry is the on-disk source of truth for the pool: every configured
 * `Account`, plus two invariants the runtime relies on and cannot recover
 * from at call sites:
 *
 * 1. **Unique uuids.** UUIDs key every downstream store (choices, tokens,
 *    usage snapshots); a collision would silently overwrite one account's
 *    state with another's.
 * 2. **Unique labels.** The UI selects accounts by label; a duplicate label
 *    makes the human-facing picker ambiguous.
 *
 * Invariants are enforced inside the valibot schema via `v.check` on the
 * parsed object, so `v.parse(AccountRegistrySchema, input)` is the ONLY
 * validation entry point the rest of the codebase needs. That keeps
 * "is this registry valid?" a single well-defined question with a single
 * answer, rather than a schema-check plus a separately-invoked helper the
 * caller might forget to run.
 *
 * There is deliberately NO "exactly one primary" invariant. The active
 * account is no longer a stored flag the schema must police; it is DERIVED at
 * runtime by `getPrimary` as the account whose OAuth token-sha256 matches the
 * token Claude.app is currently authenticated as. That makes "which account is
 * active?" track reality (whatever Claude.app is logged in as) instead of a
 * bit that can silently drift from it. `Account` carries no stored primary
 * flag at all: there is nothing on disk for resolution to consult or repair.
 *
 * `getPrimary` / `getPooled` derive the active account from two injected
 * dependencies, the current active token sha and a per-account sha resolver,
 * so the domain stays pure: no filesystem, no keychain, no token-store reads
 * live here. The IO that produces those shas lives in
 * `discovery/active-token.ts` and is wired in by callers. `byUuid` is a plain
 * lookup over an already-validated registry.
 *
 * @module
 */

import * as v from "valibot";
import {
	type Account,
	AccountSchema,
	type AccountUuid,
	type ClaudeAccountUuid,
} from "./account.ts";

/**
 * `AccountRegistry` — the validated set of pooled accounts.
 *
 * `strictObject` because the file is hand-edited and an unknown top-level
 * key (`account:` instead of `accounts:`) must fail loud, not be treated
 * as an empty registry.
 */
export const AccountRegistrySchema = v.pipe(
	v.strictObject({
		accounts: v.array(AccountSchema),
	}),
	v.check(
		(r) => new Set(r.accounts.map((a) => a.uuid)).size === r.accounts.length,
		"AccountRegistry account uuids must be unique",
	),
	v.check(
		(r) => new Set(r.accounts.map((a) => a.label)).size === r.accounts.length,
		"AccountRegistry account labels must be unique",
	),
	v.check((r) => {
		// Real Claude account uuids must be unique — one real account is one pool
		// entry. Only entries that HAVE an accountUuid are policed (pre-migration
		// entries may lack it); among those present, a collision means the same
		// account was imported twice (the exact bug this model fixes) and must
		// fail loud rather than surface a duplicated identity in the picker.
		const present = r.accounts
			.map((a) => a.accountUuid)
			.filter((id): id is ClaudeAccountUuid => id !== undefined);
		return new Set(present).size === present.length;
	}, "AccountRegistry account accountUuids must be unique"),
);
export type AccountRegistry = v.InferOutput<typeof AccountRegistrySchema>;

/**
 * The sha256 (hex) of the OAuth token Claude.app is currently authenticated
 * as, or `undefined` when it cannot be determined (no keychain key, no config,
 * unreadable token). Produced by `discovery/active-token.ts` and injected here
 * so the domain never touches IO.
 */
export type ActiveTokenSha = string | undefined;

/**
 * Resolve one account's OAuth token sha256 (hex), or `undefined` when its
 * token is missing/unreadable. Injected: the sha comes from hashing the
 * account's stored token, a token-store read the domain must not perform
 * itself. Kept synchronous so `getPrimary` stays pure — callers do the async
 * token-store work up-front and hand in a resolver over a materialized
 * uuid→sha map.
 */
export type AccountTokenSha = (account: Account) => string | undefined;

/**
 * Derive the active ("primary") account at runtime.
 *
 * The active account is the one whose OAuth token sha256 matches
 * `activeTokenSha`, i.e. the account Claude.app is presently logged in as.
 * When that match cannot be made (Claude.app's token is unreadable, or no
 * pooled account holds it) we fall back to the FIRST account in registry
 * order. First-in-order is deterministic: it is the earliest-provisioned
 * account, the historical default, so the picker highlights a stable,
 * predictable account rather than nothing whenever the live token cannot be
 * resolved. An empty registry has no active account → `undefined`.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @param {ActiveTokenSha} activeTokenSha - Sha of Claude.app's current token.
 * @param {AccountTokenSha} accountTokenSha - Per-account token-sha resolver.
 * @returns {Account | undefined} The active account, or `undefined` when the pool is empty.
 */
export function getPrimary(
	registry: AccountRegistry,
	activeTokenSha: ActiveTokenSha,
	accountTokenSha: AccountTokenSha,
): Account | undefined {
	if (activeTokenSha !== undefined) {
		const match = registry.accounts.find((a) => accountTokenSha(a) === activeTokenSha);
		if (match !== undefined) {
			return match;
		}
	}
	// Fallback: first account in declaration order (undefined for an empty pool).
	return registry.accounts[0];
}

/**
 * Return every account EXCEPT the runtime-derived active one, preserving
 * registry order. Mirrors `getPrimary`'s derivation so "active vs pooled" is a
 * single consistent split: the pooled set is exactly the accounts the picker
 * offers to switch TO, given the currently-active account.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @param {ActiveTokenSha} activeTokenSha - Sha of Claude.app's current token.
 * @param {AccountTokenSha} accountTokenSha - Per-account token-sha resolver.
 * @returns {Account[]} The non-active accounts in declaration order.
 */
export function getPooled(
	registry: AccountRegistry,
	activeTokenSha: ActiveTokenSha,
	accountTokenSha: AccountTokenSha,
): Account[] {
	const primary = getPrimary(registry, activeTokenSha, accountTokenSha);
	return registry.accounts.filter((a) => a.uuid !== primary?.uuid);
}

/**
 * Look an account up by uuid. Absent → `undefined` (no throw).
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @param {AccountUuid} uuid - The branded account uuid to look up.
 * @returns {Account | undefined} The matching account, or `undefined`.
 */
export function byUuid(registry: AccountRegistry, uuid: AccountUuid): Account | undefined {
	return registry.accounts.find((a) => a.uuid === uuid);
}

/**
 * Look an account up by its real Claude account uuid. Absent → `undefined`.
 * This is the dedup + active-resolution key: `accountUuid` is stable across
 * token rotation and identical for every token of the same account.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @param {ClaudeAccountUuid} accountUuid - The real Claude account uuid.
 * @returns {Account | undefined} The matching account, or `undefined`.
 */
export function byAccountUuid(
	registry: AccountRegistry,
	accountUuid: ClaudeAccountUuid,
): Account | undefined {
	return registry.accounts.find((a) => a.accountUuid === accountUuid);
}

/**
 * Resolve the active account by Claude.app's plaintext `lastKnownAccountUuid`.
 *
 * `lastKnownAccountUuid` is the real account uuid Claude.app records for the
 * account it is CURRENTLY signed into, written in cleartext to its config.json.
 * Matching it against each pooled account's `accountUuid` is the authoritative,
 * keychain-free way to know which account is live — strictly better than hashing
 * the legacy-cache token slot, which required decrypting the keychain and broke
 * when the cache held several tokens for one account.
 *
 * Returns `undefined` when the marker is absent or names no pooled account, so
 * the caller applies its own fallback (companion file, then first account)
 * rather than this function inventing a guess.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @param {string | undefined} lastKnownAccountUuid - Claude.app's plaintext marker.
 * @returns {Account | undefined} The matching account, or `undefined`.
 */
export function resolveActiveByLastKnown(
	registry: AccountRegistry,
	lastKnownAccountUuid: string | undefined,
): Account | undefined {
	if (lastKnownAccountUuid === undefined) {
		return undefined;
	}
	return registry.accounts.find((a) => a.accountUuid === lastKnownAccountUuid);
}
