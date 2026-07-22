/**
 * `@foundation/claude-multiacct` — resolve an account's real identity from an
 * OAuth token via Anthropic's profile API.
 *
 * Claude.app's OAuth tokens are opaque (`sk-ant-oat01-…`), not JWTs — there is
 * no email or account id to decode locally. The identity Claude.app displays
 * comes from an authenticated call to
 * `GET https://api.anthropic.com/api/oauth/profile`, sent with the token as a
 * bearer credential and the `anthropic-beta: oauth-2025-04-20` header the OAuth
 * surface requires. The response's `account` object carries the STABLE server-
 * side identity:
 *
 *   {
 *     "account": { "uuid", "email", "display_name", "full_name",
 *                  "has_claude_max", "has_claude_pro", ... },
 *     "organization": { "uuid", "name" },
 *     ...
 *   }
 *
 * `account.uuid` is the real Claude account uuid — identical for every OAuth
 * token that belongs to the same account, which makes it the pool's dedup key.
 * `account.email` / `account.display_name` are the human identity shown in the
 * picker. The subscription flags map to a coarse `subscriptionType` so a freshly
 * detected account is not stuck at `"unknown"` before its first `/usage` fetch.
 *
 * Endpoint discovery: verified live against a real Claude Max account
 * (2026-07). `console.anthropic.com/api/oauth/profile` returns 401 for a bearer
 * token, `api.anthropic.com/v1/me` and `/api/claude_cli/profile` return 404 —
 * `api.anthropic.com/api/oauth/profile` with the beta header is the one that
 * answers 200 with the identity.
 *
 * `fetch` is INJECTED so the resolver is unit-tested without hitting the
 * network. Every failure is a classified `kind` (Rule 12).
 *
 * @module
 */

import * as v from "valibot";
import type { ClaudeAccountUuid } from "../domain/account.ts";

/** The profile endpoint. Exported so the daemon/companion wire the same URL. */
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** Beta header the OAuth profile surface requires; without it the call 401s. */
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Minimal `fetch`-shape the profile call needs. Injected so tests never hit net. */
export type ProfileFetch = (
	url: string,
	init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Classified failure kinds for a profile fetch. */
export type ProfileFailKind = "unauthorized" | "network" | "malformed" | "unexpected";

/**
 * Resolved identity for one account. `accountUuid` is the dedup key;
 * `email`/`displayName` are the human identity; the subscription/tier fields
 * seed the registry entry until `/usage` refreshes them.
 */
export type AccountProfile = {
	accountUuid: ClaudeAccountUuid;
	email: string | undefined;
	displayName: string | undefined;
	subscriptionType: string;
	rateLimitTier: string;
};

/** Result of {@link fetchAccountProfile}. */
export type ProfileResult =
	| { ok: true; profile: AccountProfile }
	| { ok: false; kind: ProfileFailKind; detail: string };

/** Only the fields we consume; extra keys tolerated. */
const ProfileResponseSchema = v.object({
	account: v.object({
		uuid: v.pipe(v.string(), v.uuid()),
		email: v.optional(v.string()),
		display_name: v.optional(v.string()),
		full_name: v.optional(v.string()),
		has_claude_max: v.optional(v.boolean()),
		has_claude_pro: v.optional(v.boolean()),
	}),
});

/**
 * Coerce a throwable into a printable string.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Map the account's plan flags to a coarse subscription label. `has_claude_max`
 * wins over `has_claude_pro`; neither present → `"unknown"`, which `/usage`
 * later refines.
 *
 * @param {boolean | undefined} hasMax - `account.has_claude_max`.
 * @param {boolean | undefined} hasPro - `account.has_claude_pro`.
 * @returns {string} A subscription label.
 */
function subscriptionFromFlags(hasMax: boolean | undefined, hasPro: boolean | undefined): string {
	if (hasMax === true) {
		return "claude_max";
	}
	if (hasPro === true) {
		return "claude_pro";
	}
	return "unknown";
}

/**
 * Normalise an optional string field to a non-empty `string | undefined`.
 *
 * @param {string | undefined} s - The raw field value.
 * @returns {string | undefined} The value when non-empty, else `undefined`.
 */
function nonEmpty(s: string | undefined): string | undefined {
	return typeof s === "string" && s.length > 0 ? s : undefined;
}

/**
 * Fetch one account's identity from the profile API. See module docstring for
 * the endpoint + error taxonomy.
 *
 * @param {string} token - The account's OAuth token (`sk-ant-oat…`).
 * @param {ProfileFetch} fetchImpl - Injected fetch.
 * @returns {Promise<ProfileResult>} Ok with identity, or a classified failure.
 */
export async function fetchAccountProfile(
	token: string,
	fetchImpl: ProfileFetch,
): Promise<ProfileResult> {
	let response: { ok: boolean; status: number; text: () => Promise<string> };
	try {
		response = await fetchImpl(PROFILE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": OAUTH_BETA_HEADER,
				Accept: "application/json",
			},
		});
	} catch (error) {
		return { ok: false, kind: "network", detail: errMsg(error) };
	}

	let rawBody: string;
	try {
		rawBody = await response.text();
	} catch (error) {
		return { ok: false, kind: "network", detail: `body read failed: ${errMsg(error)}` };
	}

	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			kind: "unauthorized",
			detail: `profile returned ${String(response.status)}: ${rawBody.slice(0, 160)}`,
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			kind: "unexpected",
			detail: `profile returned ${String(response.status)}: ${rawBody.slice(0, 160)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch (error) {
		return { ok: false, kind: "malformed", detail: `profile body was not JSON: ${errMsg(error)}` };
	}
	const validated = v.safeParse(ProfileResponseSchema, parsed);
	if (!validated.success) {
		return {
			ok: false,
			kind: "malformed",
			detail: `profile body did not match expected shape: ${validated.issues[0].message}`,
		};
	}
	const { account } = validated.output;
	return {
		ok: true,
		profile: {
			accountUuid: account.uuid as ClaudeAccountUuid,
			email: nonEmpty(account.email),
			displayName: nonEmpty(account.display_name) ?? nonEmpty(account.full_name),
			subscriptionType: subscriptionFromFlags(account.has_claude_max, account.has_claude_pro),
			rateLimitTier: "unknown",
		},
	};
}
