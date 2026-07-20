/**
 * `@foundation/claude-multiacct` — pure request-validation helpers for the
 * loopback HTTP bridge.
 *
 * The bridge is bound to `127.0.0.1` (see `./server.ts`), but a loopback
 * bind is not a security boundary by itself: any local process can reach
 * loopback ports. The security is layered:
 *
 *   - `assertLoopback(host)` — a defense-in-depth invariant. If some
 *     future refactor accidentally binds a non-loopback interface, this
 *     throws on the very first request so the daemon fails loud rather
 *     than silently exposing itself to the LAN.
 *   - Origin allowlist — CORS preflight + main-request check against a
 *     narrow constant list. `claude.ai` is the extension's document
 *     origin; the extension origin (`chrome-extension://<id>`) is added
 *     in PR5b when the extension id is known. No wildcard, ever.
 *   - Shared-secret header (`x-cma-bridge-secret`) — bearer token
 *     minted per daemon start, handed to the extension via bridge.json.
 *     Missing/mismatch → 401. This is the actual auth gate; the Origin
 *     check is defense-in-depth against a browser sending a foreign
 *     Origin. Web pages cannot read arbitrary local files, so knowledge
 *     of the secret proves the caller has filesystem-level access.
 *
 * Every function here is pure — no I/O, no closures over process state.
 * Testable in isolation.
 *
 * @module
 */

/**
 * Origin allowlist. Extension origin (`chrome-extension://<id>`) will be
 * appended in PR5b once the extension is packaged and the id is stable.
 * Keep this a single append point — never a wildcard, never a regex.
 */
export const ALLOWED_ORIGINS: readonly string[] = ["https://claude.ai"];

/** Header name for the shared bridge secret. Lowercased per HTTP norms. */
export const BRIDGE_SECRET_HEADER = "x-cma-bridge-secret";

/** Result shape of a request validation. `ok:true` gates route dispatch. */
export type ValidateResult =
	| { ok: true }
	| { ok: false; status: 401 | 403; body: { ok: false; reason: string } };

/** Result shape of a preflight response. Header/status/body pre-materialized. */
export type PreflightResponse = {
	status: 204;
	headers: Record<string, string>;
};

/**
 * True iff `origin` is in the allowlist. Case-sensitive by spec (Origin is
 * a URL, not a hostname).
 *
 * @param {string | undefined} origin - The request's `Origin` header value.
 * @returns {boolean} Whether the origin is allowed.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
	return origin !== undefined && ALLOWED_ORIGINS.includes(origin);
}

/**
 * Assert that `host` is a loopback address. Throws on anything else. Called
 * from `server.ts` on the socket's `remoteAddress` for every incoming
 * connection so a mis-bind fails loud on request 1.
 *
 * @param {string | undefined} host - Remote address of the connection.
 * @returns {void}
 */
export function assertLoopback(host: string | undefined): void {
	if (host !== "127.0.0.1" && host !== "::1" && host !== "::ffff:127.0.0.1") {
		throw new Error(`security: refusing non-loopback remoteAddress ${String(host)}`);
	}
}

/**
 * Build the CORS preflight response for `origin`. Returns a 204 with the
 * echoed allowed origin plus the small header/method whitelist the bridge
 * actually needs. Only call this when the origin is already allowed —
 * callers gate first via `isAllowedOrigin`.
 *
 * @param {string} origin - The request's allowed `Origin`.
 * @returns {PreflightResponse} Materialized response.
 */
export function corsPreflight(origin: string): PreflightResponse {
	return {
		status: 204,
		headers: {
			"access-control-allow-origin": origin,
			"access-control-allow-headers": `content-type,${BRIDGE_SECRET_HEADER}`,
			"access-control-allow-methods": "GET,POST,OPTIONS",
			"access-control-max-age": "600",
		},
	};
}

/**
 * Validate an incoming non-preflight request. Rejects on missing/foreign
 * Origin (403) or missing/mismatched shared secret (401). Health checks
 * skip both gates by using this helper with `allowNoSecret:true`.
 *
 * @param {object} args - Header snapshot.
 * @param {string | undefined} args.origin - Request `Origin`.
 * @param {string | undefined} args.secretHeader - Value of `x-cma-bridge-secret`.
 * @param {string} args.expectedSecret - The daemon's current secret.
 * @returns {ValidateResult} Allow or a reason-bearing rejection.
 */
export function validateAuth(args: {
	origin: string | undefined;
	secretHeader: string | undefined;
	expectedSecret: string;
}): ValidateResult {
	if (!isAllowedOrigin(args.origin)) {
		return {
			ok: false,
			status: 403,
			body: { ok: false, reason: `origin not allowed: ${String(args.origin)}` },
		};
	}
	if (args.secretHeader === undefined || args.secretHeader !== args.expectedSecret) {
		return {
			ok: false,
			status: 401,
			body: { ok: false, reason: "missing or invalid bridge secret" },
		};
	}
	return { ok: true };
}
