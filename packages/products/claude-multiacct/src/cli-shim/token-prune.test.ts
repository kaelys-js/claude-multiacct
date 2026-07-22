/* oxlint-disable vitest/no-conditional-in-test, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, typescript/explicit-function-return-type, eslint/prefer-promise-reject-errors */
/**
 * Intent: the orphan-token prune must be SAFE — it deletes only keychain token
 * items with no registry entry, and never anything else. Load-bearing:
 *
 *   - `selectOrphanTokens` is the pure classifier: listed − referenced.
 *   - `pruneOrphanTokens` deletes exactly the orphans, leaves referenced items,
 *     and NEVER lists/deletes an item outside the tool's own service (that
 *     property lives in `parseKeychainServiceAccounts`, exercised in
 *     token-store.test.ts; here the store's `list` already returns only ours).
 *   - Fail-closed: an unreadable registry (undefined) deletes NOTHING — we must
 *     not treat every item as an orphan when we can't see what's referenced.
 *   - A single failing delete is recorded, not fatal to the rest.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import { type ListableTokenStore, pruneOrphanTokens, selectOrphanTokens } from "./token-prune.ts";

const UUID_NATIVE = "11111111-1111-4111-8111-111111111111" as AccountUuid;
const UUID_EXPLICIT = "22222222-2222-4222-8222-222222222222" as AccountUuid;
const ORPHAN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as AccountUuid;
const ORPHAN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as AccountUuid;
const ORPHAN_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as AccountUuid;

function registry(): AccountRegistry {
	return {
		accounts: [
			{
				uuid: UUID_NATIVE,
				label: "Native",
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:native",
				source: "native",
			},
			{
				uuid: UUID_EXPLICIT,
				label: "Work",
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:work",
				source: "explicit",
			},
		],
	};
}

// A fake keychain store whose `list` is fixed and `delete` records calls.
function fakeStore(listed: AccountUuid[]): ListableTokenStore & { deletes: AccountUuid[] } {
	const deletes: AccountUuid[] = [];
	return {
		deletes,
		list: () => Promise.resolve(listed),
		delete: (uuid: AccountUuid) => {
			deletes.push(uuid);
			return Promise.resolve();
		},
	};
}

describe("selectOrphanTokens", () => {
	it("returns listed items with no registry entry", () => {
		const orphans = selectOrphanTokens([UUID_NATIVE, UUID_EXPLICIT, ORPHAN_A], registry());
		expect(orphans).toEqual([ORPHAN_A]);
	});

	it("returns [] when every listed item is referenced", () => {
		expect(selectOrphanTokens([UUID_NATIVE, UUID_EXPLICIT], registry())).toEqual([]);
	});
});

describe("pruneOrphanTokens", () => {
	it("deletes ONLY the orphans and leaves referenced tokens (native + explicit) intact", async () => {
		// Three orphans (the pre-D1 bogus items) alongside the two real tokens.
		const store = fakeStore([UUID_NATIVE, UUID_EXPLICIT, ORPHAN_A, ORPHAN_B, ORPHAN_C]);
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: store,
		});
		expect(result.deleted).toEqual([ORPHAN_A, ORPHAN_B, ORPHAN_C]);
		expect(store.deletes).toEqual([ORPHAN_A, ORPHAN_B, ORPHAN_C]);
		// The native and explicit tokens were never handed to delete.
		expect(store.deletes).not.toContain(UUID_NATIVE);
		expect(store.deletes).not.toContain(UUID_EXPLICIT);
		expect(result.failures).toEqual([]);
		expect(result.abortedRegistryUnreadable).toBe(false);
	});

	it("FAIL-CLOSED: an unreadable registry deletes nothing", async () => {
		const store = fakeStore([UUID_NATIVE, ORPHAN_A, ORPHAN_B]);
		const warn = vi.fn<(m: string) => void>();
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(undefined),
			tokenStore: store,
			logger: { warn },
		});
		expect(store.deletes).toEqual([]);
		expect(result.deleted).toEqual([]);
		expect(result.orphans).toEqual([]);
		expect(result.abortedRegistryUnreadable).toBe(true);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("fail-closed"));
	});

	it("records a failing delete without aborting the rest", async () => {
		const deletes: AccountUuid[] = [];
		const store: ListableTokenStore = {
			list: () => Promise.resolve([ORPHAN_A, ORPHAN_B]),
			delete: (uuid: AccountUuid) => {
				deletes.push(uuid);
				if (uuid === ORPHAN_A) {
					return Promise.reject(new Error("locked keychain"));
				}
				return Promise.resolve();
			},
		};
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: store,
		});
		// Both were attempted; one succeeded, one is a recorded failure.
		expect(deletes).toHaveLength(2);
		expect(result.deleted).toEqual([ORPHAN_B]);
		expect(result.failures).toEqual([{ accountUuid: ORPHAN_A, detail: "locked keychain" }]);
	});

	it("logs a summary line on a normal run", async () => {
		const log = vi.fn<(m: string) => void>();
		await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: fakeStore([UUID_NATIVE, ORPHAN_A]),
			logger: { log },
		});
		expect(log).toHaveBeenCalledWith(expect.stringContaining("orphans=1"));
	});

	it("stringifies a non-Error rejection into the failure detail", async () => {
		const store: ListableTokenStore = {
			list: () => Promise.resolve([ORPHAN_A]),
			delete: () => Promise.reject("weird string failure"),
		};
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: store,
		});
		expect(result.failures).toEqual([{ accountUuid: ORPHAN_A, detail: "weird string failure" }]);
	});

	it("fail-closed with NO logger passed still deletes nothing and does not throw", async () => {
		const store = fakeStore([ORPHAN_A]);
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(undefined),
			tokenStore: store,
		});
		expect(store.deletes).toEqual([]);
		expect(result.abortedRegistryUnreadable).toBe(true);
	});

	it("normal run with NO logger passed does not throw at the summary log", async () => {
		const store = fakeStore([UUID_NATIVE, ORPHAN_A]);
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: store,
		});
		expect(result.deleted).toEqual([ORPHAN_A]);
	});

	it("does nothing to delete when there are no orphans", async () => {
		const store = fakeStore([UUID_NATIVE, UUID_EXPLICIT]);
		const result = await pruneOrphanTokens({
			readRegistry: () => Promise.resolve(registry()),
			tokenStore: store,
		});
		expect(store.deletes).toEqual([]);
		expect(result.orphans).toEqual([]);
		expect(result.referenced).toEqual([UUID_NATIVE, UUID_EXPLICIT]);
	});
});
