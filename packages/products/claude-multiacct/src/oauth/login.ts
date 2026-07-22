/**
 * `@foundation/claude-multiacct` — OAuth authorization-code + PKCE primitives.
 *
 * The pure, injectable pieces of an in-app "sign in to another Claude account"
 * flow. No sockets, no process state — {@link ./login-manager.ts} owns the
 * loopback listener and the stateful session bookkeeping; this module is the
 * cryptography + wire-format layer so every branch is unit-testable with an
 * injected `fetch` and an injected random source.
 *
 * # Why these exact parameters
 *
 * `claude-multiacct` wraps the real Claude Code CLI, which itself authenticates
 * via Anthropic's public OAuth client. The parameters below are the SAME public
 * client the CLI uses, read verbatim from the installed
 * `Claude.app/Contents/Resources/app.asar` (the desktop app bundles the Claude
 * Code login flow). Pinned 2026-07 from that bundle:
 *
 *   - `CLIENT_ID` — `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, the constant named
 *     `CLIENT_ID` in the bundle's OAuth config object (alongside
 *     `MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback"`).
 *   - `AUTHORIZE_URL` — `https://claude.com/cai/oauth/authorize`
 *     (`CLAUDE_AI_AUTHORIZE_URL` in the bundle). This is the authorize surface a
 *     browser-signed-in user hits; it lets the user pick / sign in to the target
 *     account before consenting.
 *   - `TOKEN_URL` — `https://platform.claude.com/v1/oauth/token` (`TOKEN_URL`).
 *   - Scopes — `org:create_api_key user:profile user:inference`, the Claude Code
 *     scope set (`EF=[bF,Yk]` plus `user:inference` in the bundle; `bF=
 *     "org:create_api_key"`, `Yk="user:profile"`, `yF="user:inference"`).
 *   - Loopback redirect — `http://127.0.0.1:<port>/callback`, the automatic-flow
 *     redirect the bundle binds (`http://127.0.0.1:${port}/callback`). The public
 *     client registers the loopback host per RFC 8252 §7.3, so any ephemeral port
 *     is accepted.
 *
 * The token-exchange request mirrors the bundle exactly: a JSON body (NOT
 * form-encoded) `{grant_type:"authorization_code", client_id, code, redirect_uri,
 * code_verifier, state}` with `Content-Type: application/json`.
 *
 * # Security
 *
 * - PKCE S256 is mandatory: a `code_verifier` never leaves this process, only its
 *   SHA-256 `code_challenge` travels in the authorize URL.
 * - `state` is a 32-byte CSRF nonce; the manager rejects any callback whose
 *   `state` does not match the one it minted (see {@link ./login-manager.ts}).
 * - Tokens and codes are NEVER logged. Callers get classified `kind`s, never the
 *   secret.
 *
 * @module
 */

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import * as v from "valibot";
import { type OAuthTokens, OAuthTokensSchema } from "./models.ts";

/** Public Claude Code OAuth client id (see module docstring for provenance). */
export const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Authorize surface a browser-signed-in user hits (`CLAUDE_AI_AUTHORIZE_URL`). */
export const CLAUDE_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
/** OAuth2 token endpoint (`TOKEN_URL`). */
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Claude Code scope set, space-joined in the authorize URL. */
export const CLAUDE_OAUTH_SCOPES: readonly string[] = [
	"org:create_api_key",
	"user:profile",
	"user:inference",
];

/** Injected random-bytes source. Defaults to `node:crypto.randomBytes`. */
export type RandomBytesFn = (size: number) => Buffer;

/** A PKCE verifier + its S256 challenge. The verifier is secret; never log it. */
export type PkcePair = {
	/** The high-entropy secret held in-process and sent only at token exchange. */
	verifier: string;
	/** base64url(SHA-256(verifier)) — the value that travels in the authorize URL. */
	challenge: string;
};

/** Minimal `fetch`-shape the token exchange needs. Injected so tests never hit net. */
export type LoginFetch = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Classified failure kinds for the code→token exchange. */
export type ExchangeFailKind = "invalid_grant" | "network" | "malformed" | "unexpected";

/** Result of {@link exchangeAuthorizationCode}. */
export type ExchangeResult =
	| { ok: true; tokens: OAuthTokens }
	| { ok: false; kind: ExchangeFailKind; detail: string };

/**
 * base64url-encode a buffer with no padding — the encoding PKCE (RFC 7636) and
 * the CSRF `state` both use.
 *
 * @param {Buffer} buf - Bytes to encode.
 * @returns {string} Padding-free base64url text.
 */
function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/**
 * Create a PKCE verifier + S256 challenge. The verifier is 32 random bytes of
 * base64url (43 chars, well within RFC 7636's 43–128); the challenge is
 * base64url(SHA-256(verifier)).
 *
 * @param {RandomBytesFn} randomBytes - Injected entropy; defaults to node crypto.
 * @returns {PkcePair} The secret verifier and its public challenge.
 */
