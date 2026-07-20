/**
 * Intent: `AccountRegistrySchema` encodes three invariants the router cannot
 * recover from: exactly one primary, unique uuids, unique labels. Each
 * adversarial test inverts one invariant and asserts the schema rejects — a
 * schema that cannot fail on a two-primary fixture is not enforcing anything.
 * The helper tests then pin the semantics the router depends on (primary
 * lookup, pool listing, `undefined` on unknown uuid).
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { AccountUuid } from "./account.ts";
import { AccountRegistrySchema, byUuid, getPooled, getPrimary } from "./registry.ts";

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

describe("AccountRegistrySchema — positive", () => {
	it("accepts a registry with exactly one primary and unique keys", () => {
		expect(() => v.parse(AccountRegistrySchema, validRegistry)).not.toThrow();
	});

	it("accepts a single-account registry (primary alone is legal)", () => {
		const single = { accounts: [account({ isPrimary: true })] };
		expect(() => v.parse(AccountRegistrySchema, single)).not.toThrow();
	});
});

describe("AccountRegistrySchema — invariant inversions (the load-bearing tests)", () => {
	it("rejects a ZERO-primary registry (router fallback would be undefined)", () => {
		const zeroPrimary = {
			accounts: [
				account({ uuid: UUID_A, label: "A", isPrimary: false }),
				account({ uuid: UUID_B, label: "B", isPrimary: false }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, zeroPrimary)).toThrow(/exactly one primary/u);
	});

	it("rejects a TWO-primary registry (router fallback would be non-deterministic)", () => {
		const twoPrimary = {
			accounts: [
				account({ uuid: UUID_A, label: "A", isPrimary: true }),
				account({ uuid: UUID_B, label: "B", isPrimary: true }),
			],
		};
		expect(() => v.parse(AccountRegistrySchema, twoPrimary)).toThrow(/exactly one primary/u);
	});

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

describe("registry helpers", () => {
	const parsed = v.parse(AccountRegistrySchema, validRegistry);

	it("getPrimary returns the account marked primary", () => {
		expect(getPrimary(parsed).uuid).toBe(UUID_A);
	});

	it("getPooled returns every non-primary account in order", () => {
		const pooled = getPooled(parsed);
		expect(pooled.map((a) => a.uuid)).toStrictEqual([UUID_B, UUID_C]);
	});

	it("byUuid returns the matching account", () => {
		expect(byUuid(parsed, UUID_B as AccountUuid)?.label).toBe("Work");
	});

	it("byUuid returns undefined for an unknown uuid (negative case — router relies on this)", () => {
		expect(byUuid(parsed, UUID_MISSING as AccountUuid)).toBeUndefined();
	});

	it("getPrimary throws on a hand-crafted invariant-violating registry (documents the contract)", () => {
		// Bypass the schema to construct an impossible-in-normal-flow value: proves
		// the defensive throw fires when the invariant is broken, so callers who
		// skip parsing still get a loud failure instead of a silent undefined.
		const broken = { accounts: parsed.accounts.map((a) => ({ ...a, isPrimary: false })) };
		expect(() => getPrimary(broken)).toThrow(/no primary account/u);
	});
});
