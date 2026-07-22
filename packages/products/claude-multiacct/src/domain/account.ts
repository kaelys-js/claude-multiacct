/**
 * `@foundation/claude-multiacct` — Account domain model.
 *
 * An `Account` is the identity foundation for one Anthropic OAuth session
 * inside the single-app pool. This module is INERT: schemas + inferred types
 * only, no I/O and no impls. Nothing imports it yet — it lands ahead of the
 * runtime so downstream PRs can rely on a stable shape without churn.
 *
 * The schema uses `strictObject` so an unknown extra key is a validation
 * error, not silently retained: registry files are hand-edited and we would
 * rather fail loud than accept a typo that later behaves as an unset field.
 *
 * `uuid` is branded so a bare `string` can never be passed where an account
 * id is expected — the compiler prevents mixing account ids with the many
 * other UUIDs (session ids, choice ids, ...) that this codebase moves around.
 *
 * `encryptedTokenRef` is an opaque handle string — a lookup key into whatever
 * out-of-process token store (Keychain, libsecret, ...) actually holds the
 * cleartext. Never a token, never a decrypted secret. That distinction is
 * load-bearing enough that the field name asserts it; the type is deliberately
 * a plain non-empty string rather than another brand, because the concrete
 * shape is a store-implementation detail and would tempt this module into
 * coupling with it.
 *
 * @module
 */

import * as v from "valibot";

/** Non-empty string. Rejects `""` — a blank uuid or label is never valid. */
const NonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * Account UUID — a branded uuid string. The brand exists at type level only;
 * at runtime it is just a validated uuid string.
 *
 * This is the LOCAL pool key: it keys the token store, choice store, and usage
 * snapshots. For accounts this codebase provisions it equals the real Claude
 * `accountUuid` (see below), but the brand keeps the two roles distinct so a
 * refactor can separate them without a silent mix-up.
 */
export const AccountUuidSchema = v.pipe(v.string(), v.uuid(), v.brand("AccountUuid"));
export type AccountUuid = v.InferOutput<typeof AccountUuidSchema>;

/**
 * Claude account UUID — the account's real, server-side identity as returned by
 * Anthropic's `GET /api/oauth/profile` (`account.uuid`). It is STABLE across
 * token rotation and appears identically for every OAuth token that belongs to
 * the same account, which is exactly why it — not a per-token cache-key segment
 * and not a locally-minted uuid — is the dedup key for the pool: one real
 * account is one pool entry even when its token shows up in the legacy cache,
 * the V2 cache, and a CLI slot at once. Branded so it can never be confused with
 * the local {@link AccountUuid} pool key at the type level.
 */
export const ClaudeAccountUuidSchema = v.pipe(v.string(), v.uuid(), v.brand("ClaudeAccountUuid"));
export type ClaudeAccountUuid = v.InferOutput<typeof ClaudeAccountUuidSchema>;

/**
 * `AccountIdentity` — the human-facing identity for an account, sourced from the
 * profile API (never invented). Both fields are optional because the profile
 * call can fail or omit one; an account with neither falls back to a
 * source-derived label, but never to `account-N`. `strictObject` so a typo'd
 * key fails loud rather than silently dropping the real identity.
 */
export const AccountIdentitySchema = v.strictObject({
	/** The account's email (`account.email` from the profile API). */
	email: v.optional(NonEmptyString),
	/** The account's display name (`account.display_name` / `full_name`). */
	displayName: v.optional(NonEmptyString),
});
export type AccountIdentity = v.InferOutput<typeof AccountIdentitySchema>;

/**
 * `AccountSource` — how the account entered the pool.
 *
 * - `native` — the account Claude.app is natively signed into, detected from
 *   `lastKnownAccountUuid`. Always present, not user-removable.
 * - `explicit` — an account the user deliberately added later.
 *
 * The distinction is load-bearing: the native account is the anchor the picker
 * always shows, and removal of it must be refused (it is what Claude.app is
 * actually logged in as). A missing `source` means `explicit` — see
 * {@link effectiveSource} — so a hand-written or pre-migration entry is treated
 * as user-added, never as the protected native anchor.
 */
export const AccountSourceSchema = v.picklist(["native", "explicit"]);
export type AccountSource = v.InferOutput<typeof AccountSourceSchema>;

/**
 * The effective source of an account: its stored `source`, or `explicit` when
 * absent. Callers use this instead of reading `account.source` directly so the
 * "absent means explicit" rule lives in exactly one place.
 *
 * @param {Account} account - The account to classify.
 * @returns {AccountSource} `native` only when explicitly stored, else `explicit`.
 */
export function effectiveSource(account: Account): AccountSource {
	return account.source ?? "explicit";
}

/**
 * `Account` — one pooled Anthropic identity.
 *
 * `strictObject` means an unrecognised key fails validation. That is the point:
 * accounts are declared once in a registry file, and a typo like
 * `subscription_type` (snake_case) must never silently coexist with the
 * correct `subscriptionType`.
 *
 * `accountUuid` is the real Claude account uuid and the pool's dedup key (see
 * {@link ClaudeAccountUuidSchema}). It is optional only for back-compat with
 * pre-migration registry files; every account this codebase writes carries it,
 * and `domain/registry.ts` enforces uniqueness across the entries that have it.
 *
 * `identity` is the real email / display name, populated from the profile API.
 * `source` distinguishes the native Claude.app account from explicitly-added
 * ones and defaults to `explicit`.
 *
 * There is no stored "primary" flag. Which account is active is derived at
 * runtime — preferring Claude.app's plaintext `lastKnownAccountUuid` matched
 * against `accountUuid` (see `domain/registry.ts`) — so no bit on disk drifts.
 */
export const AccountSchema = v.strictObject({
	uuid: AccountUuidSchema,
	label: NonEmptyString,
	subscriptionType: NonEmptyString,
	rateLimitTier: NonEmptyString,
	encryptedTokenRef: NonEmptyString,
	accountUuid: v.optional(ClaudeAccountUuidSchema),
	identity: v.optional(AccountIdentitySchema),
	source: v.optional(AccountSourceSchema),
});
export type Account = v.InferOutput<typeof AccountSchema>;
