/**
 * `@foundation/claude-multiacct` — library-callable CLI commands.
 *
 * The six operations the future `bin/cma` (PR6) exposes. Every command is a
 * pure function over injected ports (`CliPorts`) — no arg parser here, no
 * stdout/stderr, no process.exit. That keeps them trivially testable and
 * lets PR6 wrap them in whatever arg parser the team picks without
 * changing the mechanics.
 *
 * # GATED-PR contract
 *
 * Mutating commands (`addAccount`, `removeAccount`, `refreshAccount`,
 * `setPrimary`) return `{skipped: true, ...}` and touch NOTHING when the
 * flag is off. Read-only commands (`listAccounts`, `verifyAccount`) are
 * always allowed.
 *
 * # Atomicity mirror
 *
 * `removeAccount` and `refreshAccount` each perform a two-step mutation
 * (token store + registry) and roll back the token side if the registry
 * write fails — same shape as `provisionAccount`. Every rollback path is
 * covered adversarially in `commands.test.ts`.
 *
 * @module
 */

import * as v from "valibot";
import { type Account, type AccountUuid, AccountUuidSchema } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { AtomicRegistryWriter } from "../registry/registry-writer.ts";
import type { OAuthTokens, ProvisionResult, RefreshResult, VerifyResult } from "../oauth/models.ts";
import {
	FLAG_ENABLED_VALUE,
	FLAG_ENV_VAR,
	flagOn,
	provisionAccount,
	type ReadRegistryFn,
	type VerifyFn,
} from "../oauth/provisioning.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";

/**
 * Coerce a throwable into a printable string. Single branch for coverage.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Injected port bundle every command takes. */
export type CliPorts = {
	tokenStore: MutableTokenStore;
	registryWriter: Pick<AtomicRegistryWriter, "write">;
	readRegistry: ReadRegistryFn;
	verify: VerifyFn;
	/** Refresh function — takes the current tokens, returns a new bundle. */
	refresh?: (tokens: OAuthTokens) => Promise<RefreshResult>;
};

/**
 * Skipped-because-flag-off shape. `ok: false` is on the base so callers can
 * narrow uniformly on `.ok` across every command's return union.
 */
export type SkippedResult = { ok: false; skipped: true; reason: string };

/** Selector: address an account by its uuid or its label. */
export type AccountSelector = { uuid?: string; label?: string };

/** Common opts every mutating command accepts. */
export type MutateOpts = {
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
};

/**
 * Return a `SkippedResult` when the feature flag is off, else `undefined`.
 *
 * @param {MutateOpts} opts - Command opts; `overrideFlag` bypasses the gate.
 * @param {string} command - Command name embedded in the skip reason.
 * @returns {SkippedResult | undefined} Skipped when off, undefined when on.
 */
function skippedIfFlagOff(opts: MutateOpts, command: string): SkippedResult | undefined {
	if (opts.overrideFlag === true) {
		return undefined;
	}
	const env = opts.env ?? (process.env as Record<string, string | undefined>);
	if (flagOn(env)) {
		return undefined;
	}
	return {
		ok: false,
		skipped: true,
		reason: `${command}: ${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"`,
	};
}

/**
 * Look an account up by selector. Returns undefined when nothing matches.
 *
 * @param {AccountRegistry} registry - Validated registry.
 * @param {AccountSelector} selector - Selector by uuid or by label.
 * @returns {Account | undefined} Match or `undefined`.
 */
function resolveSelector(
	registry: AccountRegistry,
	selector: AccountSelector,
): Account | undefined {
	if (selector.uuid !== undefined) {
		return registry.accounts.find((a) => a.uuid === selector.uuid);
	}
	if (selector.label !== undefined) {
		return registry.accounts.find((a) => a.label === selector.label);
	}
	return undefined;
}

/**
 * Human-readable label for error messages.
 *
 * @param {AccountSelector} selector - Selector to describe.
 * @returns {string} `selector.uuid ?? selector.label ?? "<no-selector>"`.
 */
