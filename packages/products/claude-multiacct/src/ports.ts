/**
 * `@foundation/claude-multiacct` — port types.
 *
 * The runtime is designed as a hexagon: pure domain logic depends only on
 * these types (`TokenStore`, `ChoiceStore`, `UsageProbe`), and every
 * concrete adapter (Keychain, filesystem, HTTP) will land in a later PR that
 * implements one of them. Keeping the ports in their own file lets the domain
 * modules import types without transitively pulling in any real adapter.
 *
 * This file is TYPES ONLY — no runtime code, no default implementations,
 * nothing that could produce a side effect. That is enforced by the fact
 * that every export is a `type`; add nothing here that survives type erasure.
 *
 * @module
 */

import type { Account, AccountUuid } from "./domain/account.ts";
import type { HostSessionChoice } from "./domain/host-session-choice.ts";
import type { ChoiceStoreState, SessionAccountChoice } from "./domain/session-choice.ts";
import type { UsageSnapshot } from "./domain/usage.ts";

/**
 * `TokenStore` — persistence for the opaque `encryptedTokenRef` handles that
 * appear on `Account`. The store never sees cleartext tokens: callers hand it
 * the handle string, and out-of-process backends (Keychain, libsecret, ...)
 * do the actual crypto. `get` returns `undefined` for an unknown account
 * rather than throwing, so lookup paths can distinguish "no handle yet" from
 * a genuine failure.
 */
export type TokenStore = {
	get(accountUuid: AccountUuid): Promise<string | undefined>;
	put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void>;
};

/**
 * `ChoiceStore` — persistence for per-session sticky account choices. The
 * `read` method returns the whole store because the routing shim also needs
 * to iterate for reporting; `write` replaces one entry rather than accepting
 * a whole store so concurrent shims cannot clobber each other. The stored
 * shape is `ChoiceStoreState` from `./domain/session-choice.ts`; the runtime
 * side (this type) is a distinct name in a distinct file so no `Port` suffix
 * is needed.
 */
export type ChoiceStore = {
	read(): Promise<ChoiceStoreState>;
	write(choice: SessionAccountChoice): Promise<void>;
};

/**
 * `HostChoiceStore` — persistence for per-CONVERSATION sticky account choices,
 * keyed on the app's stable `CLAUDE_CODE_HOST_SESSION_ID` rather than the CLI
 * session uuid. This is the store that survives a Claude.app restart: the CLI
 * uuid is minted fresh on every spawn, but the host session id is the app's own
 * durable handle for a conversation, so a resumed conversation resolves the same
 * account through here even though its `ChoiceStore` entry (CLI-uuid-keyed) is
 * gone. `read` returns `undefined` for an unknown conversation — the shim's
 * "fall back to primary" signal, same contract as `ChoiceStore`.
 */
export type HostChoiceStore = {
	read(hostSessionId: string): Promise<HostSessionChoice | undefined>;
	write(choice: HostSessionChoice): Promise<void>;
};

/**
 * `UsageProbe` — fetches a fresh `UsageSnapshot` for an account. Impls will
 * call Anthropic's `/usage` endpoint under the account's OAuth token. Kept
 * async to allow every non-trivial adapter (HTTP, cached-with-TTL, ...).
 */
export type UsageProbe = {
	probe(account: Account): Promise<UsageSnapshot>;
};

/**
 * `TokenRecord` — the full credential bag persisted per account. Pooled OAuth
 * accounts need more than the access token: the `refreshToken` and `expiresAt`
 * are what let the store refresh a stale access token in place instead of
 * failing with a 401. Long-lived opaque tokens (minted in the console) carry
 * neither, so both are optional.
 */
export type TokenRecord = {
	accessToken: string;
	refreshToken?: string;
	/** ISO 8601 expiry timestamp, when the provider returned one. */
	expiresAt?: string;
};
