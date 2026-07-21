/**
 * `@foundation/claude-multiacct` — pure route handlers for the loopback
 * HTTP bridge.
 *
 * The extension (PR5b) talks to the daemon via five endpoints:
 *
 *   - `GET /health` — liveness + version, no auth. Used by launchd + the
 *     extension's readiness probe.
 *   - `GET /accounts` — the current pool (read-only, always allowed).
 *   - `GET /usage/:accountUuid` — subscription/tier + last-known usage.
 *     Verifies the stored token against the CLI; read-only.
 *   - `POST /choice/:sessionUuid` — pin an account to a session; the
 *     shim reads this on the CLI-spawn path. **Requires the feature
 *     flag on** — landing this PR must not change behavior when the
 *     flag is off.
 *   - Any other method/path → 404 JSON.
 *
 * Each handler is a pure function `(req, deps) → RouteResult`. Every input
 * that crosses a trust boundary (path uuid, request body) is
 * valibot-validated; failures return 400 with the issue path so operators
 * can act (Rule 12). Handlers do NOT touch the wire — `server.ts` owns
 * the socket bridging.
 *
 * @module
 */

import * as v from "valibot";
import type { Account } from "../domain/account.ts";
import type { SessionAccountChoice } from "../domain/session-choice.ts";
import type { VerifyResult } from "../oauth/models.ts";
import type { ChoiceStore } from "../ports.ts";
import { flagOn as flagOnEnv } from "../oauth/provisioning.ts";

/** JSON body sent on the wire. Any serializable value. */
export type JsonBody =
	| Record<string, unknown>
	| readonly unknown[]
	| string
	| number
	| boolean
	| null;

/** Response every handler yields — status + JSON body. */
export type RouteResult = {
	status: number;
	body: JsonBody;
};

/** Verify a single account's stored token. Injected so tests never spawn. */
export type VerifyAccountFn = (uuid: string) => Promise<{
	ok: boolean;
	verify?: VerifyResult;
	reason?: string;
	detail?: string;
	needsRefresh?: boolean;
}>;

/** List accounts function. Injected so tests never touch disk. */
export type ListAccountsFn = () => Promise<Account[]>;

/**
 * Signal the running shim for `sessionUuid` that its account choice changed
 * so it hot-swaps the child claude with a fresh OAuth token. Returns the
 * outcome of the signal attempt — the daemon logs it but never surfaces it
 * to the HTTP caller (mid-session swap is fire-and-forget from the extension's
 * point of view: the choice is persisted regardless of shim reachability).
 */
export type SignalSwapFn = (sessionUuid: string) => Promise<"signalled" | "no-owner" | "stale">;

