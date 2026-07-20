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
 */
export const AccountUuidSchema = v.pipe(v.string(), v.uuid(), v.brand("AccountUuid"));
export type AccountUuid = v.InferOutput<typeof AccountUuidSchema>;

/**
 * `Account` — one pooled Anthropic identity.
 *
 * `strictObject` means an unrecognised key fails validation. That is the point:
 * accounts are declared once in a registry file, and a typo like `is_primary`
 * (snake_case) must never silently coexist with the correct `isPrimary`.
 */
export const AccountSchema = v.strictObject({
	uuid: AccountUuidSchema,
	label: NonEmptyString,
	isPrimary: v.boolean(),
	subscriptionType: NonEmptyString,
	rateLimitTier: NonEmptyString,
	encryptedTokenRef: NonEmptyString,
});
export type Account = v.InferOutput<typeof AccountSchema>;
