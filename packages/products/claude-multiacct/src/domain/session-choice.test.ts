/**
 * Intent: the load-bearing case is the ABSENT one — a session with no
 * recorded choice must resolve to `undefined` so the future shim falls
 * back to the primary account. Every positive test guards that the store
 * accepts a legitimate binding; the negative tests guard the fallback
 * path (absent, stale, and key-mismatch entries all resolve to undefined
 * or fail parsing).
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { AccountRegistrySchema } from "./registry.ts";
import {
	ChoiceStoreStateSchema,
	SessionAccountChoiceSchema,
	parseChoiceStoreState,
	resolveChoice,
	serializeChoiceStoreState,
} from "./session-choice.ts";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_STALE = "44444444-4444-4444-8444-444444444444";
const SESSION_KNOWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_UNKNOWN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_STALE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const registry = v.parse(AccountRegistrySchema, {
	accounts: [
		{
			uuid: ACCOUNT_A,
			label: "Personal",
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "keychain:a",
		},
		{
			uuid: ACCOUNT_B,
			label: "Work",
			subscriptionType: "Pro",
			rateLimitTier: "tier-2",
			encryptedTokenRef: "keychain:b",
		},
	],
});

const validChoice = {
	sessionUuid: SESSION_KNOWN,
	accountUuid: ACCOUNT_B,
	chosenAt: "2026-07-19T12:00:00.000Z",
};

describe("SessionAccountChoiceSchema", () => {
	it("accepts a well-formed choice", () => {
		expect(v.parse(SessionAccountChoiceSchema, validChoice)).toStrictEqual(validChoice);
	});

	it("rejects a non-uuid sessionUuid (intent: sessions must be identifiable)", () => {
		expect(() =>
			v.parse(SessionAccountChoiceSchema, { ...validChoice, sessionUuid: "abc" }),
		).toThrow(v.ValiError);
	});

	it("rejects a non-uuid accountUuid", () => {
		expect(() =>
			v.parse(SessionAccountChoiceSchema, { ...validChoice, accountUuid: "abc" }),
		).toThrow(v.ValiError);
	});

	it("rejects a non-ISO chosenAt (intent: chosenAt is used for TTL/analytics)", () => {
		expect(() =>
			v.parse(SessionAccountChoiceSchema, { ...validChoice, chosenAt: "yesterday" }),
		).toThrow(v.ValiError);
	});

	it("rejects an unknown extra key — strictObject", () => {
		expect(() => v.parse(SessionAccountChoiceSchema, { ...validChoice, notes: "hi" })).toThrow(
			v.ValiError,
		);
	});
});

describe("ChoiceStoreStateSchema", () => {
	it("accepts a store whose keys match their choice.sessionUuid", () => {
		const store = { [SESSION_KNOWN]: validChoice };
		expect(v.parse(ChoiceStoreStateSchema, store)).toStrictEqual(store);
	});

	it("rejects a store whose key disagrees with the stored sessionUuid (corrupt file)", () => {
		// Adversarial invariant inversion: if this passed, resolveChoice could
		// return the wrong account for a session id, silently misrouting traffic.
		const mismatched = { [SESSION_UNKNOWN]: validChoice };
		expect(() => v.parse(ChoiceStoreStateSchema, mismatched)).toThrow(/keys must equal/u);
	});
});

describe("serialize/parse round-trip", () => {
	it("parseChoiceStoreState(serializeChoiceStoreState(x)) === x", () => {
		const store = v.parse(ChoiceStoreStateSchema, { [SESSION_KNOWN]: validChoice });
		expect(parseChoiceStoreState(serializeChoiceStoreState(store))).toStrictEqual(store);
	});

	it("parseChoiceStoreState throws on malformed JSON", () => {
		expect(() => parseChoiceStoreState("{not json")).toThrow(SyntaxError);
	});

	it("parseChoiceStoreState throws on structurally-invalid input", () => {
		expect(() => parseChoiceStoreState(JSON.stringify({ [SESSION_KNOWN]: { bad: 1 } }))).toThrow(
			v.ValiError,
		);
	});
});

describe("resolveChoice", () => {
	const store = v.parse(ChoiceStoreStateSchema, {
		[SESSION_KNOWN]: validChoice,
		[SESSION_STALE]: {
			sessionUuid: SESSION_STALE,
			accountUuid: ACCOUNT_STALE,
			chosenAt: "2026-07-01T00:00:00.000Z",
		},
	});

	it("returns undefined for an unknown sessionUuid (INTENT: shim falls back to primary)", () => {
		// This is the whole point of the model — the negative case is the one the
		// runtime depends on. If this test breaks, sticky routing has silently
		// swallowed the fallback contract.
		expect(resolveChoice(store, registry, SESSION_UNKNOWN)).toBeUndefined();
	});

	it("returns the resolved Account when the session has a valid choice", () => {
		const account = resolveChoice(store, registry, SESSION_KNOWN);
		expect(account?.uuid).toBe(ACCOUNT_B);
	});

	it("returns undefined for a stale choice — account no longer in registry", () => {
		// Same intent as absent: the shim treats absent and stale identically so
		// removing an account never leaves a session pinned to nothing.
		expect(resolveChoice(store, registry, SESSION_STALE)).toBeUndefined();
	});
});