/** Injected port bundle every handler takes. */
export type RouteDeps = {
	listAccounts: ListAccountsFn;
	verifyAccount: VerifyAccountFn;
	choiceStore: Pick<ChoiceStore, "write">;
	/** True iff `CLAUDE_MULTIACCT_ENABLE_SHIM=1`. Mirrors the shim gate. */
	flagOn: boolean;
	/** Package version stamped into /health responses. */
	version: string;
	/** Bound port the server is listening on. */
	port: number;
	/** ISO timestamp the bridge secret was last generated. */
	secretRotatedAt: string;
	/**
	 * Signal the shim owning `sessionUuid` to hot-swap. Wired to
	 * `cli-shim/session-pid.ts::signalSwap` in production; tests inject a spy.
	 */
	signalSwap: SignalSwapFn;
	/** Info-level log sink for signalling outcomes. */
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

/** Minimal request shape the handlers consume. Serves `server.ts`'s bridge. */
export type RouteRequest = {
	method: string;
	pathname: string;
	body?: unknown;
};

const UuidSchema = v.pipe(v.string(), v.uuid());

const ChoiceBodySchema = v.strictObject({
	accountUuid: UuidSchema,
});

/**
 * Build a 400 response describing a valibot validation failure. The issue
 * path is embedded so an operator can see WHICH field went wrong (Rule 12).
 *
 * @param {v.BaseIssue<unknown>[]} issues - Non-empty valibot issue list.
 * @param {string} context - Human context (e.g. `"body"`, `"path :uuid"`).
 * @returns {RouteResult} 400 with reason + issue path.
 */
function badRequest(issues: Array<v.BaseIssue<unknown>>, context: string): RouteResult {
	const [first] = issues;
	const path = (first?.path ?? []).map((p) => String(p.key)).join(".");
	return {
		status: 400,
		body: {
			ok: false,
			reason: `invalid ${context}${path === "" ? "" : ` at ${path}`}: ${first?.message ?? "unknown"}`,
		},
	};
}

/**
 * Health handler — no auth, no flag gate.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @returns {RouteResult} 200 with version/port/rotation timestamp.
 */
export function handleHealth(deps: RouteDeps): RouteResult {
	return {
		status: 200,
		body: {
			ok: true,
			version: deps.version,
			port: deps.port,
			secretRotatedAt: deps.secretRotatedAt,
		},
	};
}

/**
 * List accounts — always allowed, read-only.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @returns {Promise<RouteResult>} 200 with the current account pool.
 */
export async function handleListAccounts(deps: RouteDeps): Promise<RouteResult> {
	const accounts = await deps.listAccounts();
	return { status: 200, body: { ok: true, accounts } };
}

/**
 * Verify one account (by uuid) — always allowed, read-only.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} uuid - Account uuid from the path.
 * @returns {Promise<RouteResult>} 200 with verify result, 400 on bad uuid, or 404.
 */
export async function handleUsage(deps: RouteDeps, uuid: string): Promise<RouteResult> {
	const parsed = v.safeParse(UuidSchema, uuid);
	if (!parsed.success) {
		return badRequest(parsed.issues, "path :accountUuid");
	}
	const result = await deps.verifyAccount(parsed.output);
	if (!result.ok) {
		return {
			status: 404,
			body: { ok: false, reason: result.reason ?? "not_found", detail: result.detail ?? "" },
		};
	}
	return {
		status: 200,
		body: { ok: true, verify: result.verify, needsRefresh: result.needsRefresh === true },
	};
}

/**
 * Set a session→account choice. **Requires the feature flag on** —
 * flag-off returns 403 `{ok:false, skipped:true, reason:"flag-off"}` so
 * landing PR5a with the flag off changes NO behavior. Adversarial:
 * bypass the flag guard here and the flag-off route test flips red.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} sessionUuid - Session uuid from the path.
 * @param {unknown} body - Parsed request body.
 * @returns {Promise<RouteResult>} 200 with the persisted choice, 400/403 otherwise.
 */
export async function handleSetChoice(
	deps: RouteDeps,
	sessionUuid: string,
	body: unknown,
): Promise<RouteResult> {
	if (!deps.flagOn) {
		return {
			status: 403,
			body: { ok: false, skipped: true, reason: "flag-off" },
		};
	}
	const uuidParsed = v.safeParse(UuidSchema, sessionUuid);
	if (!uuidParsed.success) {
		return badRequest(uuidParsed.issues, "path :sessionUuid");
	}
	const bodyParsed = v.safeParse(ChoiceBodySchema, body);
	if (!bodyParsed.success) {
		return badRequest(bodyParsed.issues, "body");
	}
	const choice: SessionAccountChoice = {
		sessionUuid: uuidParsed.output,
		accountUuid: bodyParsed.output.accountUuid as SessionAccountChoice["accountUuid"],
		chosenAt: new Date().toISOString(),
	};
	await deps.choiceStore.write(choice);
	// Fire-and-forget hot-swap signal to any live shim owning this session.
	// The signal outcome is logged but never surfaced on the wire: the choice
	// is persisted regardless of shim reachability (the shim reads it fresh
	// on next spawn if no live process picks up SIGHUP now).
	try {
		const outcome = await deps.signalSwap(uuidParsed.output);
		deps.logger.log(`bridge: hot-swap signal for ${uuidParsed.output} → ${outcome}`);
	} catch (error) {
		deps.logger.warn(
			`bridge: hot-swap signal for ${uuidParsed.output} threw: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { status: 200, body: { ok: true, choice } };
}

/**
 * Dispatch a request to the right handler. Returns 404 JSON for unknown
 * routes/methods. Path parameters are extracted here so handlers stay
 * signature-simple.
 *
 * @param {RouteRequest} req - The request snapshot.
 * @param {RouteDeps} deps - Injected ports.
 * @returns {Promise<RouteResult>} The materialized response.
 */
export async function dispatch(req: RouteRequest, deps: RouteDeps): Promise<RouteResult> {
	// Health is the only route with no auth/flag interaction, so it lives
	// at the top for cleanliness. server.ts also short-circuits health
	// before running validateAuth.
	if (req.method === "GET" && req.pathname === "/health") {
		return handleHealth(deps);
	}
	if (req.method === "GET" && req.pathname === "/accounts") {
		return await handleListAccounts(deps);
	}
	if (req.method === "GET" && req.pathname.startsWith("/usage/")) {
		const uuid = req.pathname.slice("/usage/".length);
		return await handleUsage(deps, uuid);
	}
	if (req.method === "POST" && req.pathname.startsWith("/choice/")) {
		const uuid = req.pathname.slice("/choice/".length);
		return await handleSetChoice(deps, uuid, req.body);
	}
	return {
		status: 404,
		body: { ok: false, reason: `no route: ${req.method} ${req.pathname}` },
	};
}

// Re-export so server.ts can compute `flagOn` from an env snapshot without
// pulling `../oauth/provisioning.ts` twice.
export { flagOnEnv };
