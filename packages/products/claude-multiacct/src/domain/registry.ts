/**
 * `@foundation/claude-multiacct` — AccountRegistry domain model.
 *
 * The registry is the on-disk source of truth for the pool: every configured
 * `Account`, plus three invariants the runtime relies on and cannot recover
 * from at call sites:
 *
 * 1. **Exactly one primary.** The routing shim falls back to the primary
 *    account when a session has no explicit choice; zero primaries makes
 *    that fallback undefined, two makes it non-deterministic.
 * 2. **Unique uuids.** UUIDs key every downstream store (choices, tokens,
 *    usage snapshots); a collision would silently overwrite one account's
 *    state with another's.
 * 3. **Unique labels.** The UI selects accounts by label; a duplicate label
 *    makes the human-facing picker ambiguous.
 *
 * Invariants are enforced inside the valibot schema via `v.check` on the
 * parsed object, so `v.parse(AccountRegistrySchema, input)` is the ONLY
 * validation entry point the rest of the codebase needs. That keeps
 * "is this registry valid?" a single well-defined question with a single
 * answer, rather than a schema-check plus a separately-invoked helper the
 * caller might forget to run.
 *
 * The `getPrimary` / `getPooled` / `byUuid` helpers are pure lookups over
 * an already-validated registry. `getPrimary` asserts the invariant found
 * one primary — a defensive check that documents the contract even though
 * a valid registry can never reach the throw path.
 *
 * @module
 */

import * as v from "valibot";
import { type Account, AccountSchema, type AccountUuid } from "./account.ts";

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
		(r) => r.accounts.filter((a) => a.isPrimary).length === 1,
		"AccountRegistry must contain exactly one primary account",
	),
	v.check(
		(r) => new Set(r.accounts.map((a) => a.uuid)).size === r.accounts.length,
		"AccountRegistry account uuids must be unique",
	),
	v.check(
		(r) => new Set(r.accounts.map((a) => a.label)).size === r.accounts.length,
		"AccountRegistry account labels must be unique",
	),
);
export type AccountRegistry = v.InferOutput<typeof AccountRegistrySchema>;

/**
 * Return the primary account. A valid registry has exactly one; the throw
 * documents that contract for callers who bypass parsing.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @returns {Account} The account whose `isPrimary` is `true`.
 */
export function getPrimary(registry: AccountRegistry): Account {
	const primary = registry.accounts.find((a) => a.isPrimary);
	if (primary === undefined) {
		throw new Error("AccountRegistry invariant violated: no primary account");
	}
	return primary;
}

/**
 * Return every non-primary account, preserving registry order.
 *
 * @param {AccountRegistry} registry - A validated registry.
 * @returns {Account[]} The non-primary accounts in declaration order.
 */
export function getPooled(registry: AccountRegistry): Account[] {
	return registry.accounts.filter((a) => !a.isPrimary);
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
