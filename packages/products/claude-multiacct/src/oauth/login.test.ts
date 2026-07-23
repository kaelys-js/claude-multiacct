/* oxlint-disable vitest/expect-expect, typescript/explicit-function-return-type, unicorn/numeric-separators-style, unicorn/consistent-function-scoping */
/**
 * Intent: the OAuth login primitives are the cryptographic + wire-format layer
 * of the in-app "add another account" flow. Load-bearing behaviours pinned here:
 *
 *   1. PKCE is real S256 — `challenge === base64url(SHA-256(verifier))`, so the
 *      value in the authorize URL is a hash, never the secret verifier. A
 *      regression to plain (challenge === verifier) trips the pin.
 *   2. The authorize URL carries EXACTLY the standard OAuth2/PKCE params with the
 *      pinned Claude Code client_id + scopes + S256 method AND the MANUAL redirect
 *      (`platform.claude.com/oauth/code/callback`) — the account client rejects
 *      loopback. Adversarial: drop `code_challenge_method`, or point the redirect
 *      at a 127.0.0.1 loopback, and the "well-formed authorize URL" test reddens.
 *   3. The token exchange body is the EXACT Claude Code shape (JSON, not form) at
 *      the MANUAL redirect, with the pinned `anthropic-version` header, and errors
 *      are CLASSIFIED — `invalid_grant` distinct from `network`/`malformed`.
 *   4. No secret leaks: the code + verifier never appear in the authorize URL.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertNotOk, assertOk } from "./test-utils.ts";
import {
	buildAuthorizeUrl,
	CLAUDE_AUTHORIZE_URL,
	CLAUDE_CODE_CLIENT_ID,
	CLAUDE_MANUAL_REDIRECT_URL,
	CLAUDE_OAUTH_SCOPES,
	CLAUDE_TOKEN_URL,
	createPkcePair,
	createState,
	exchangeAuthorizationCode,
	type LoginFetch,
} from "./login.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function makeFetch(response: { ok: boolean; status: number; body: string } | Error): {
	fetchImpl: LoginFetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchImpl: LoginFetch = (url, init) => {
		calls.push({ url, method: init.method, headers: init.headers, body: init.body });
		if (response instanceof Error) {
			return Promise.reject(response);
		}
		return Promise.resolve({
			ok: response.ok,
			status: response.status,
			text: () => Promise.resolve(response.body),
		});
	};
	return { fetchImpl, calls };
}

// A deterministic random source: fills each byte with an incrementing counter so
// two calls in one test differ (verifier vs state) yet stay reproducible.
function seededRandom(seed: number): (size: number) => Buffer {
	let n = seed;
	return (size: number) => {
		const buf = Buffer.alloc(size);
		for (let i = 0; i < size; i += 1) {
			buf[i] = (n + i) % 256;
		}
		n += 1;
		return buf;
	};
}

describe("createPkcePair", () => {
	it("challenge is base64url(SHA-256(verifier)) — a hash, never the secret", () => {
		const { verifier, challenge } = createPkcePair(seededRandom(1));
		const expected = createHash("sha256").update(verifier).digest().toString("base64url");
		expect(challenge).toBe(expected);
		expect(challenge).not.toBe(verifier);
		// base64url — no +, /, or = padding.
		expect(verifier).not.toMatch(/[+/=]/u);
		expect(challenge).not.toMatch(/[+/=]/u);
	});

	it("defaults to node crypto when no random source is injected", () => {
		const a = createPkcePair();
		const b = createPkcePair();
		expect(a.verifier).not.toBe(b.verifier);
	});
});

describe("createState", () => {
	it("returns a base64url nonce and differs from the PKCE verifier under the same seed", () => {
		const random = seededRandom(5);
		const state = createState(random);
		const { verifier } = createPkcePair(random);
		expect(state).not.toBe(verifier);
		expect(state).not.toMatch(/[+/=]/u);
	});

	it("defaults to node crypto", () => {
		expect(createState()).not.toBe(createState());
	});
});

describe("buildAuthorizeUrl", () => {
	it("is a well-formed authorize URL with the pinned client_id, scopes, S256, and the MANUAL redirect", () => {
		const url = new URL(
			buildAuthorizeUrl({
				redirectUri: CLAUDE_MANUAL_REDIRECT_URL,
				state: "st4te",
				codeChallenge: "chall",
			}),
		);
		expect(`${url.origin}${url.pathname}`).toBe(CLAUDE_AUTHORIZE_URL);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBe(CLAUDE_CODE_CLIENT_ID);
		// The account client rejects loopback — the redirect is the manual
		// copy-the-code callback, never a 127.0.0.1 URI.
		expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_MANUAL_REDIRECT_URL);
		expect(CLAUDE_MANUAL_REDIRECT_URL).toBe("https://platform.claude.com/oauth/code/callback");
		expect(url.searchParams.get("redirect_uri")).not.toContain("127.0.0.1");
		expect(url.searchParams.get("scope")).toBe(CLAUDE_OAUTH_SCOPES.join(" "));
		expect(url.searchParams.get("state")).toBe("st4te");
		expect(url.searchParams.get("code_challenge")).toBe("chall");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("honors endpoint/client/scope overrides", () => {
		const url = new URL(
			buildAuthorizeUrl({
				authorizeUrl: "https://example.test/authorize",
				clientId: "cid-override",
				scopes: ["a", "b"],
				redirectUri: "http://127.0.0.1:1/callback",
				state: "s",
				codeChallenge: "c",
			}),
		);
		expect(url.origin + url.pathname).toBe("https://example.test/authorize");
		expect(url.searchParams.get("client_id")).toBe("cid-override");
		expect(url.searchParams.get("scope")).toBe("a b");
	});
});

describe("exchangeAuthorizationCode", () => {
	it("POSTs the exact Claude Code JSON body and returns parsed tokens", async () => {
		const { fetchImpl, calls } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({
				access_token: "sk-ant-oat01-abc",
				refresh_token: "sk-ant-ort01-def",
				expires_in: 3600,
				scope: "user:profile user:inference",
				token_type: "Bearer",
			}),
		});
		const result = await exchangeAuthorizationCode({
			code: "the-code",
			codeVerifier: "the-verifier",
			state: "the-state",
			redirectUri: CLAUDE_MANUAL_REDIRECT_URL,
			fetchImpl,
		});
		assertOk(result);
		expect(result.tokens.accessToken).toBe("sk-ant-oat01-abc");
		expect(result.tokens.refreshToken).toBe("sk-ant-ort01-def");
		expect(result.tokens.scopes).toStrictEqual(["user:profile", "user:inference"]);
		expect(result.tokens.expiresAt).toMatch(/^\d{4}-/u);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(CLAUDE_TOKEN_URL);
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
		// The bundle sends the anthropic-version header on the exchange; drop it
		// and this reddens.
		expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");
		const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
		// The exchange redirect_uri MUST be the manual callback — the same URI the
		// authorize request used. A loopback here fails with invalid redirect_uri.
		expect(sent).toStrictEqual({
			grant_type: "authorization_code",
			client_id: CLAUDE_CODE_CLIENT_ID,
			code: "the-code",
			redirect_uri: CLAUDE_MANUAL_REDIRECT_URL,
			code_verifier: "the-verifier",
			state: "the-state",
		});
	});

	it("omits refreshToken/expiresAt when the endpoint omits them", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ access_token: "sk-ant-oat01-only" }),
		});
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
			clientId: "cid",
			tokenUrl: "https://example.test/token",
		});
		assertOk(result);
		expect(result.tokens.refreshToken).toBeUndefined();
		expect(result.tokens.expiresAt).toBeUndefined();
		expect(result.tokens.scopes).toStrictEqual([]);
	});

	it("classifies invalid_grant from a 4xx error body", async () => {
		const { fetchImpl } = makeFetch({
			ok: false,
			status: 400,
			body: JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
		});
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("invalid_grant");
		expect(result.detail).toBe("code expired");
	});

	it("classifies a non-invalid_grant JSON error as unexpected", async () => {
		const { fetchImpl } = makeFetch({
			ok: false,
			status: 400,
			body: JSON.stringify({ error: "invalid_client" }),
		});
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("classifies a non-JSON error body as unexpected", async () => {
		const { fetchImpl } = makeFetch({ ok: false, status: 500, body: "<html>oops</html>" });
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("unexpected");
	});

	it("classifies a fetch rejection as network", async () => {
		const { fetchImpl } = makeFetch(new Error("socket hangup"));
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("network");
		expect(result.detail).toBe("socket hangup");
	});

	it("classifies a non-JSON 2xx body as malformed", async () => {
		const { fetchImpl } = makeFetch({ ok: true, status: 200, body: "not json" });
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});

	it("classifies a 2xx body missing access_token as malformed", async () => {
		const { fetchImpl } = makeFetch({
			ok: true,
			status: 200,
			body: JSON.stringify({ token_type: "Bearer" }),
		});
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("malformed");
	});

	it("classifies a body-read failure as network", async () => {
		const fetchImpl: LoginFetch = () =>
			Promise.resolve({
				ok: true,
				status: 200,
				text: () => Promise.reject(new Error("read fail")),
			});
		const result = await exchangeAuthorizationCode({
			code: "c",
			codeVerifier: "v",
			state: "s",
			redirectUri: "http://127.0.0.1:9/callback",
			fetchImpl,
		});
		assertNotOk(result);
		expect(result.kind).toBe("network");
		expect(result.detail).toContain("body read failed");
	});
});
