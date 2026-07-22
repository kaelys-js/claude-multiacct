/**
 * Intent: `AccountSchema` is the runtime gate that stops a malformed account
 * ever reaching downstream stores. Every negative case below encodes a real
 * mistake a hand-edited registry file could ship, so the schema's rejection
 * behaviour is what the tests actually pin.
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	type Account,
	AccountIdentitySchema,
	AccountSchema,
	AccountUuidSchema,
	ClaudeAccountUuidSchema,
	effectiveSource,
} from "./account.ts";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

const validInput = {
	uuid: VALID_UUID,
	label: "Personal",
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

	it("rejects a stored isPrimary flag (intent: the active account is derived, never stored)", () => {
		// The primary flag was removed from the shape. A registry written by an
		// older build still carries it; strictObject must reject rather than keep
		// a field nothing reads, so the drift surfaces instead of rotting silently.
		expect(() => v.parse(AccountSchema, { ...validInput, isPrimary: true })).toThrow(v.ValiError);
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
		// The adversarial case: a typo like sub_type would otherwise coexist with
		// subscriptionType, and the schema must fail loud instead of silently
		// ignoring it.
		expect(() => v.parse(AccountSchema, { ...validInput, sub_type: "Pro" })).toThrow(v.ValiError);
	});
});

describe("ClaudeAccountUuidSchema", () => {
	it("accepts a well-formed uuid (the real account uuid the pool dedups on)", () => {
		expect(v.parse(ClaudeAccountUuidSchema, VALID_UUID)).toBe(VALID_UUID);
	});

	it("rejects a non-uuid — a bad dedup key would collide accounts silently", () => {
		expect(() => v.parse(ClaudeAccountUuidSchema, "sk-ant-oat01")).toThrow(v.ValiError);
	});
});

describe("AccountIdentitySchema", () => {
	it("accepts an email + display name", () => {
		expect(v.parse(AccountIdentitySchema, { email: "a@b.com", displayName: "A" })).toEqual({
			email: "a@b.com",
			displayName: "A",
		});
	});

	it("accepts an empty identity (profile may omit both fields)", () => {
		expect(v.parse(AccountIdentitySchema, {})).toEqual({});
	});

	it("rejects an empty email string (blank is never a real identity)", () => {
		expect(() => v.parse(AccountIdentitySchema, { email: "" })).toThrow(v.ValiError);
	});

	it("rejects an unknown key — strictObject stops a typo'd identity field", () => {
		expect(() => v.parse(AccountIdentitySchema, { mail: "a@b.com" })).toThrow(v.ValiError);
	});
});

describe("AccountSchema — new identity fields", () => {
	it("accepts an account carrying accountUuid, identity, and source", () => {
		const full = {
			...validInput,
			accountUuid: "22222222-2222-4222-8222-222222222222",
			identity: { email: "cole@icloud.com", displayName: "Cole" },
			source: "native",
		};
		expect(v.parse(AccountSchema, full)).toMatchObject(full);
	});

	it("accepts an account WITHOUT the new fields (back-compat: they are optional)", () => {
		expect(() => v.parse(AccountSchema, validInput)).not.toThrow();
	});

	it("rejects a malformed accountUuid", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, accountUuid: "nope" })).toThrow(
			v.ValiError,
		);
	});

	it("rejects an unknown source value", () => {
		expect(() => v.parse(AccountSchema, { ...validInput, source: "imported" })).toThrow(
			v.ValiError,
		);
	});
});

describe("effectiveSource", () => {
	it("returns the stored source when present", () => {
		const a = v.parse(AccountSchema, { ...validInput, source: "native" }) as Account;
		expect(effectiveSource(a)).toBe("native");
	});

	it("defaults to explicit when source is absent (pre-migration entry)", () => {
		const a = v.parse(AccountSchema, validInput) as Account;
		expect(effectiveSource(a)).toBe("explicit");
	});
});