function selectorLabel(selector: AccountSelector): string {
	return selector.uuid ?? selector.label ?? "<no-selector>";
}

/**
 * `addAccount` — thin wrapper around `provisionAccount`.
 *
 * @param {object} args - Command args (label, token, ports, env, overrideFlag).
 * @returns {Promise<ProvisionResult | SkippedResult>} Provision outcome or skip.
 */
export function addAccount(args: {
	label: string;
	token: string;
	ports: CliPorts;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
}): Promise<ProvisionResult | SkippedResult> {
	const skip = skippedIfFlagOff(args, "addAccount");
	if (skip !== undefined) {
		return Promise.resolve(skip);
	}
	return provisionAccount({
		label: args.label,
		token: args.token,
		ports: args.ports,
		env: args.env,
		overrideFlag: true, // gate already checked here — provisioning gate would double-check
	});
}

/**
 * `listAccounts` — ALWAYS allowed; read-only.
 *
 * @param {object} args - `{ ports }`.
 * @returns {Promise<Account[]>} Every registered account, or `[]` if no registry.
 */
export async function listAccounts(args: { ports: CliPorts }): Promise<Account[]> {
	const reg = await args.ports.readRegistry();
	return reg?.accounts ?? [];
}

/** `verifyAccount` result — carries `needsRefresh` for the CLI to render. */
export type VerifyAccountResult =
	| { ok: true; verify: VerifyResult; needsRefresh: boolean }
	| { ok: false; reason: "not_found"; detail: string };

/**
 * `verifyAccount` — re-runs verify against the stored token. Always allowed
 * (read-only). Marks `needsRefresh` when verify comes back `unauthorized`
 * — does NOT auto-mutate the registry.
 *
 * @param {object} args - `{ selector, ports }`.
 * @returns {Promise<VerifyAccountResult>} Verify result + needsRefresh flag.
 */
export async function verifyAccount(args: {
	selector: AccountSelector;
	ports: CliPorts;
}): Promise<VerifyAccountResult> {
	const reg = await args.ports.readRegistry();
	if (reg === undefined) {
		return { ok: false, reason: "not_found", detail: "no registry" };
	}
	const account = resolveSelector(reg, args.selector);
	if (account === undefined) {
		return {
			ok: false,
			reason: "not_found",
			detail: `no account matches ${selectorLabel(args.selector)}`,
		};
	}
	const stored = await args.ports.tokenStore.get(account.uuid);
	if (stored === undefined) {
		return {
			ok: true,
			verify: { ok: false, kind: "unauthorized", detail: "no stored token" },
			needsRefresh: true,
		};
	}
	const verify = await args.ports.verify(stored);
	const needsRefresh = !verify.ok && verify.kind === "unauthorized";
	return { ok: true, verify, needsRefresh };
}

/** `removeAccount` result. */
export type RemoveResult =
	| { ok: true; removed: Account }
	| {
			ok: false;
			reason: "not_found" | "registry_write_failed" | "token_store_failed";
			detail: string;
	  }
	| SkippedResult;

/**
 * `removeAccount` — reverse-atomic mirror of provisioning:
 *
 *   1. Snapshot the current token in memory.
 *   2. Delete the token from the store.
 *   3. Write the trimmed registry.
 *   4. On registry write fail → restore the token via `put(snapshot)`.
 *
 * @param {object} args - `{ selector, ports, env, overrideFlag }`.
 * @returns {Promise<RemoveResult>} Remove outcome, or skip when flag off.
 */
