/**
 * `@foundation/claude-multiacct` — account provisioning orchestration.
 *
 * `provisionAccount` is the ONLY entry point that adds an account to the
 * pool. The pipeline is:
 *
 *   1. Flag check — GATED PR contract. Off → `{ok:false, kind:"skipped"}`,
 *      zero writes.
 *   2. `verifyToken` — proves the OAuth token belongs to a real Anthropic
 *      account and yields the identity fields (uuid, subscription, tier).
 *      Fail → `{kind:"verify_failed"}`; no writes.
 *   3. Load registry via PR2's reader. `undefined` (no pool yet) becomes an
 *      empty registry — the new account is simply the pool's first member.
 *      Duplicate label → `{kind:"duplicate_label"}`; duplicate uuid →
 *      `{kind:"duplicate_uuid"}`. Both reject BEFORE any writes so the
 *      registry invariants stay unforced-on the writer.
 *   4. ATOMIC double-write:
 *        a. Put the token into the store.
 *        b. Append the account to the registry via `AtomicRegistryWriter`.
 *      If (b) throws AFTER (a) succeeded, DELETE the just-stored token.
 *      That rollback is the load-bearing atomicity contract — Rule 12: the
 *      pool must never end up with a keychain credential no registry
 *      account references.
 *
 * @module
 */

import * as v from "valibot";
import {
	type Account,
	type AccountIdentity,
	type AccountSource,
	AccountUuidSchema,
	ClaudeAccountUuidSchema,
} from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { AtomicRegistryWriter } from "../registry/registry-writer.ts";
import type { ProvisionResult, VerifyResult } from "./models.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";

/** Coerce a throwable into a printable string. Single branch for coverage. */
/**
 * Coerce a throwable into a printable string.
 *
 * @param {unknown} error - Thrown value.
 * @returns {string} `error.message` if `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Env-var name that gates provisioning + every mutating CLI command. */
export const FLAG_ENV_VAR = "CLAUDE_MULTIACCT_ENABLE_SHIM";
/** Value the flag must equal for gated ops to run. */
export const FLAG_ENABLED_VALUE = "1";

/** Load-registry function type — matches PR2's `readRegistry` shape. */
export type ReadRegistryFn = () => Promise<AccountRegistry | undefined>;

/** Verify function type — matches `./verify.ts`'s `verifyToken` shape (bound). */
export type VerifyFn = (token: string) => Promise<VerifyResult>;

/** Injectable port bundle. */
export type ProvisionPorts = {
	tokenStore: MutableTokenStore;
	registryWriter: Pick<AtomicRegistryWriter, "write">;
	readRegistry: ReadRegistryFn;
	verify: VerifyFn;
};

/** `provisionAccount` args. */
export type ProvisionOptions = {
	label: string;
	token: string;
	ports: ProvisionPorts;
	/**
	 * Real identity (email / display name) for the account, when the caller has
	 * already resolved it (native detection reads it from the profile API). Stored
	 * verbatim on the account; omitted when unknown.
	 */
	identity?: AccountIdentity;
	/**
	 * How the account entered the pool. `native` for the Claude.app-signed-in
	 * account, `explicit` for a user-added one. Defaults to `explicit`.
	 */
	source?: AccountSource;
	/** Env source; defaults to `process.env`. Only the flag is read. */
	env?: Record<string, string | undefined>;
	/** Bypass the feature-flag gate (test-only knob). */
	overrideFlag?: boolean;
};

/**
 * True iff the flag is exactly `"1"` in the given env.
 *
 * @param {Record<string, string | undefined>} env - Env source.
 * @returns {boolean} Whether mutating ops may run.
 */
