/**
 * Intent: `AccountSchema` is the runtime gate that stops a malformed account
 * ever reaching downstream stores. Every negative case below encodes a real
 * mistake a hand-edited registry file could ship, so the schema's rejection
 * behaviour is what the tests actually pin.
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { AccountSchema, AccountUuidSchema } from "./account.ts";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

const validInput = {
	uuid: VALID_UUID,
	label: "Personal",
	isPrimary: true,
	subscriptionType: "Pro",
	rateLimitTier: "tier-2",
	encryptedTokenRef: "keychain:handle-abc",
};

describe("AccountUuidSchema", () => {
	it("accepts a well-formed uuid and brands the output", () => {
		// A branded string is still a string at runtime; the brand is a compile-time
		// promise. Assert value equality — the brand ensures downstream callers cannot
		// pass any old string where an AccountUuid is required.
		const out = v.parse(AccountUuidSchema, VALID_UUID);
		expect(out).toBe(VALID_UUID);
	});

	it("rejects a non-uuid string (this is the negative that matters)", () => {
		// If this test can pass, the schema does not actually validate uuids and
		// any garbage id could reach the account store.
		expect(() => v.parse(AccountUuidSchema, "not-a-uuid")).toThrow(v.ValiError);
	});
});

describe("AccountSchema — positive", () => {
	it("accepts a fully-populated account", () => {
		expect(v.parse(AccountSchema, validInput)).toMatchObject(validInput);
	});
});

describe("AccountSchema — malformed field rejection", () => {
	it("rejects a malformed uuid (intent: block invalid ids from reaching stores)", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, uuid: "abc" })).toThrow(v.ValiError);
	});

	it("rejects an empty label (intent: the picker cannot render a nameless account)", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, label: "" })).toThrow(v.ValiError);
	});

	it("rejects a non-boolean isPrimary (intent: primary must be a binary flag)", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, isPrimary: "yes" })).toThrow(v.ValiError);
	});

	it("rejects an empty subscriptionType", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, subscriptionType: "" })).toThrow(
			v.ValiError,
		);
	});

	it("rejects an empty rateLimitTier", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, rateLimitTier: "" })).toThrow(v.ValiError);
	});

	it("rejects a missing encryptedTokenRef (intent: the token handle is load-bearing)", () => {
		const { encryptedTokenRef: _drop, ...rest } = validInput;
		expect(() => v.parse(AccountSchema, rest)).toThrow(v.ValiError);
	});

	it("rejects an empty encryptedTokenRef (empty handle would silently lookup nothing)", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, encryptedTokenRef: "" })).toThrow(
			v.ValiError,
		);
	});

	it("rejects an unknown extra key — strictObject invariant", () => {
		// The adversarial case: a typo like is_primary would otherwise coexist with
		// isPrimary, and the schema must fail loud instead of silently ignoring it.
		expect(() => v.parse(AccountSchema, { ...validInput, is_primary: false })).toThrow(v.ValiError);
	});
});