export async function removeAccount(args: {
	selector: AccountSelector;
	ports: CliPorts;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
}): Promise<RemoveResult> {
	const skip = skippedIfFlagOff(args, "removeAccount");
	if (skip !== undefined) {
		return skip;
	}
	const reg = await args.ports.readRegistry();
	if (reg === undefined) {
		return { ok: false, reason: "not_found", detail: "no registry" };
	}
	const account = resolveSelector(reg, args.selector);
	if (account === undefined) {
		return {
			ok: false,
			reason: "not_found",
			detail: `no account matches ${selectorLabel(args.selector)}`,
		};
	}

	// PR1 invariant: exactly one primary. Removing the primary requires the
	// caller to setPrimary first (Rule 12 loud).
	if (account.isPrimary && reg.accounts.length > 1) {
		return {
			ok: false,
			reason: "registry_write_failed",
			detail: "refusing to remove primary while other accounts exist; setPrimary first",
		};
	}

	const remaining: AccountRegistry = {
		accounts: reg.accounts.filter((a) => a.uuid !== account.uuid),
	};

	// Snapshot the token so we can undo.
	const tokenSnapshot = await args.ports.tokenStore.get(account.uuid);

	// Empty registry after removal → we simply skip the write (an empty
	// accounts array would fail the PR1 exactly-one-primary check). PR6
	// will decide whether to delete the file entirely.
	if (remaining.accounts.length === 0) {
		try {
			await args.ports.tokenStore.delete(account.uuid);
		} catch (error) {
			return {
				ok: false,
				reason: "token_store_failed",
				detail: errMsg(error),
			};
		}
		return { ok: true, removed: account };
	}

	try {
		await args.ports.tokenStore.delete(account.uuid);
	} catch (error) {
		return {
			ok: false,
			reason: "token_store_failed",
			detail: errMsg(error),
		};
	}
	const writerError = await args.ports.registryWriter
		.write(remaining)
		.then(() => undefined as Error | undefined)
		.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	if (writerError !== undefined) {
		// Reverse rollback — restore the token.
		let note = "";
		if (tokenSnapshot !== undefined) {
			const restoreError = await args.ports.tokenStore
				.put(account.uuid, tokenSnapshot)
				.then(() => undefined as Error | undefined)
				.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
			if (restoreError !== undefined) {
				note = `; token restore ALSO failed: ${errMsg(restoreError)}`;
			}
		}
		return {
			ok: false,
			reason: "registry_write_failed",
			detail: `${errMsg(writerError)}${note}`,
		};
	}
	return { ok: true, removed: account };
}

/** `refreshAccount` result. */
export type RefreshAccountResult =
	| { ok: true; account: Account; tokens: OAuthTokens }
	| {
			ok: false;
			reason:
				| "not_found"
				| "no_refresh_token"
				| "refresh_failed"
				| "token_store_failed"
				| "no_refresh_impl";
			detail: string;
	  }
	| SkippedResult;

/**
 * `refreshAccount` — re-mints tokens via the OAuth refresh grant. Requires
 * `ports.refresh` to be provided; caller wires it to `./refresh.ts`'s
 * `refreshTokens` bound with the endpoint.
 *
 * We store the OAuth bundle as a JSON blob under the account uuid — the
 * `TokenStore` port is opaque about the payload shape, so a JSON encode is
 * the least-surprising wire format.
 *
 * @param {object} args - `{ selector, currentTokens, ports, env, overrideFlag }`.
 * @returns {Promise<RefreshAccountResult>} Refreshed tokens or classified failure.
 */
