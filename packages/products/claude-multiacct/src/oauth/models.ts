/**
 * `@foundation/claude-multiacct` — OAuth flow models.
 *
 * Valibot schemas + inferred types for every discriminated result union the
 * PR4 provisioning + refresh pipeline returns. Every failure mode is a
 * *named* `kind` on the failure branch — Rule 12 (fail loud): callers get to
 * branch on the classification, not on a stringly-typed message.
 *
 * `OAuthTokens` holds only the fields we consume: the access token, an
 * optional refresh token (long-lived opaque tokens minted in the Anthropic
 * console lack one), an optional expiry, and the granted scope list.
 *
 * `ProvisionResult` is a wide union because provisioning is the one place
 * that can fail from any participating subsystem (verify probe, token store,
 * registry writer, invariant checks) — each surfaces as a distinct `kind`
 * so the CLI in PR6 can render targeted operator hints.
 *
 * @module
 */

import * as v from "valibot";
import { AccountSchema } from "../domain/account.ts";

/** Non-empty string. Rejects `""`. */
const NonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * `OAuthTokens` — the wire-shape returned by refresh + stored (as a bag) in
 * the token store. Fields optional exactly when Anthropic omits them:
 * long-lived opaque tokens have no `refreshToken` and no `expiresAt`.
 */
export const OAuthTokensSchema = v.strictObject({
	accessToken: NonEmptyString,
	refreshToken: v.optional(NonEmptyString),
	expiresAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
	scopes: v.array(v.string()),
});
export type OAuthTokens = v.InferOutput<typeof OAuthTokensSchema>;

/** Fail kinds for `verifyToken` — classified per Rule 12. */
export const VerifyFailKindSchema = v.picklist([
	"unauthorized",
	"network",
	"malformed",
	"unexpected",
]);
export type VerifyFailKind = v.InferOutput<typeof VerifyFailKindSchema>;

/**
 * `VerifyResult` — outcome of probing a token via the real CLI. On success,
 * the identity fields the pool needs to key the account are attached; on
 * failure, an explicit `kind` + free-form `detail` for logging.
 */
export const VerifyResultSchema = v.union([
	v.strictObject({
		ok: v.literal(true),
		subscriptionType: NonEmptyString,
		rateLimitTier: NonEmptyString,
		orgUuid: v.optional(v.pipe(v.string(), v.uuid())),
		accountUuid: v.pipe(v.string(), v.uuid()),
	}),
	v.strictObject({
		ok: v.literal(false),
		kind: VerifyFailKindSchema,
		detail: v.string(),
	}),
]);
export type VerifyResult = v.InferOutput<typeof VerifyResultSchema>;

/** Fail kinds for `refreshTokens` — RFC 6749 error codes we care about. */
export const RefreshFailKindSchema = v.picklist([
	"invalid_grant",
	"network",
	"malformed",
	"unexpected",
]);
export type RefreshFailKind = v.InferOutput<typeof RefreshFailKindSchema>;

/** `RefreshResult` — new tokens on success, classified error on failure. */
export const RefreshResultSchema = v.union([
	v.strictObject({ ok: v.literal(true), tokens: OAuthTokensSchema }),
	v.strictObject({
		ok: v.literal(false),
		kind: RefreshFailKindSchema,
		detail: v.string(),
	}),
]);
export type RefreshResult = v.InferOutput<typeof RefreshResultSchema>;

/** Fail kinds for `provisionAccount`. */
export const ProvisionFailKindSchema = v.picklist([
	"verify_failed",
	"duplicate_label",
	"duplicate_uuid",
	"skipped",
	"registry_write_failed",
	"token_store_failed",
]);
export type ProvisionFailKind = v.InferOutput<typeof ProvisionFailKindSchema>;

/**
 * `ProvisionResult` — the terminal outcome of an add-account call. The
 * `skipped` branch corresponds to the GATED-PR flag-off no-op path so the
 * caller (and its tests) can pin no-writes.
 */
export const ProvisionResultSchema = v.union([
	v.strictObject({ ok: v.literal(true), account: AccountSchema }),
	v.strictObject({
		ok: v.literal(false),
		kind: ProvisionFailKindSchema,
		detail: v.string(),
	}),
]);
export type ProvisionResult = v.InferOutput<typeof ProvisionResultSchema>;
