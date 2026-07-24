/**
 * `@foundation/claude-multiacct` — register-or-update a pooled account from a
 * freshly-signed-in OAuth identity.
 *
 * The in-app OAuth login (see `./login-manager.ts`) ends with a real access
 * token AND the account's real identity resolved from the profile API
 * (`discovery/identity.ts`). At that point there is nothing left to *verify* —
 * the profile call already proved the token belongs to a real Anthropic account
 * and yielded its stable `accountUuid`. So this module does NOT spawn the CLI
 * verify probe; it registers directly from the profile.
 *
 * # Dedup is an UPSERT, not a rejection
 *
 * The D1 account model keys the pool on the real `accountUuid`. Signing in again
 * to an account already in the pool must UPDATE it (fresh token + refreshed
 * identity), never create a second entry and never hard-fail. So:
 *
 *   - No existing entry for this `accountUuid` → provision a new `source:
 *     "explicit"` account via `provisionAccount` (its atomic keychain+registry
 *     double-write with token rollback).
 *   - Existing entry → replace its stored token and refresh its identity /
 *     subscription fields in place, keeping its local `uuid`, `label`, and
 *     `source`. The token swap is rolled back if the registry write fails, so a
 *     failed update never leaves a keychain token the registry disagrees with.
 *
 * # The full credential bag is persisted, not just the access token
 *
 * A pooled account's access token expires in about an hour; renewing it needs
 * the `refreshToken` + `expiresAt` the exchange returned. Both the update path
 * and the new-account path therefore write the whole {@link TokenRecord}
 * (`putRecord`), not the bare access token, so the store can refresh on read.
 *
 * The token is NEVER logged; it flows straight into the token store.
 *
 * @module
 */

import * as v from "valibot";
import {
	type Account,
	type AccountIdentity,
	AccountUuidSchema,
	ClaudeAccountUuidSchema,
} from "../domain/account.ts";
import type { AccountProfile } from "../discovery/identity.ts";
import type { TokenRecord } from "../ports.ts";
import { provisionAccount, type ProvisionPorts } from "./provisioning.ts";
import type { VerifyResult } from "./models.ts";

/** Ports the register-or-update path needs. Superset shared with provisioning. */
export type RegisterPorts = Pick<ProvisionPorts, "tokenStore" | "registryWriter" | "readRegistry">;

/** Result of {@link registerOrUpdateAccount}. */
export type RegisterResult =
	| { ok: true; account: Account; updated: boolean }
	| {
			ok: false;
			kind: "token_store_failed" | "registry_write_failed" | "duplicate_label";
			detail: string;
	  };

/**
 * Coerce a throwable into a printable string. Single branch for coverage.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Build the {@link TokenRecord} to persist, omitting the optional fields the
 * provider did not return so the stored bag stays clean.
 *
 * @param {string} token - The access token.
 * @param {string} [refreshToken] - The refresh token, if any.
 * @param {string} [expiresAt] - The ISO expiry, if any.
 * @returns {TokenRecord} The credential bag.
 */