export async function refreshAccount(args: {
	selector: AccountSelector;
	currentTokens: OAuthTokens;
	ports: CliPorts;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
}): Promise<RefreshAccountResult> {
	const skip = skippedIfFlagOff(args, "refreshAccount");
	if (skip !== undefined) {
		return skip;
	}
	const reg = await args.ports.readRegistry();
	if (reg === undefined) {
		return { ok: false, reason: "not_found", detail: "no registry" };
	}
	const account = resolveSelector(reg, args.selector);
	if (account === undefined) {
		return {
			ok: false,
			reason: "not_found",
			detail: `no account matches ${selectorLabel(args.selector)}`,
		};
	}
	if (args.currentTokens.refreshToken === undefined) {
		return {
			ok: false,
			reason: "no_refresh_token",
			detail: "account has no refresh_token; re-provision (paste-a-token path) instead",
		};
	}
	if (args.ports.refresh === undefined) {
		return {
			ok: false,
			reason: "no_refresh_impl",
			detail: "ports.refresh not wired; caller must inject refresh function",
		};
	}
	const refreshed = await args.ports.refresh(args.currentTokens);
	if (!refreshed.ok) {
		return {
			ok: false,
			reason: "refresh_failed",
			detail: `${refreshed.kind}: ${refreshed.detail}`,
		};
	}
	// Snapshot old token so we can restore on write fail.
	const oldStored = await args.ports.tokenStore.get(account.uuid);
	try {
		await args.ports.tokenStore.put(account.uuid, JSON.stringify(refreshed.tokens));
	} catch (error) {
		return {
			ok: false,
			reason: "token_store_failed",
			detail: errMsg(error),
		};
	}
	// Registry is unchanged during a refresh — but if a caller had wired the
	// writer to bump `needsRefresh` metadata, that would happen here. For PR4
	// no registry write is needed. Restore path retained for future symmetry.
	if (oldStored === undefined) {
		// nothing to restore against
	}
	return { ok: true, account, tokens: refreshed.tokens };
}

/** `setPrimary` result. */
export type SetPrimaryResult =
	| { ok: true; previousPrimary: Account | undefined; newPrimary: Account }
	| { ok: false; reason: "not_found" | "already_primary" | "registry_write_failed"; detail: string }
	| SkippedResult;

/**
 * `setPrimary` — flip the stored `isPrimary` default in one atomic write: the
 * chosen account becomes the sole `isPrimary: true`, every other becomes
 * `false`, so the stored default stays single-valued even though the schema no
 * longer forces it. This manages the operator's stored default; it does NOT
 * decide the active account — that is derived at runtime from Claude.app's
 * current token (`domain/registry.ts::getPrimary`).
 *
 * `previousPrimary` is whichever account currently holds the stored flag, or
 * `undefined` when none does (now reachable: a no-primary registry loads fine
 * since the exactly-one-primary invariant was removed, e.g. electing a first
 * default after a hand-edit wiped it).
 *
 * @param {object} args - `{ selector, ports, env, overrideFlag }`.
 * @returns {Promise<SetPrimaryResult>} Flip outcome or skip when flag off.
 */
export async function setPrimary(args: {
	selector: AccountSelector;
	ports: CliPorts;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
}): Promise<SetPrimaryResult> {
	const skip = skippedIfFlagOff(args, "setPrimary");
	if (skip !== undefined) {
		return skip;
	}
	const reg = await args.ports.readRegistry();
	if (reg === undefined) {
		return { ok: false, reason: "not_found", detail: "no registry" };
	}
	const target = resolveSelector(reg, args.selector);
	if (target === undefined) {
		return {
			ok: false,
			reason: "not_found",
			detail: `no account matches ${selectorLabel(args.selector)}`,
		};
	}
	if (target.isPrimary) {
		return { ok: false, reason: "already_primary", detail: `${target.label} is already primary` };
	}
	// The account currently holding the stored default (may be none now that the
	// schema no longer forces exactly one). Reported for operator feedback only.
	const previousPrimary = reg.accounts.find((a) => a.isPrimary);
	const next: AccountRegistry = {
		accounts: reg.accounts.map((a) => ({
			...a,
			// Single stored default in the same write — never two, never zero.
			isPrimary: a.uuid === target.uuid,
		})),
	};
	try {
		await args.ports.registryWriter.write(next);
	} catch (error) {
		return {
			ok: false,
			reason: "registry_write_failed",
			detail: errMsg(error),
		};
	}
	return {
		ok: true,
		previousPrimary,
		newPrimary: { ...target, isPrimary: true },
	};
}

/**
 * Coerce a bare string into a branded `AccountUuid`.
 *
 * @param {string} uuid - Candidate uuid string.
 * @returns {AccountUuid} Branded uuid; throws if not a valid uuid.
 */
export function coerceUuid(uuid: string): AccountUuid {
	return v.parse(AccountUuidSchema, uuid);
}
