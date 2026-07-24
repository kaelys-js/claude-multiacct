/**
 * `@foundation/claude-multiacct` — pure route handlers for the loopback
 * HTTP bridge.
 *
 * The extension talks to the daemon via these endpoints:
 *
 *   - `GET /health` — liveness + version, no auth. Used by launchd + the
 *     extension's readiness probe.
 *   - `GET /accounts` — the current pool plus the runtime-derived active
 *     account uuid (read-only, always allowed).
 *   - `POST /accounts` — provision a new pooled account from a `{label,
 *     token}` body (the token is one the user obtained by signing in to
 *     Claude). **Requires the feature flag on.**
 *   - `DELETE /accounts/:accountUuid` — deregister an account: drop its
 *     keychain token AND its registry entry, target-only + fail-closed.
 *     **Requires the feature flag on.**
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
 * Outcome of an add-account orchestration. Success carries the freshly
 * provisioned account; failure carries the HTTP status the handler should
 * emit plus a classified `reason`/`detail` (Rule 12). Injected so the route
 * stays pure — the real orchestration (verify the token, write the keychain
 * and registry) lives in `account-admin.ts` and is mocked in route tests.
 */
export type AddAccountOutcome =
	| { ok: true; account: Account }
	| { ok: false; status: number; reason: string; detail: string };

/**
 * Provision a new pooled account from a label and an OAuth `token` the caller
 * obtained by signing in to Claude. The live sign-in that produces the token
 * is the one step performed outside the daemon; everything downstream (verify,
 * keychain, registry) runs through injected ports so tests never sign in.
 */
export type AddAccountFn = (input: { label: string; token: string }) => Promise<AddAccountOutcome>;

/** Outcome of a remove-account orchestration. Mirror of {@link AddAccountOutcome}. */
export type RemoveAccountOutcome =
	| { ok: true; removed: Account }
	| { ok: false; status: number; reason: string; detail: string };

/**
 * Deregister a pooled account by uuid — drop its keychain token AND its
 * registry entry. Injected so tests drive the real teardown against in-memory
 * stores. The impl (see `account-admin.ts` → `cli/commands.ts::removeAccount`)
 * is fail-closed (a locked/failing keychain aborts before the registry is
 * touched) and target-only (never removes more than the addressed uuid).
 */
export type RemoveAccountFn = (uuid: string) => Promise<RemoveAccountOutcome>;

/**
 * Resolve the runtime-active account uuid — the account Claude.app is currently
 * authenticated as, derived by matching its OAuth token sha against each
 * account's (`discovery/active-token.ts` + `domain/registry.ts::getPrimary`).
 * Returns `undefined` when the pool is empty or the active token can't be read
 * (fail closed; the picker then hints the first account rather than mis-marking
 * one). Injected so tests never touch the keychain or config.json.
 */
export type ActiveAccountUuidFn = () => Promise<string | undefined>;

/**
 * Signal the running shim for `sessionUuid` that its account choice changed
 * so it hot-swaps the child claude with a fresh OAuth token. Returns the
 * outcome of the signal attempt — the daemon logs it but never surfaces it
 * to the HTTP caller (mid-session swap is fire-and-forget from the extension's
 * point of view: the choice is persisted regardless of shim reachability).
 */
export type SignalSwapFn = (sessionUuid: string) => Promise<"signalled" | "no-owner" | "stale">;

/**
 * Start an in-app OAuth login: bind a loopback listener + build the authorize
 * URL the picker opens in the browser. Injected so the route stays pure — the
 * real orchestration (PKCE, listener, code→token→profile→register) lives in
 * `oauth/login-manager.ts`. Success carries the `loginId` the picker polls and
 * the `authorizeUrl` it opens; failure carries an HTTP status.
 */
export type LoginStartFn = () => Promise<
	| { ok: true; loginId: string; authorizeUrl: string }
	| { ok: false; status: number; reason: string; detail: string }
>;

/** A login's progress as seen by the picker (no secrets). */
export type LoginStatusResult =
	| { ok: true; status: string; account?: Account; updated?: boolean; detail?: string }
	| { ok: false; reason: string; detail: string };

/** Poll the progress of an in-app login by its `loginId`. */
export type LoginStatusFn = (loginId: string) => LoginStatusResult | Promise<LoginStatusResult>;

