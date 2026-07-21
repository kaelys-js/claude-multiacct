/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, eslint/prefer-promise-reject-errors, unicorn/numeric-separators-style, typescript/explicit-function-return-type */
/**
 * Intent: refresh is the ONLY path that mints new access tokens without
 * operator involvement. Two behaviours are load-bearing:
 *
 *   1. The request wire-shape is EXACT — `POST`, form-urlencoded body with
 *      `grant_type=refresh_token`, correct Content-Type. The spy pins each
 *      field. Adversarial: swap `grant_type` to `client_credentials` and
 *      the "pins grant_type" test immediately goes red.
 *   2. Errors are CLASSIFIED — `invalid_grant` (dead refresh_token) must be
 *      distinct from `network` (fetch rejects) and `malformed` (bad body).
 *      Provisioning branches on the kind to decide whether to prompt
 *      re-provisioning vs retrying.
 */

import { describe, expect, it } from "vitest";
import { type FetchImpl, refreshTokens } from "./refresh.ts";
import { assertNotOk, assertOk } from "./test-utils.ts";

// Hoisted (unicorn/consistent-function-scoping) — fetch impl that rejects
// with a raw string to exercise the errMsg non-Error branch.
// oxlint-disable-next-line prefer-promise-reject-errors
const fetchRejectsRawString: FetchImpl = () => Promise.reject("bare string" as unknown as Error);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function makeFetch(
	response:
		| {
				ok: boolean;
				status: number;
				body: string;
		  }
		| Error
		| { body: () => Promise<string>; ok: boolean; status: number },
): { fetchImpl: FetchImpl; calls: Call[] } {
	const calls: Call[] = [];
	const fetchImpl: FetchImpl = (
		url,
		init,
	): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
		calls.push({ url, method: init.method, headers: init.headers, body: init.body });
		if (response instanceof Error) {
			return Promise.reject(response);
		}
		if ("body" in response && typeof response.body === "function") {
			return Promise.resolve({
				ok: response.ok,
				status: response.status,
				text: response.body,
			});
		}
		const staticResp = response as { ok: boolean; status: number; body: string };
		return Promise.resolve({
			ok: staticResp.ok,
			status: staticResp.status,
			text: (): Promise<string> => Promise.resolve(staticResp.body),
		});
	};
	return { fetchImpl, calls };
}

describe("refreshTokens — happy path", () => {
	it("returns ok:true with the parsed tokens (incl. computed expiresAt)", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
				scope: "user:inference user:profile",
				token_type: "Bearer",
			}),
		});
		const result = await refreshTokens({
			refreshToken: "old-refresh",
			fetchImpl,
			endpoint: "https://example.test/oauth/token",
		});
		assertOk(result);
		expect(result.tokens.accessToken).toBe("new-access");
		expect(result.tokens.refreshToken).toBe("new-refresh");
		expect(result.tokens.scopes).toEqual(["user:inference", "user:profile"]);
		expect(result.tokens.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
	});

	it("tolerates a minimal opaque-token response (no refresh/expiry/scope)", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ access_token: "just-access" }),
		});
		const result = await refreshTokens({
			refreshToken: "r",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertOk(result);
		expect(result.tokens.accessToken).toBe("just-access");
		expect(result.tokens.refreshToken).toBeUndefined();
		expect(result.tokens.expiresAt).toBeUndefined();
		expect(result.tokens.scopes).toEqual([]);
	});
});

describe("refreshTokens — request wire-shape (adversarial: change grant_type → RED)", () => {
	it("pins POST + Content-Type: application/x-www-form-urlencoded + Accept: json", async () => {
		const { fetchImpl, calls } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ access_token: "a" }),
		});
		await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://example.test/token",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://example.test/token");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(calls[0]?.headers.Accept).toBe("application/json");
	});

	it("pins grant_type=refresh_token + refresh_token value (adversarial anchor)", async () => {
		const { fetchImpl, calls } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ access_token: "a" }),
		});
		await refreshTokens({
			refreshToken: "R-TOKEN",
			fetchImpl,
			endpoint: "https://x.test",
		});
		const form = new URLSearchParams(calls[0]?.body);
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("R-TOKEN");
		expect(form.get("client_id")).toBeNull();
	});

	it("includes client_id when passed", async () => {
		const { fetchImpl, calls } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ access_token: "a" }),
		});
		await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
			clientId: "cma-cli",
		});
		const form = new URLSearchParams(calls[0]?.body);
		expect(form.get("client_id")).toBe("cma-cli");
	});
});

describe("refreshTokens — classified failures", () => {
	it("4xx with invalid_grant body → invalid_grant (distinct from network)", async () => {
		const { fetchImpl } = makeFetch({
			ok: false,
			status: 400,
			body: JSON.stringify({ error: "invalid_grant", error_description: "expired" }),
		});
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("invalid_grant");
		expect(result.detail).toBe("expired");
	});

	it("4xx with invalid_grant but NO error_description → falls back to default detail", async () => {
		const { fetchImpl } = makeFetch({
			ok: false,
			status: 400,
			body: JSON.stringify({ error: "invalid_grant" }),
		});
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("invalid_grant");
		expect(result.detail).toBe("refresh_token rejected");
	});

	it("4xx with other error kind → unexpected", async () => {
		const { fetchImpl } = makeFetch({
			ok: false,
			status: 400,
			body: JSON.stringify({ error: "invalid_client" }),
		});
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("5xx with non-JSON body → unexpected", async () => {
		const { fetchImpl } = makeFetch({ ok: false, status: 502, body: "<html>bad gateway</html>" });
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("fetch rejects with a raw string → network (exercises errMsg non-Error branch)", async () => {
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl: fetchRejectsRawString,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("network");
		expect(result.detail).toBe("bare string");
	});

	it("fetch rejects → network", async () => {
		const { fetchImpl } = makeFetch(new Error("dns"));
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("network");
	});

	it("body.text() rejects → network", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: (): Promise<string> => Promise.reject(new Error("stream fell over")),
		});
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("network");
	});

	it("2xx with non-JSON body → malformed", async () => {
		const { fetchImpl } = makeFetch({ ok: true, status: 200, body: "not json" });
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});

	it("2xx JSON missing access_token → malformed", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ token_type: "Bearer" }),
		});
		const result = await refreshTokens({
			refreshToken: "R",
			fetchImpl,
			endpoint: "https://x.test",
		});
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});
});

describe("refreshTokens — endpoint required", () => {
	it("returns a classified {ok:false, kind:'unexpected'} when endpoint is empty (caller must supply)", async () => {
		// A throwing default would crash the account-refresh CLI path on any
		// call that omitted the endpoint override; classify it as a normal
		// verify-family failure so the caller renders it as an actionable
		// error instead of an unhandled promise rejection (Rule 12: fail
		// loud, but through the return channel not the exception channel).
		const { fetchImpl } = makeFetch({ ok: true, status: 200, body: "{}" });
		const result = await refreshTokens({ refreshToken: "R", fetchImpl, endpoint: "" });
		expect(result).toMatchObject({
			ok: false,
			kind: "unexpected",
			detail: expect.stringMatching(/endpoint is required/u),
		});
	});
});
