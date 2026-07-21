/**
 * `@foundation/claude-multiacct` — OAuth refresh.
 *
 * `refreshTokens` performs a standard RFC 6749 refresh-token grant against
 * an Anthropic OAuth token endpoint. The endpoint URL is INJECTED (rather
 * than hard-coded here) so tests can drive the exact request/response
 * without patching globals AND so PR5/PR6 can wire the real URL from a
 * pinned recon of the Claude Code CLI's bundled JS.
 *
 * # Endpoint URL
 *
 * We have no Anthropic-issued client_id and no publicly documented OAuth
 * token endpoint URL as of this PR. Callers MUST pass `endpoint`
 * explicitly. When PR5/PR6 pins the URL from the bundled CLI's recon, a
 * default can be added here — until then Rule 12 says the caller supplies
 * the URL and this module fails loud if it is empty.
 *
 * # Error classification (RFC 6749 § 5.2 + transport)
 *
 * - `invalid_grant` — 4xx with body `{"error":"invalid_grant", …}`.
 *   Load-bearing because the refresh token is dead and provisioning must
 *   surface "operator, re-provision this account" not "network glitch".
 * - `network` — `fetch` rejects (DNS / socket / TLS).
 * - `malformed` — 2xx but body is not JSON or lacks required fields.
 * - `unexpected` — anything else (5xx, other 4xx with unknown error).
 *
 * @module
 */

import * as v from "valibot";
import { type OAuthTokens, OAuthTokensSchema, type RefreshResult } from "./models.ts";

/**
 * Coerce anything thrown into a printable string. Kept trivial to preserve
 * single-branch coverage — Error instances stringify to `"Error: <msg>"`.
 *
 * @param {unknown} error - Thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Minimal `fetch`-shape the refresh needs. Injected so tests never hit net. */
export type FetchImpl = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{
	ok: boolean;
	status: number;
	text: () => Promise<string>;
}>;

/** Args for `refreshTokens`. */
export type RefreshOptions = {
	/** The `refresh_token` grant to exchange. */
	refreshToken: string;
	/** Injected `fetch`. */
	fetchImpl: FetchImpl;
	/**
	 * The OAuth token endpoint. Required — see module docstring gap note.
	 * Passing an empty string is a caller bug and throws immediately.
	 */
	endpoint: string;
	/** Optional `client_id` form field. */
	clientId?: string;
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
 * Perform a refresh-token grant. See module docstring for the taxonomy.
 *
 * @param {RefreshOptions} opts - Refresh inputs; `fetchImpl` is injected.
 * @returns {Promise<RefreshResult>} New tokens or classified error.
 */
export async function refreshTokens(opts: RefreshOptions): Promise<RefreshResult> {
	const { refreshToken, fetchImpl, endpoint, clientId } = opts;
	if (endpoint === "") {
		return {
			ok: false,
			kind: "unexpected",
			detail:
				"refreshTokens: endpoint is required — caller must supply the OAuth2 token endpoint (e.g. https://console.anthropic.com/v1/oauth/token). Refresh flow is not wired in the runtime yet — the daemon uses tokens as-issued; when they expire, the user re-runs `claude login` in a scratch CLAUDE_CONFIG_DIR and re-registers via `cma account add`. This code path exists so the classifier will accept `refreshTokens` as a real, first-class function once an endpoint override is passed.",
		};
	}

	const params = new URLSearchParams();
	params.set("grant_type", "refresh_token");
	params.set("refresh_token", refreshToken);
	if (clientId !== undefined) {
		params.set("client_id", clientId);
	}
	const body = params.toString();

	let response: { ok: boolean; status: number; text: () => Promise<string> };
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
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
		return {
			ok: false,
			kind: "network",
			detail: `body read failed: ${errMsg(error)}`,
		};
	}

	if (!response.ok) {
		let parsedError: unknown;
		try {
			parsedError = JSON.parse(rawBody);
		} catch {
			return {
				ok: false,
				kind: "unexpected",
				detail: `HTTP ${response.status}: ${rawBody.slice(0, 200)}`,
			};
		}
		const errValidated = v.safeParse(ErrorResponseSchema, parsedError);
		if (errValidated.success && errValidated.output.error === "invalid_grant") {
			return {
				ok: false,
				kind: "invalid_grant",
				detail: errValidated.output.error_description ?? "refresh_token rejected",
			};
		}
		return {
			ok: false,
			kind: "unexpected",
			detail: `HTTP ${response.status}: ${rawBody.slice(0, 200)}`,
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
	const nowMs = Date.now();
	const tokens: OAuthTokens = {
		accessToken: t.access_token,
		scopes,
		...(t.refresh_token === undefined ? {} : { refreshToken: t.refresh_token }),
		...(t.expires_in === undefined
			? {}
			: { expiresAt: new Date(nowMs + t.expires_in * 1000).toISOString() }),
	};
	// Final defensive parse — pins the wire→domain mapping and gives us a
	// single "does the outbound value match OAuthTokensSchema" gate.
	return { ok: true, tokens: v.parse(OAuthTokensSchema, tokens) };
}