export function flagOn(env: Record<string, string | undefined>): boolean {
	return env[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;
}

/**
 * Return a registry with `account` appended. When `registry` is undefined the
 * new account simply becomes the pool's only member; there is no stored primary
 * flag to set, since the active account is derived at runtime.
 *
 * @param {AccountRegistry | undefined} registry - Prior registry, if any.
 * @param {Account} account - Account to append.
 * @returns {AccountRegistry} New registry (input untouched).
 */
function appendAccount(registry: AccountRegistry | undefined, account: Account): AccountRegistry {
	if (registry === undefined) {
		return { accounts: [account] };
	}
	return { accounts: [...registry.accounts, account] };
}

/**
 * Provision one account. See module docstring for the pipeline + atomicity.
 *
 * @param {ProvisionOptions} opts - Provision inputs.
 * @returns {Promise<ProvisionResult>} Ok with the new account, or classified failure.
 */
export async function provisionAccount(opts: ProvisionOptions): Promise<ProvisionResult> {
	const env = opts.env ?? (process.env as Record<string, string | undefined>);

	// Step 1 — flag gate.
	if (!opts.overrideFlag && !flagOn(env)) {
		return {
			ok: false,
			kind: "skipped",
			detail: `${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"; refusing to modify pool`,
		};
	}

	// Step 2 — verify.
	const verify = await opts.ports.verify(opts.token);
	if (!verify.ok) {
		return {
			ok: false,
			kind: "verify_failed",
			detail: `${verify.kind}: ${verify.detail}`,
		};
	}

	// Step 3 — duplicate checks.
	const existing = await opts.ports.readRegistry();
	const accountUuid = v.parse(AccountUuidSchema, verify.accountUuid);
	const claudeAccountUuid = v.parse(ClaudeAccountUuidSchema, verify.accountUuid);
	if (existing !== undefined) {
		if (existing.accounts.some((a) => a.label === opts.label)) {
			return {
				ok: false,
				kind: "duplicate_label",
				detail: `label "${opts.label}" is already registered`,
			};
		}
		// Dedup by the REAL Claude account uuid: one real account is one pool
		// entry even if its token surfaces in the legacy cache, the V2 cache, and
		// a CLI slot at once. `uuid` equals `accountUuid` for accounts we
		// provision, so this also subsumes the local-key collision check.
		if (
			existing.accounts.some((a) => a.uuid === accountUuid || a.accountUuid === claudeAccountUuid)
		) {
			return {
				ok: false,
				kind: "duplicate_uuid",
				detail: `account uuid ${verify.accountUuid} is already registered`,
			};
		}
	}

	// Build the new account. No stored primary flag: the active account is
	// derived at runtime from Claude.app's current token, not marked on add.
	const account: Account = {
		uuid: accountUuid,
		label: opts.label,
		subscriptionType: verify.subscriptionType,
		rateLimitTier: verify.rateLimitTier,
		encryptedTokenRef: verify.accountUuid,
		accountUuid: claudeAccountUuid,
		...(opts.identity === undefined ? {} : { identity: opts.identity }),
		source: opts.source ?? "explicit",
	};

	// Step 4a — token store put. Persist a full record (not a bare access-token
	// string) so this add path matches the OAuth-login path: every pooled entry
	// lands as a `TokenRecord` the encrypted store can later refresh. The
	// paste-a-token flow carries no refresh token, so the record holds only the
	// access token — but the shape is uniform and no bare string is ever stored.
	try {
		await opts.ports.tokenStore.putRecord(accountUuid, { accessToken: opts.token });
	} catch (error) {
		return {
			ok: false,
			kind: "token_store_failed",
			detail: errMsg(error),
		};
	}

	// Step 4b — registry writer. On failure, ROLLBACK the token store put.
	const writerError = await opts.ports.registryWriter
		.write(appendAccount(existing, account))
		.then(() => undefined as Error | undefined)
		.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	if (writerError !== undefined) {
		// Rollback — swallow secondary failures so the operator sees the
		// primary cause, but still flag them in detail (Rule 12).
		const rollbackError = await opts.ports.tokenStore
			.delete(accountUuid)
			.then(() => undefined as Error | undefined)
			.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
		const rollbackNote =
			rollbackError === undefined
				? ""
				: `; token-store rollback ALSO failed: ${errMsg(rollbackError)}`;
		return {
			ok: false,
			kind: "registry_write_failed",
			detail: `${errMsg(writerError)}${rollbackNote}`,
		};
	}

	return { ok: true, account };
}