/**
 * Complete an in-app login from the `code#state` string the user pasted back
 * from the manual redirect. Runs exchange → profile → register and returns the
 * login's final status. Injected so the route stays pure.
 */
export type LoginCompleteFn = (loginId: string, code: string) => Promise<LoginStatusResult>;

/** Cancel a pending in-app login by its `loginId`. */
export type LoginCancelFn = (loginId: string) => Promise<LoginStatusResult>;

/**
 * Re-open a pending login's authorize URL in the user's browser. The daemon
 * already opens it once when the login starts; this backs the picker's "Open
 * the sign-in page" link, which the renderer cannot honor itself (an external
 * `window.open` is a no-op inside Claude's Electron content script). Read-only
 * from the pool's point of view (it spawns a browser, mutates nothing), so it
 * is not flag-gated — a login only exists after the flag-gated `start`.
 */
export type LoginOpenFn = (loginId: string) => LoginStatusResult | Promise<LoginStatusResult>;

/** Injected port bundle every handler takes. */
export type RouteDeps = {
	listAccounts: ListAccountsFn;
	/** Resolve the runtime-active account uuid for `/accounts` (see the type). */
	activeAccountUuid: ActiveAccountUuidFn;
	/** Provision a new account from a `{label, token}` body. Flag-gated. */
	addAccount: AddAccountFn;
	/** Deregister an account by uuid. Flag-gated, fail-closed, target-only. */
	removeAccount: RemoveAccountFn;
	/**
	 * Start an in-app OAuth login. Flag-gated (it mutates the pool on
	 * completion). Optional so a daemon that has not wired the login manager
	 * simply reports the feature as unavailable (503) rather than crashing.
	 */
	loginStart?: LoginStartFn;
	/** Poll a login's status. Optional (see `loginStart`); read-only. */
	loginStatus?: LoginStatusFn;
	/**
	 * Complete a login from the pasted `code#state`. Flag-gated (it mutates the
	 * pool). Optional so a daemon that has not wired the login manager reports the
	 * feature as unavailable (503) rather than crashing.
	 */
	loginComplete?: LoginCompleteFn;
	/** Cancel a pending login. Optional (see `loginStart`). */
	loginCancel?: LoginCancelFn;
	/** Re-open a pending login's authorize URL. Optional (see `loginStart`). */
	loginOpen?: LoginOpenFn;
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
	/**
	 * Resolve the uuid of the live CLI session the shim is actually reading its
	 * choice under (the newest registered session whose pid is alive). Backs
	 * `POST /choice` — the picker can't supply that uuid because the tab uuid it
	 * scrapes is a different namespace. Wired to
	 * `cli-shim/session-pid.ts::resolveActiveSessionUuid`; tests inject a spy.
	 */
	resolveActiveSession: () => Promise<string | undefined>;
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

const NonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * `POST /accounts` body — the human label plus the OAuth token acquired by
 * signing in to Claude. `strictObject` so an unexpected extra field (e.g. a
 * stray `uuid`) is a 400, not silently accepted.
 */
const AddAccountBodySchema = v.strictObject({
	label: NonEmptyString,
	token: NonEmptyString,
});

/**
 * `POST /accounts/login/complete` body — the login id to complete plus the
 * `code#state` string the user pasted from the manual redirect. `strictObject`
 * so a stray field is a 400, not silently accepted.
 */
const LoginCompleteBodySchema = v.strictObject({
	loginId: UuidSchema,
	code: NonEmptyString,
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
 * List accounts — always allowed, read-only. Includes `activeUuid`, the
 * runtime-derived active account, so the picker highlights the account
 * Claude.app is currently authenticated as without a stored primary flag.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @returns {Promise<RouteResult>} 200 with the pool and the active account uuid.
 */
export async function handleListAccounts(deps: RouteDeps): Promise<RouteResult> {
	const accounts = await deps.listAccounts();
	const activeUuid = await deps.activeAccountUuid();
	return { status: 200, body: { ok: true, accounts, activeUuid } };
}

/**
 * Provision a new account. **Requires the feature flag on** — flag-off returns
 * 403 `{ok:false, skipped:true, reason:"flag-off"}` so the endpoint stays inert
 * (and touches nothing) with the flag off, mirroring `handleSetChoice`. On
 * success returns 201 with the provisioned account; the injected `addAccount`
 * classifies every failure into an HTTP status (400 bad token, 409 duplicate,
 * 500 store/registry).
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {unknown} body - Parsed request body (`{label, token}`).
 * @returns {Promise<RouteResult>} 201 with the account, or 400/403/409/500.
 */
export async function handleAddAccount(deps: RouteDeps, body: unknown): Promise<RouteResult> {
	if (!deps.flagOn) {
		return { status: 403, body: { ok: false, skipped: true, reason: "flag-off" } };
	}
	const parsed = v.safeParse(AddAccountBodySchema, body);
	if (!parsed.success) {
		return badRequest(parsed.issues, "body");
	}
	const outcome = await deps.addAccount({ label: parsed.output.label, token: parsed.output.token });
	if (!outcome.ok) {
		return {
			status: outcome.status,
			body: { ok: false, reason: outcome.reason, detail: outcome.detail },
		};
	}
	return { status: 201, body: { ok: true, account: outcome.account } };
}

/**
 * Deregister an account by uuid. **Requires the feature flag on** (403 flag-off
 * before any store touch). The injected `removeAccount` is fail-closed and
 * target-only; the handler maps its classified failure to an HTTP status (404
 * unknown account, 500 keychain/registry failure).
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} uuid - Account uuid from the path.
 * @returns {Promise<RouteResult>} 200 with the removed account, or 400/403/404/500.
 */
export async function handleRemoveAccount(deps: RouteDeps, uuid: string): Promise<RouteResult> {
	if (!deps.flagOn) {
		return { status: 403, body: { ok: false, skipped: true, reason: "flag-off" } };
	}
	const parsed = v.safeParse(UuidSchema, uuid);
	if (!parsed.success) {
		return badRequest(parsed.issues, "path :accountUuid");
	}
	const outcome = await deps.removeAccount(parsed.output);
	if (!outcome.ok) {
		return {
			status: outcome.status,
			body: { ok: false, reason: outcome.reason, detail: outcome.detail },
		};
	}
	return { status: 200, body: { ok: true, removed: outcome.removed } };
}

/**
 * Start an in-app OAuth login. **Requires the feature flag on** — flag-off
 * returns 403 `{ok:false, skipped:true, reason:"flag-off"}` so the endpoint
 * stays inert (binds no listener) with the flag off, mirroring `handleAddAccount`.
 * If the daemon has not wired the login manager, returns 503 `login_unavailable`.
 * On success returns 200 `{ok, loginId, authorizeUrl}`; the picker opens the URL
 * and polls `GET /accounts/login/status/:loginId`.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @returns {Promise<RouteResult>} 200 with the authorize URL, or 403/500/503.
 */
export async function handleLoginStart(deps: RouteDeps): Promise<RouteResult> {
	if (!deps.flagOn) {
		return { status: 403, body: { ok: false, skipped: true, reason: "flag-off" } };
	}
	if (deps.loginStart === undefined) {
		return {
			status: 503,
			body: { ok: false, reason: "login_unavailable", detail: "login manager not wired" },
		};
	}
	const outcome = await deps.loginStart();
	if (!outcome.ok) {
		return {
			status: outcome.status,
			body: { ok: false, reason: outcome.reason, detail: outcome.detail },
		};
	}
	return {
		status: 200,
		body: { ok: true, loginId: outcome.loginId, authorizeUrl: outcome.authorizeUrl },
	};
}

/**
 * Poll an in-app login's status — read-only, always allowed. 404s an unknown
 * `loginId`; 503s when the login manager is not wired.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} loginId - Login id from the path.
 * @returns {Promise<RouteResult>} 200 with the status, or 400/404/503.
 */
export async function handleLoginStatus(deps: RouteDeps, loginId: string): Promise<RouteResult> {
	if (deps.loginStatus === undefined) {
		return {
			status: 503,
			body: { ok: false, reason: "login_unavailable", detail: "login manager not wired" },
		};
	}
	const parsed = v.safeParse(UuidSchema, loginId);
	if (!parsed.success) {
		return badRequest(parsed.issues, "path :loginId");
	}
	const result = await deps.loginStatus(parsed.output);
	if (!result.ok) {
		return { status: 404, body: { ok: false, reason: result.reason, detail: result.detail } };
	}
	return {
		status: 200,
		body: {
			ok: true,
			status: result.status,
			...(result.account === undefined ? {} : { account: result.account }),
			...(result.updated === undefined ? {} : { updated: result.updated }),
			...(result.detail === undefined ? {} : { detail: result.detail }),
		},
	};
}

/**
 * Complete an in-app login from the pasted `code#state`. **Requires the feature
 * flag on** — it mutates the pool (registers the account), mirroring
 * `handleLoginStart`. Flag-off returns 403; an unwired manager returns 503; a
 * malformed body returns 400; an unknown `loginId` returns 404. On success
 * returns 200 with the login's final status (and the created account on `done`).
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {unknown} body - Parsed request body (`{loginId, code}`).
 * @returns {Promise<RouteResult>} 200 with the status, or 400/403/404/503.
 */
export async function handleLoginComplete(deps: RouteDeps, body: unknown): Promise<RouteResult> {
	if (!deps.flagOn) {
		return { status: 403, body: { ok: false, skipped: true, reason: "flag-off" } };
	}
	if (deps.loginComplete === undefined) {
		return {
			status: 503,
			body: { ok: false, reason: "login_unavailable", detail: "login manager not wired" },
		};
	}
	const parsed = v.safeParse(LoginCompleteBodySchema, body);
	if (!parsed.success) {
		return badRequest(parsed.issues, "body");
	}
	const result = await deps.loginComplete(parsed.output.loginId, parsed.output.code);
	if (!result.ok) {
		return { status: 404, body: { ok: false, reason: result.reason, detail: result.detail } };
	}
	return {
		status: 200,
		body: {
			ok: true,
			status: result.status,
			...(result.account === undefined ? {} : { account: result.account }),
			...(result.updated === undefined ? {} : { updated: result.updated }),
			...(result.detail === undefined ? {} : { detail: result.detail }),
		},
	};
}

/**
 * Cancel a pending in-app login. Read/teardown only (does not mutate the pool),
 * so it is not flag-gated. 404s an unknown `loginId`; 503s when the login
 * manager is not wired.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} loginId - Login id from the path.
 * @returns {Promise<RouteResult>} 200 with the final status, or 400/404/503.
 */
export async function handleLoginCancel(deps: RouteDeps, loginId: string): Promise<RouteResult> {
	if (deps.loginCancel === undefined) {
		return {
			status: 503,
			body: { ok: false, reason: "login_unavailable", detail: "login manager not wired" },
		};
	}
	const parsed = v.safeParse(UuidSchema, loginId);
	if (!parsed.success) {
		return badRequest(parsed.issues, "path :loginId");
	}
	const result = await deps.loginCancel(parsed.output);
	if (!result.ok) {
		return { status: 404, body: { ok: false, reason: result.reason, detail: result.detail } };
	}
	return {
		status: 200,
		body: {
			ok: true,
			status: result.status,
			...(result.detail === undefined ? {} : { detail: result.detail }),
		},
	};
}

/**
 * Re-open a pending login's authorize URL in the browser — backs the picker's
 * "Open the sign-in page" link. Not flag-gated (a login only exists after the
 * flag-gated `start`, and this mutates nothing). 404s an unknown `loginId`;
 * 503s when the login manager is not wired.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {string} loginId - Login id from the path.
 * @returns {Promise<RouteResult>} 200 with the status, or 400/404/503.
 */
export async function handleLoginOpen(deps: RouteDeps, loginId: string): Promise<RouteResult> {
	if (deps.loginOpen === undefined) {
		return {
			status: 503,
			body: { ok: false, reason: "login_unavailable", detail: "login manager not wired" },
		};
	}
	const parsed = v.safeParse(UuidSchema, loginId);
	if (!parsed.success) {
		return badRequest(parsed.issues, "path :loginId");
	}
	const result = await deps.loginOpen(parsed.output);
	if (!result.ok) {
		return { status: 404, body: { ok: false, reason: result.reason, detail: result.detail } };
	}
	return {
		status: 200,
		body: {
			ok: true,
			status: result.status,
			...(result.detail === undefined ? {} : { detail: result.detail }),
		},
	};
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
 * Set an account choice for the ACTIVE CLI session — the one the shim is
 * reading under, resolved by the daemon rather than named in the path. The
 * picker POSTs here because the session uuid it scrapes from the Code tab is a
 * different namespace than the shim's key, so it cannot address the session
 * directly; the daemon binds the choice to the newest live registered session
 * instead (`resolveActiveSession`). **Requires the feature flag on** — flag-off
 * returns 403 `{ok:false, skipped:true, reason:"flag-off"}`, mirroring
 * `handleSetChoice`.
 *
 * When no live CLI session resolves, returns 200 `{ok:true, resolved:"none"}` —
 * not an error: there is simply nothing to bind (the user's visual pick stands).
 * When one resolves, it writes the choice under THAT uuid, fires the same
 * fire-and-forget hot-swap signal, and returns the resolved uuid + choice.
 *
 * @param {RouteDeps} deps - Injected ports.
 * @param {unknown} body - Parsed request body (`{accountUuid}`).
 * @returns {Promise<RouteResult>} 200 with the choice or `resolved:"none"`, 400/403 otherwise.
 */
export async function handleSetActiveChoice(deps: RouteDeps, body: unknown): Promise<RouteResult> {
	if (!deps.flagOn) {
		return {
			status: 403,
			body: { ok: false, skipped: true, reason: "flag-off" },
		};
	}
	const bodyParsed = v.safeParse(ChoiceBodySchema, body);
	if (!bodyParsed.success) {
		return badRequest(bodyParsed.issues, "body");
	}
	const resolved = await deps.resolveActiveSession();
	if (resolved === undefined) {
		return { status: 200, body: { ok: true, resolved: "none" } };
	}
	const choice: SessionAccountChoice = {
		sessionUuid: resolved as SessionAccountChoice["sessionUuid"],
		accountUuid: bodyParsed.output.accountUuid as SessionAccountChoice["accountUuid"],
		chosenAt: new Date().toISOString(),
	};
	await deps.choiceStore.write(choice);
	// Fire-and-forget hot-swap signal — same contract as handleSetChoice: the
	// outcome is logged, never surfaced on the wire, since the choice is
	// persisted regardless of whether a live shim picks up SIGHUP now.
	try {
		const outcome = await deps.signalSwap(resolved);
		deps.logger.log(`bridge: hot-swap signal for ${resolved} → ${outcome}`);
	} catch (error) {
		deps.logger.warn(
			`bridge: hot-swap signal for ${resolved} threw: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { status: 200, body: { ok: true, sessionUuid: resolved, choice } };
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
	if (req.method === "POST" && req.pathname === "/accounts") {
		return await handleAddAccount(deps, req.body);
	}
	if (req.method === "POST" && req.pathname === "/accounts/login/start") {
		return await handleLoginStart(deps);
	}
	if (req.method === "POST" && req.pathname === "/accounts/login/complete") {
		return await handleLoginComplete(deps, req.body);
	}
	if (req.method === "GET" && req.pathname.startsWith("/accounts/login/status/")) {
		const loginId = req.pathname.slice("/accounts/login/status/".length);
		return await handleLoginStatus(deps, loginId);
	}
	if (req.method === "POST" && req.pathname.startsWith("/accounts/login/cancel/")) {
		const loginId = req.pathname.slice("/accounts/login/cancel/".length);
		return await handleLoginCancel(deps, loginId);
	}
	if (req.method === "POST" && req.pathname.startsWith("/accounts/login/open/")) {
		const loginId = req.pathname.slice("/accounts/login/open/".length);
		return await handleLoginOpen(deps, loginId);
	}
	if (req.method === "DELETE" && req.pathname.startsWith("/accounts/")) {
		const uuid = req.pathname.slice("/accounts/".length);
		return await handleRemoveAccount(deps, uuid);
	}
	if (req.method === "GET" && req.pathname.startsWith("/usage/")) {
		const uuid = req.pathname.slice("/usage/".length);
		return await handleUsage(deps, uuid);
	}
	// Exact `/choice` (no path uuid) → the daemon resolves the active session.
	// Must precede the `/choice/` prefix branch so the exact match wins.
	if (req.method === "POST" && req.pathname === "/choice") {
		return await handleSetActiveChoice(deps, req.body);
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