function recordOf(token: string, refreshToken?: string, expiresAt?: string): TokenRecord {
	return {
		accessToken: token,
		...(refreshToken === undefined ? {} : { refreshToken }),
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

/**
 * Derive a human label from the resolved identity. Prefers the email, then the
 * display name, then a short slice of the account uuid — never `account-N` (the
 * domain forbids that fallback), and always non-empty.
 *
 * @param {AccountProfile} profile - The resolved profile.
 * @returns {string} A non-empty label.
 */
export function deriveLabel(profile: AccountProfile): string {
	if (profile.email !== undefined) {
		return profile.email;
	}
	if (profile.displayName !== undefined) {
		return profile.displayName;
	}
	return `Claude ${profile.accountUuid.slice(0, 8)}`;
}

/**
 * Build the `AccountIdentity` sub-object from a profile, omitting absent fields
 * so the value stays `strictObject`-clean.
 *
 * @param {AccountProfile} profile - The resolved profile.
 * @returns {AccountIdentity} Identity with only the present fields.
 */
function identityOf(profile: AccountProfile): AccountIdentity {
	return {
		...(profile.email === undefined ? {} : { email: profile.email }),
		...(profile.displayName === undefined ? {} : { displayName: profile.displayName }),
	};
}

/** Args for {@link registerOrUpdateAccount}. */
export type RegisterOptions = {
	/** The account's real identity, resolved from the profile API. */
	profile: AccountProfile;
	/** The OAuth access token to store. Never logged. */
	token: string;
	/** The OAuth refresh token, when the exchange returned one. Never logged. */
	refreshToken?: string;
	/** ISO 8601 access-token expiry, when the exchange returned one. */
	expiresAt?: string;
	/** Injected ports. */
	ports: RegisterPorts;
	/** Optional label override; defaults to {@link deriveLabel}. */
	label?: string;
};

/**
 * Register a new account or update the existing one for this `accountUuid`.
 * See the module docstring for the upsert contract + atomicity.
 *
 * @param {RegisterOptions} opts - Profile, token, ports, optional label.
 * @returns {Promise<RegisterResult>} Ok with the account (`updated` flag), or a
 *   classified failure.
 */
export async function registerOrUpdateAccount(opts: RegisterOptions): Promise<RegisterResult> {
	const { profile, token, ports } = opts;
	const record = recordOf(token, opts.refreshToken, opts.expiresAt);
	const claudeAccountUuid = v.parse(ClaudeAccountUuidSchema, profile.accountUuid);
	const localUuid = v.parse(AccountUuidSchema, profile.accountUuid);
	const identity = identityOf(profile);
	const hasIdentity = identity.email !== undefined || identity.displayName !== undefined;

	const existing = await ports.readRegistry();
	const match = existing?.accounts.find(
		(a) => a.accountUuid === claudeAccountUuid || a.uuid === localUuid,
	);

	if (existing !== undefined && match !== undefined) {
		// UPDATE path — swap the token bag in place, refresh identity/subscription,
		// keep the local uuid, label, and source.
		const snapshot = await ports.tokenStore.getRecord(match.uuid);
		try {
			await ports.tokenStore.putRecord(match.uuid, record);
		} catch (error) {
			return { ok: false, kind: "token_store_failed", detail: errMsg(error) };
		}
		const updated: Account = {
			...match,
			subscriptionType: profile.subscriptionType,
			rateLimitTier: profile.rateLimitTier,
			accountUuid: claudeAccountUuid,
			source: match.source ?? "explicit",
			...(hasIdentity ? { identity } : {}),
		};
		const nextAccounts = existing.accounts.map((a) => (a === match ? updated : a));
		const writerError = await ports.registryWriter
			.write({ accounts: nextAccounts })
			.then(() => undefined as Error | undefined)
			.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
		if (writerError !== undefined) {
			// Roll the token back to the snapshot so a failed update leaves the
			// keychain agreeing with the untouched registry.
			let note = "";
			const restoreError = await (
				snapshot === undefined
					? ports.tokenStore.delete(match.uuid)
					: ports.tokenStore.putRecord(match.uuid, snapshot)
			)
				.then(() => undefined as Error | undefined)
				.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
			if (restoreError !== undefined) {
				note = `; token rollback ALSO failed: ${errMsg(restoreError)}`;
			}
			return { ok: false, kind: "registry_write_failed", detail: `${errMsg(writerError)}${note}` };
		}
		return { ok: true, account: updated, updated: true };
	}

	// NEW path — provision via the shared atomic pipeline. The verify port is a
	// no-op that echoes the already-resolved profile identity, so no CLI probe
	// runs: the profile call already proved the token. Provisioning stores the
	// access token atomically; we then upgrade that entry to the full record so
	// the refresh-on-read path has the refresh token + expiry.
	const verify = (): Promise<VerifyResult> =>
		Promise.resolve({
			ok: true,
			subscriptionType: profile.subscriptionType,
			rateLimitTier: profile.rateLimitTier,
			accountUuid: profile.accountUuid,
		});
	const label = opts.label ?? deriveLabel(profile);
	const provisioned = await provisionAccount({
		label,
		token,
		ports: { ...ports, verify },
		source: "explicit",
		overrideFlag: true,
		...(hasIdentity ? { identity } : {}),
	});
	if (provisioned.ok) {
		await ports.tokenStore.putRecord(provisioned.account.uuid, record);
		return { ok: true, account: provisioned.account, updated: false };
	}
	if (provisioned.kind === "duplicate_label") {
		// A different account already holds this derived label (e.g. two accounts
		// with no email share a uuid-prefixed fallback). Retry once with the full
		// uuid appended so the label stays unique and the add still succeeds.
		const unique = `${label} (${profile.accountUuid})`;
		const retry = await provisionAccount({
			label: unique,
			token,
			ports: { ...ports, verify },
			source: "explicit",
			overrideFlag: true,
			...(hasIdentity ? { identity } : {}),
		});
		if (retry.ok) {
			await ports.tokenStore.putRecord(retry.account.uuid, record);
			return { ok: true, account: retry.account, updated: false };
		}
		return { ok: false, kind: "duplicate_label", detail: retry.detail };
	}
	// verify_failed / skipped / duplicate_uuid cannot occur here (synthetic
	// verify, overrideFlag, and the pre-checked uuid match). Everything else is
	// a store/registry failure.
	return {
		ok: false,
		kind:
			provisioned.kind === "token_store_failed" ? "token_store_failed" : "registry_write_failed",
		detail: provisioned.detail,
	};
}
