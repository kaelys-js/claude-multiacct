/**
 * Intent: `token-record.ts` is the single codec both persistent stores use, so a
 * bug here loses credentials in BOTH back ends at once. Two properties carry the
 * value and are pinned below.
 *
 * 1. Encode → decode is lossless for `refreshToken` + `expiresAt`. Those two
 *    fields are the only material that can renew an access token that expires in
 *    about an hour; a codec that drops them turns every stored account into a
 *    manual re-register once the token lapses.
 * 2. Decoding accepts a BARE legacy string. Installs predating the record format
 *    hold raw tokens in both the keychain item and the token file, so a strict
 *    parse would read every one of them as corrupt on upgrade.
 *
 * `tokenRecordFrom` is the OAuth-grant → storage projection: it must carry
 * refresh + expiry through and must NOT smuggle `scopes` into the stored record,
 * because no store reads that field back and a store's shape is a contract.
 */

import { describe, expect, it } from "vitest";
import type { OAuthTokens } from "./models.ts";
import { encodeTokenRecord, parseTokenRecord, tokenRecordFrom } from "./token-record.ts";

describe("parseTokenRecord / encodeTokenRecord", () => {
	it("round-trips the full record losslessly", () => {
		const record = {
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: "2026-07-25T12:00:00.000Z",
		};
		expect(parseTokenRecord(encodeTokenRecord(record))).toStrictEqual(record);
	});

	it("round-trips an access-token-only record without inventing absent fields", () => {
		// A console-minted long-lived token has neither refresh nor expiry; the
		// decoded record must omit them rather than carry `undefined` keys, so
		// refresh-on-read can branch on presence.
		const record = { accessToken: "at" };
		expect(parseTokenRecord(encodeTokenRecord(record))).toStrictEqual(record);
	});

	it("reads a bare legacy string as an access-token-only record", () => {
		expect(parseTokenRecord("legacy-token")).toStrictEqual({ accessToken: "legacy-token" });
	});

	it("reads valid JSON that is not a record shape as a bare token", () => {
		// `{"a":1}` parses but has no string accessToken. Treating it as a record
		// would hand callers `undefined` as a bearer token; treating it as the raw
		// secret is the conservative read.
		expect(parseTokenRecord('{"a":1}')).toStrictEqual({ accessToken: '{"a":1}' });
	});

	it("reads a record with an EMPTY accessToken as a bare token", () => {
		// An empty access token is not a usable credential, so the shape check
		// rejects it and the raw text is preserved for diagnosis.
		expect(parseTokenRecord('{"accessToken":""}')).toStrictEqual({
			accessToken: '{"accessToken":""}',
		});
	});

	it("drops non-string refreshToken / expiresAt rather than storing junk types", () => {
		expect(
			parseTokenRecord('{"accessToken":"at","refreshToken":7,"expiresAt":null}'),
		).toStrictEqual({ accessToken: "at" });
	});

	it("reads JSON null as a bare token (null is not a record)", () => {
		expect(parseTokenRecord("null")).toStrictEqual({ accessToken: "null" });
	});
});

describe("tokenRecordFrom", () => {
	it("carries refreshToken + expiresAt and drops scopes", () => {
		const tokens = {
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: "2026-07-25T12:00:00.000Z",
			scopes: ["user:inference"],
		} as OAuthTokens;
		expect(tokenRecordFrom(tokens)).toStrictEqual({
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: "2026-07-25T12:00:00.000Z",
		});
	});

	it("omits refreshToken / expiresAt the grant did not return", () => {
		const tokens = { accessToken: "at", scopes: [] } as OAuthTokens;
		expect(tokenRecordFrom(tokens)).toStrictEqual({ accessToken: "at" });
	});
});