export function createPkcePair(randomBytes: RandomBytesFn = nodeRandomBytes): PkcePair {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/**
 * Mint a CSRF `state` nonce — 32 random bytes of base64url.
 *
 * @param {RandomBytesFn} randomBytes - Injected entropy; defaults to node crypto.
 * @returns {string} An opaque, single-use state value.
 */
export function createState(randomBytes: RandomBytesFn = nodeRandomBytes): string {
	return base64url(randomBytes(32));
}

/** Args for {@link buildAuthorizeUrl}. */
export type AuthorizeUrlParams = {
	/** Authorize endpoint; defaults to {@link CLAUDE_AUTHORIZE_URL}. */
	authorizeUrl?: string;
	/** OAuth client id; defaults to {@link CLAUDE_CODE_CLIENT_ID}. */
	clientId?: string;
	/** The loopback redirect the listener is bound to (`http://127.0.0.1:<port>/callback`). */
	redirectUri: string;
	/** Scopes to request; defaults to {@link CLAUDE_OAUTH_SCOPES}. */
	scopes?: readonly string[];
	/** The CSRF state nonce from {@link createState}. */
	state: string;
	/** The PKCE S256 challenge from {@link createPkcePair}. */
	codeChallenge: string;
};

/**
 * Build the authorization-code + PKCE authorize URL. Every parameter is a
 * standard OAuth2/PKCE field; the resulting URL is what the user's browser opens
 * to sign in and consent.
 *
 * @param {AuthorizeUrlParams} params - Redirect, state, challenge, and overrides.
 * @returns {string} The fully-formed authorize URL.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
	const url = new URL(params.authorizeUrl ?? CLAUDE_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId ?? CLAUDE_CODE_CLIENT_ID);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", (params.scopes ?? CLAUDE_OAUTH_SCOPES).join(" "));
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

/** Args for {@link exchangeAuthorizationCode}. */
export type ExchangeOptions = {
	/** The authorization `code` captured on the loopback callback. */
	code: string;
	/** The PKCE `verifier` that pairs with the challenge sent to authorize. */
	codeVerifier: string;
	/** The CSRF `state` that was minted for this login (echoed to the endpoint). */
	state: string;
	/** The exact `redirect_uri` used in the authorize request. */
	redirectUri: string;
	/** Injected fetch. */
	fetchImpl: LoginFetch;
	/** OAuth client id; defaults to {@link CLAUDE_CODE_CLIENT_ID}. */
	clientId?: string;
	/** Token endpoint; defaults to {@link CLAUDE_TOKEN_URL}. */
	tokenUrl?: string;
};

const TokenResponseSchema = v.object({
	access_token: v.pipe(v.string(), v.minLength(1)),
	refresh_token: v.optional(v.pipe(v.string(), v.minLength(1))),
	expires_in: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	scope: v.optional(v.string()),
	token_type: v.optional(v.string()),
});

const ErrorResponseSchema = v.object({
	error: v.string(),
	error_description: v.optional(v.string()),
});

/**
 * Coerce a throwable into a printable string. Single branch for coverage.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Exchange an authorization `code` for OAuth tokens at the token endpoint. The
 * request body mirrors the Claude Code CLI exactly — a JSON payload with the
 * PKCE `code_verifier` and the echoed `state`.
 *
 * Error taxonomy (RFC 6749 §5.2 + transport), mirroring `./refresh.ts`:
 *   - `invalid_grant` — 4xx with `{"error":"invalid_grant"}` (bad/expired code).
 *   - `network` — `fetch` rejected (DNS / socket / TLS) or body read failed.
 *   - `malformed` — 2xx but body is not JSON or lacks `access_token`.
 *   - `unexpected` — anything else (5xx, other 4xx).
 *
 * The `code` and the resulting tokens are NEVER logged here.
 *
 * @param {ExchangeOptions} opts - Exchange inputs; `fetchImpl` is injected.
 * @returns {Promise<ExchangeResult>} Tokens on success, classified error otherwise.
 */
export async function exchangeAuthorizationCode(opts: ExchangeOptions): Promise<ExchangeResult> {
	const body = JSON.stringify({
		grant_type: "authorization_code",
		client_id: opts.clientId ?? CLAUDE_CODE_CLIENT_ID,
		code: opts.code,
		redirect_uri: opts.redirectUri,
		code_verifier: opts.codeVerifier,
		state: opts.state,
	});

	let response: { ok: boolean; status: number; text: () => Promise<string> };
	try {
		response = await opts.fetchImpl(opts.tokenUrl ?? CLAUDE_TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body,
		});
	} catch (error) {
		return { ok: false, kind: "network", detail: errMsg(error) };
	}

	let rawBody: string;
	try {
		rawBody = await response.text();
	} catch (error) {
		return { ok: false, kind: "network", detail: `body read failed: ${errMsg(error)}` };
	}

	if (!response.ok) {
		let parsedError: unknown;
		try {
			parsedError = JSON.parse(rawBody);
		} catch {
			return {
				ok: false,
				kind: "unexpected",
				detail: `HTTP ${String(response.status)}: ${rawBody.slice(0, 200)}`,
			};
		}
		const errValidated = v.safeParse(ErrorResponseSchema, parsedError);
		if (errValidated.success && errValidated.output.error === "invalid_grant") {
			return {
				ok: false,
				kind: "invalid_grant",
				detail: errValidated.output.error_description ?? "authorization code rejected",
			};
		}
		return {
			ok: false,
			kind: "unexpected",
			detail: `HTTP ${String(response.status)}: ${rawBody.slice(0, 200)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch (error) {
		return {
			ok: false,
			kind: "malformed",
			detail: `token response was not JSON: ${errMsg(error)}`,
		};
	}
	const validated = v.safeParse(TokenResponseSchema, parsed);
	if (!validated.success) {
		return {
			ok: false,
			kind: "malformed",
			detail: `token response did not match: ${validated.issues[0].message}`,
		};
	}
	const t = validated.output;
	const scopes = t.scope === undefined ? [] : t.scope.split(/\s+/u).filter((s) => s.length > 0);
	const tokens: OAuthTokens = {
		accessToken: t.access_token,
		scopes,
		...(t.refresh_token === undefined ? {} : { refreshToken: t.refresh_token }),
		...(t.expires_in === undefined
			? {}
			: { expiresAt: new Date(Date.now() + t.expires_in * 1000).toISOString() }),
	};
	return { ok: true, tokens: v.parse(OAuthTokensSchema, tokens) };
}
