/* oxlint-disable vitest/require-to-throw-message */
/**
 * Intent: the four result unions in `models.ts` are the discriminated-union
 * contracts every downstream module (verify, refresh, provisioning, cli
 * commands) branches on. These tests pin (a) each schema accepts its ok /
 * fail shapes, (b) each schema REJECTS the wrong shape (a mis-named fail
 * kind, an extra field on `strictObject`, a missing required field) — a
 * silent acceptance would let a bug leak through the entire pipeline.
 *
 * Rule 12 loud: the picklists are the load-bearing enum. Adversarial:
 * shrinking `VerifyFailKindSchema` to drop `"unauthorized"` immediately
 * fails the "unauthorized parses" test.
 */

import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	OAuthTokensSchema,
	ProvisionResultSchema,
	RefreshResultSchema,
	VerifyResultSchema,
} from "./models.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("OAuthTokensSchema", () => {
	it("accepts the minimal opaque-token shape (no refresh, no expiry, empty scopes)", () => {
		expect(
			v.parse(OAuthTokensSchema, { accessToken: "sk-ant-oat01-abc", scopes: [] }),
		).toBeDefined();
	});
	it("accepts a full refresh-token shape", () => {
		expect(
			v.parse(OAuthTokensSchema, {
				accessToken: "a",
				refreshToken: "r",
				expiresAt: "2026-07-19T12:00:00.000Z",
				scopes: ["user:inference"],
			}),
		).toBeDefined();
	});
	it("rejects an empty accessToken (NonEmptyString invariant)", () => {
		expect(() => v.parse(OAuthTokensSchema, { accessToken: "", scopes: [] })).toThrow();
	});
	it("rejects a non-ISO expiresAt (schema pins the wire shape)", () => {
		expect(() =>
			v.parse(OAuthTokensSchema, {
				accessToken: "a",
				expiresAt: "not-a-date",
				scopes: [],
			}),
		).toThrow();
	});
	it("rejects an unknown extra key (strictObject invariant)", () => {
		expect(() =>
			v.parse(OAuthTokensSchema, { accessToken: "a", scopes: [], extra: true }),
		).toThrow();
	});
});

describe("VerifyResultSchema", () => {
	it("parses ok:true with the identity fields", () => {
		expect(
			v.parse(VerifyResultSchema, {
				ok: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: UUID,
			}),
		).toBeDefined();
	});
	it("parses every declared fail kind (adversarial: dropping one goes red)", () => {
		for (const kind of ["unauthorized", "network", "malformed", "unexpected"] as const) {
			expect(v.parse(VerifyResultSchema, { ok: false, kind, detail: "x" })).toBeDefined();
		}
	});
	it("rejects an unknown fail kind (picklist enforces the closed set)", () => {
		expect(() =>
			v.parse(VerifyResultSchema, { ok: false, kind: "flapdoodle", detail: "x" }),
		).toThrow();
	});
});

describe("RefreshResultSchema", () => {
	it("parses ok:true with tokens", () => {
		expect(
			v.parse(RefreshResultSchema, {
				ok: true,
				tokens: { accessToken: "a", scopes: [] },
			}),
		).toBeDefined();
	});
	it("parses every declared fail kind", () => {
		for (const kind of ["invalid_grant", "network", "malformed", "unexpected"] as const) {
			expect(v.parse(RefreshResultSchema, { ok: false, kind, detail: "x" })).toBeDefined();
		}
	});
	it("rejects an unknown fail kind", () => {
		expect(() => v.parse(RefreshResultSchema, { ok: false, kind: "wrong", detail: "x" })).toThrow();
	});
});

describe("ProvisionResultSchema", () => {
	it("parses ok:true wrapping a valid Account", () => {
		expect(
			v.parse(ProvisionResultSchema, {
				ok: true,
				account: {
					uuid: UUID,
					label: "Personal",
					subscriptionType: "Pro",
					rateLimitTier: "tier-2",
					encryptedTokenRef: "keychain:handle-a",
				},
			}),
		).toBeDefined();
	});
	it("parses every declared fail kind (skipped included → GATED-PR contract)", () => {
		for (const kind of [
			"verify_failed",
			"duplicate_label",
			"duplicate_uuid",
			"skipped",
			"registry_write_failed",
			"token_store_failed",
		] as const) {
			expect(v.parse(ProvisionResultSchema, { ok: false, kind, detail: "x" })).toBeDefined();
		}
	});
	it("rejects an unknown fail kind", () => {
		expect(() =>
			v.parse(ProvisionResultSchema, { ok: false, kind: "nope", detail: "x" }),
		).toThrow();
	});
});
