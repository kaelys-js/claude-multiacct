/**
 * Intent: `AccountRegistrySchema` encodes two invariants the router cannot
 * recover from — unique uuids, unique labels — and each adversarial test
 * inverts one and asserts the schema rejects; a schema that cannot fail on a
 * duplicate-uuid fixture is not enforcing anything. The exactly-one-primary
 * invariant was REMOVED: the active account is derived at runtime, so the
 * schema must tolerate zero or many stored `isPrimary` flags (a registry that
 * lost its primary to a hand-edit still has to load to be repaired). The helper
 * tests then pin the derivation the picker depends on: the account whose OAuth
 * token sha256 matches Claude.app's current token is active, with a
 * deterministic first-account fallback when no match can be made.
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { Account, AccountUuid } from "./account.ts";
import {
	type AccountTokenSha,
	AccountRegistrySchema,
	byUuid,
	getPooled,
	getPrimary,
} from "./registry.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_MISSING = "99999999-9999-4999-8999-999999999999";

function account(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		uuid: UUID_A,
		label: "Personal",
		isPrimary: true,
		subscriptionType: "Pro",
		rateLimitTier: "tier-2",
		encryptedTokenRef: "keychain:handle",
		...overrides,
	};
}

const validRegistry = {
	accounts: [
		account({ uuid: UUID_A, label: "Personal", isPrimary: true }),
		account({ uuid: UUID_B, label: "Work", isPrimary: false }),
		account({ uuid: UUID_C, label: "Client", isPrimary: false }),
	],
};

// Fake per-account sha resolver: each account resolves to `sha-<uuid>`, so a
// test picks the "active" account by naming its sha. An account whose uuid is in
// `unreadable` resolves to `undefined`, modelling a token the store cannot hash.
function shaResolver(unreadable: readonly string[] = []): AccountTokenSha {
	return (a: Account): string | undefined =>
		unreadable.includes(a.uuid) ? undefined : `sha-${a.uuid}`;
}

describe("AccountRegistrySchema — positive", () => {
	it("accepts a registry with a stored primary and unique keys", () => {
		expect(() => v.parse(AccountRegistrySchema, validRegistry)).not.toThrow();
	});

	it("accepts a single-account registry", () => {
		const single = { accounts: [account({ isPrimary: true })] };
		expect(() => v.parse(AccountRegistrySchema, single)).not.toThrow();
	});

	it("accepts a ZERO-primary registry (active account is derived, not stored)", () => {
		// Before runtime derivation this was rejected. It must now load: a
		// hand-edit that clears every isPrimary leaves a valid pool whose active
		// account is decided by Claude.app's live token, not by the missing flag.
		const zeroPrimary = {
			accounts: [
				account({ uuid: UUID_A, label: "A", isPrimary: false }),
				account({ uuid: UUID_B, label: "B", isPrimary: false }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, zeroPrimary)).not.toThrow();
	});

	it("accepts a TWO-primary registry (stored isPrimary is a hint, not enforced)", () => {
		// Two stored primaries no longer make resolution non-deterministic:
		// getPrimary ignores the flag and matches the live token, so the schema
		// tolerates it rather than refusing to load the file.
		const twoPrimary = {
			accounts: [
				account({ uuid: UUID_A, label: "A", isPrimary: true }),
				account({ uuid: UUID_B, label: "B", isPrimary: true }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, twoPrimary)).not.toThrow();
	});
});

describe("AccountRegistrySchema — invariant inversions (the load-bearing tests)", () => {
	it("rejects duplicate uuids (collision would overwrite per-account state)", () => {
		const dupUuid = {
			accounts: [
				account({ uuid: UUID_A, label: "A", isPrimary: true }),
				account({ uuid: UUID_A, label: "B", isPrimary: false }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, dupUuid)).toThrow(/uuids must be unique/u);
	});

	it("rejects duplicate labels (picker would be ambiguous)", () => {
		const dupLabel = {
			accounts: [
				account({ uuid: UUID_A, label: "Same", isPrimary: true }),
				account({ uuid: UUID_B, label: "Same", isPrimary: false }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, dupLabel)).toThrow(/labels must be unique/u);
	});

	it("rejects an unknown top-level key — strictObject", () => {
		expect(() => v.parse(AccountRegistrySchema, { ...validRegistry, extras: [] })).toThrow(
			v.ValiError,
		);
	});
});

describe("getPrimary — runtime derivation from the active token sha", () => {
	const parsed = v.parse(AccountRegistrySchema, validRegistry);

	it("returns the account whose token sha matches Claude.app's current token", () => {
		// The active account must be whichever Claude.app is authenticated as,
		// even when that isn't the first-listed account — otherwise the picker
		// highlights the wrong default the moment the user switches logins.
		const active = getPrimary(parsed, `sha-${UUID_B}`, shaResolver());
		expect(active?.uuid).toBe(UUID_B);
	});

	it("falls back to the first account when no account's sha matches", () => {
		// Claude.app is logged in as a token that isn't pooled. Rather than
		// resolve to nothing, fall back to the deterministic first account so the
		// picker stays populated and predictable.
		const active = getPrimary(parsed, "sha-not-in-pool", shaResolver());
		expect(active?.uuid).toBe(UUID_A);
	});

	it("falls back to the first account when the active token sha is undefined", () => {
		// Claude.app's token could not be read at all. Same deterministic
		// fallback: never leave the caller without an active account.
		const active = getPrimary(parsed, undefined, shaResolver());
		expect(active?.uuid).toBe(UUID_A);
	});

	it("treats an unhashable account as a non-match, not a forced match", () => {
		// Claude.app's token would match B, but B's stored token can't be hashed
		// (resolver → undefined). That must NOT coerce into a match; it falls
		// through to the first-account fallback instead of mislabelling B active.
		const active = getPrimary(parsed, `sha-${UUID_B}`, shaResolver([UUID_B]));
		expect(active?.uuid).toBe(UUID_A);
	});

	it("returns undefined for an empty registry", () => {
		// No accounts means no active account; callers must handle absence rather
		// than receive a fabricated pick.
		const empty = v.parse(AccountRegistrySchema, { accounts: [] });
		expect(getPrimary(empty, `sha-${UUID_A}`, shaResolver())).toBeUndefined();
	});
});

describe("getPooled — the switch-to set, mirroring getPrimary", () => {
	const parsed = v.parse(AccountRegistrySchema, validRegistry);

	it("returns every account except the matched active one, in order", () => {
		const pooled = getPooled(parsed, `sha-${UUID_B}`, shaResolver());
		expect(pooled.map((a) => a.uuid)).toStrictEqual([UUID_A, UUID_C]);
	});

	it("excludes the first-account fallback when nothing matches", () => {
		// The split must stay consistent with getPrimary: if A is the fallback
		// active account, A is not in the pooled (switch-to) set.
		const pooled = getPooled(parsed, undefined, shaResolver());
		expect(pooled.map((a) => a.uuid)).toStrictEqual([UUID_B, UUID_C]);
	});

	it("returns an empty pool for an empty registry", () => {
		const empty = v.parse(AccountRegistrySchema, { accounts: [] });
		expect(getPooled(empty, undefined, shaResolver())).toStrictEqual([]);
	});
});

describe("byUuid", () => {
	const parsed = v.parse(AccountRegistrySchema, validRegistry);

	it("returns the matching account", () => {
		expect(byUuid(parsed, UUID_B as AccountUuid)?.label).toBe("Work");
	});

	it("returns undefined for an unknown uuid (negative case — router relies on this)", () => {
		expect(byUuid(parsed, UUID_MISSING as AccountUuid)).toBeUndefined();
	});
});
