/**
 * `@foundation/claude-multiacct` — in-app OAuth login orchestration.
 *
 * Drives the full "sign in to another Claude account from the app" flow and
 * holds the little bit of state the stateless HTTP bridge cannot: the pending
 * logins (their PKCE verifier + CSRF `state`) between the moment the picker
 * asks to start and the moment the user pastes the code back.
 *
 * # The flow (manual copy-the-code redirect)
 *
 * The Claude account OAuth client rejects loopback redirects, so this is NOT a
 * listener-on-127.0.0.1 flow. It uses the shipping desktop app's manual
 * redirect (`platform.claude.com/oauth/code/callback`):
 *
 *   1. `start()` — mint PKCE + `state`, build the authorize URL with the manual
 *      `redirect_uri`, and hand `{loginId, authorizeUrl}` back. The daemon opens
 *      that URL in the system browser (the renderer cannot).
 *   2. The user signs in to the target account and consents. The auth server
 *      redirects the browser to the manual callback, which renders a `code#state`
 *      string for the user to copy.
 *   3. The user pastes that string into the picker; the picker POSTs it to
 *      `complete(loginId, pasted)`. That splits `code#state` on the FIRST `#`,
 *      validates `state` (CSRF — a mismatch is rejected BEFORE any exchange),
 *      exchanges the code for tokens against the SAME manual `redirect_uri`,
 *      fetches the account's identity from the profile API, and registers/updates
 *      the pool (dedup by `accountUuid`).
 *
 * Every long-lived secret (`verifier`, tokens, code) stays inside the process;
 * only classified statuses cross the wire. Nothing here logs a token or a code.
 *
 * # State hygiene
 *
 * Abandoned logins (browser closed, user walked away) leave only a small session
 * record — no socket. `start()`, `getStatus()`, and `complete()` sweep sessions
 * older than `ttlMs`, marking them `cancelled`, so a stale login does not linger
 * as `pending`. The sweep is driven by the injected `now`, not a timer, so it is
 * deterministic under test.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Account } from "../domain/account.ts";
import type { AccountProfile, ProfileResult } from "../discovery/identity.ts";
import {
	buildAuthorizeUrl,
	CLAUDE_MANUAL_REDIRECT_URL,
	createPkcePair,
	createState,
	type ExchangeResult,
	type RandomBytesFn,
} from "./login.ts";
import type { RegisterResult } from "./register-account.ts";

/** Terminal + in-flight statuses of a login session. */
export type LoginStatus = "pending" | "exchanging" | "done" | "error" | "cancelled";

/** The exchange port — code → tokens (see `./login.ts`). */
export type ExchangeCodeFn = (args: {
	code: string;
	codeVerifier: string;
	state: string;
	redirectUri: string;
}) => Promise<ExchangeResult>;

/** The profile port — token → identity (see `discovery/identity.ts`). */
export type FetchProfileFn = (token: string) => Promise<ProfileResult>;

/** The register port — profile + token → pooled account (see `./register-account.ts`). */
export type RegisterFn = (args: {
	profile: AccountProfile;
	token: string;
	refreshToken?: string;
	expiresAt?: string;
}) => Promise<RegisterResult>;

/** Injected deps for {@link createLoginManager}. */
export type LoginManagerDeps = {
	exchangeCode: ExchangeCodeFn;
	fetchProfile: FetchProfileFn;
	register: RegisterFn;
	/**
	 * Open the authorize URL in the user's real browser. The picker runs inside
	 * Claude's Electron renderer, where `window.open` to an external origin is a
	 * no-op — only a main-process/Node opener reaches the system browser. The
	 * daemon is that Node process, so it opens the URL here: automatically the
	 * moment `start()` builds the URL, and again on demand via `open()`. Injected
	 * so tests never spawn a real browser; omitted, the manager simply does not
	 * open (the picker's "Open the sign-in page" link still calls `open()`, which
	 * no-ops without this port).
	 */
	openUrl?: (url: string) => void;
	/** Injected entropy; defaults to node crypto. */
	randomBytes?: RandomBytesFn;
	/** Injected clock; defaults to `Date.now`. */
	now?: () => number;
	/** Injected id source; defaults to `randomUUID`. */
	genLoginId?: () => string;
	/** Authorize URL override (tests / staging). */
	authorizeUrl?: string;
	/** Client id override. */
	clientId?: string;
	/** Scope override. */
	scopes?: readonly string[];
	/** Abandoned-login TTL in ms; defaults to 10 minutes. */
	ttlMs?: number;
	/** Log sink — statuses only, never secrets. Defaults to a no-op. */
	logger?: { log: (m: string) => void; warn: (m: string) => void };
};

/** Public view of a login's progress (no secrets). */
export type LoginStatusView =
	| { ok: true; status: LoginStatus; account?: Account; updated?: boolean; detail?: string }
	| { ok: false; reason: "unknown_login"; detail: string };

/** Result of `start()`. */
export type LoginStartResult = { loginId: string; authorizeUrl: string };

/** The manager surface the daemon binds. */
export type LoginManager = {
	start: () => Promise<LoginStartResult>;
	/**
	 * Complete a login from the `code#state` the user pasted back from the manual
	 * redirect. Validates `state`, exchanges the code, fetches the profile, and
	 * registers the account. Returns the login's final view.
	 */
	complete: (loginId: string, pasted: string) => Promise<LoginStatusView>;
	getStatus: (loginId: string) => LoginStatusView;
	cancel: (loginId: string) => Promise<LoginStatusView>;
	/** Re-open a pending login's authorize URL in the browser (see `openUrl`). */
	open: (loginId: string) => LoginStatusView;
};

type Session = {
	loginId: string;
	state: string;
	verifier: string;
	redirectUri: string;
	authorizeUrl: string;
	status: LoginStatus;
	account?: Account;
	updated?: boolean;
	detail?: string;
	createdAt: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Drop-everything logger — the default when a caller injects none. */
const SILENT_LOGGER: NonNullable<LoginManagerDeps["logger"]> = {
	log() {
		/* intentionally silent */
	},
	warn() {
		/* intentionally silent */
	},
};

/**
 * Project a session to its public, secret-free status view.
 *
 * @param {Session} session - The session to project.
 * @returns {LoginStatusView} A view with no verifier / token / code.
 */
function viewOf(session: Session): LoginStatusView {
	return {
		ok: true,
		status: session.status,
		...(session.account === undefined ? {} : { account: session.account }),
		...(session.updated === undefined ? {} : { updated: session.updated }),
		...(session.detail === undefined ? {} : { detail: session.detail }),
	};
}

/**
 * Build a login manager. See the module docstring for the flow + state hygiene.
 *
 * @param {LoginManagerDeps} deps - Injected ports + overrides.
 * @returns {LoginManager} `{start, complete, getStatus, cancel, open}`.
 */
export function createLoginManager(deps: LoginManagerDeps): LoginManager {
	const sessions = new Map<string, Session>();
	const now = deps.now ?? Date.now;
	const genLoginId = deps.genLoginId ?? randomUUID;
	const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
	const logger = deps.logger ?? SILENT_LOGGER;

	/** Expire any pending session older than the TTL. */
	function sweep(): void {
		const cutoff = now() - ttlMs;
		for (const session of sessions.values()) {
			if (session.status === "pending" && session.createdAt < cutoff) {
				session.status = "cancelled";
				session.detail = "login timed out";
			}
		}
	}

	/**
	 * Run exchange → profile → register for a validated code. Mutates the session
	 * status/account/detail and returns its view. Never logs the code or token.
	 *
	 * @param {Session} session - The pending session the code belongs to.
	 * @param {string} code - The authorization code (already split from state).
	 * @returns {Promise<LoginStatusView>} The session's view after the pipeline.
	 */
	async function runExchange(session: Session, code: string): Promise<LoginStatusView> {
		session.status = "exchanging";
		const exchanged = await deps.exchangeCode({
			code,
			codeVerifier: session.verifier,
			state: session.state,
			redirectUri: session.redirectUri,
		});
		if (!exchanged.ok) {
			session.status = "error";
			session.detail = `token exchange failed: ${exchanged.kind}: ${exchanged.detail}`;
			logger.warn(`login ${session.loginId}: exchange failed (${exchanged.kind})`);
			return viewOf(session);
		}

		const profile = await deps.fetchProfile(exchanged.tokens.accessToken);
		if (!profile.ok) {
			session.status = "error";
			session.detail = `profile fetch failed: ${profile.kind}: ${profile.detail}`;
			logger.warn(`login ${session.loginId}: profile failed (${profile.kind})`);
			return viewOf(session);
		}

		const registered = await deps.register({
			profile: profile.profile,
			token: exchanged.tokens.accessToken,
			refreshToken: exchanged.tokens.refreshToken,
			expiresAt: exchanged.tokens.expiresAt,
		});
		if (!registered.ok) {
			session.status = "error";
			session.detail = `register failed: ${registered.kind}: ${registered.detail}`;
			logger.warn(`login ${session.loginId}: register failed (${registered.kind})`);
			return viewOf(session);
		}

		session.status = "done";
		session.account = registered.account;
		session.updated = registered.updated;
		logger.log(
			`login ${session.loginId}: ${registered.updated ? "updated" : "added"} account ${registered.account.uuid}`,
		);
		return viewOf(session);
	}

	/**
	 * Complete a login from the pasted `code#state`. Splits on the FIRST `#`
	 * (`code` = left, `state` = right), validates `state` against the minted one
	 * BEFORE any exchange (CSRF), then runs the exchange pipeline.
	 *
	 * @param {string} loginId - The login to complete.
	 * @param {string} pasted - The `code#state` the user copied from the browser.
	 * @returns {Promise<LoginStatusView>} The login's final view, or `unknown_login`.
	 */
	async function complete(loginId: string, pasted: string): Promise<LoginStatusView> {
		sweep();
		const session = sessions.get(loginId);
		if (session === undefined) {
			return { ok: false, reason: "unknown_login", detail: `no login ${loginId}` };
		}
		// Split on the FIRST '#': code = left, state = right. A paste with no '#'
		// yields an empty state, which fails the CSRF check below (as it should —
		// the manual redirect always returns `code#state`).
		const hashIndex = pasted.indexOf("#");
		const code = (hashIndex === -1 ? pasted : pasted.slice(0, hashIndex)).trim();
		const pastedState = hashIndex === -1 ? "" : pasted.slice(hashIndex + 1).trim();

		// CSRF: a mismatched or missing state is rejected BEFORE any exchange.
		if (pastedState !== session.state) {
			session.status = "error";
			session.detail = "state mismatch (possible CSRF); ignored";
			logger.warn(`login ${session.loginId}: state mismatch — rejected`);
			return viewOf(session);
		}
		if (code === "") {
			session.status = "error";
			session.detail = "pasted value had no authorization code";
			return viewOf(session);
		}
		return await runExchange(session, code);
	}

	/**
	 * Start a login: mint PKCE + state, build the manual-redirect authorize URL.
	 * No network or listener bind, so it is synchronous under a Promise-returning
	 * signature (the daemon awaits it uniformly with the other login ports).
	 *
	 * @returns {Promise<LoginStartResult>} The `loginId` to complete and the URL to open.
	 */
	function start(): Promise<LoginStartResult> {
		sweep();
		const loginId = genLoginId();
		const state = createState(deps.randomBytes);
		const { verifier, challenge } = createPkcePair(deps.randomBytes);
		const redirectUri = CLAUDE_MANUAL_REDIRECT_URL;

		const authorizeUrl = buildAuthorizeUrl({
			...(deps.authorizeUrl === undefined ? {} : { authorizeUrl: deps.authorizeUrl }),
			...(deps.clientId === undefined ? {} : { clientId: deps.clientId }),
			...(deps.scopes === undefined ? {} : { scopes: deps.scopes }),
			redirectUri,
			state,
			codeChallenge: challenge,
		});

		const session: Session = {
			loginId,
			state,
			verifier,
			redirectUri,
			authorizeUrl,
			status: "pending",
			createdAt: now(),
		};
		sessions.set(loginId, session);
		logger.log(`login ${loginId}: authorize URL built (manual redirect)`);
		// Open the browser from here (a Node process) — the renderer cannot reach
		// the system browser. Best-effort: a spawn failure must not fail start(),
		// the picker still shows an "Open the sign-in page" link that retries.
		openInBrowser(session);
		return Promise.resolve({ loginId, authorizeUrl });
	}

	/**
	 * Fire the injected opener for a session's authorize URL, swallowing (and
	 * warning on) any failure so a spawn error never breaks the caller.
	 *
	 * @param {Session} session - The session whose authorize URL to open.
	 * @returns {void}
	 */
	function openInBrowser(session: Session): void {
		if (deps.openUrl === undefined) {
			return;
		}
		try {
			deps.openUrl(session.authorizeUrl);
			logger.log(`login ${session.loginId}: opening sign-in page in browser`);
		} catch (error) {
			logger.warn(
				`login ${session.loginId}: open browser failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Re-open a pending login's authorize URL. Backs `POST /accounts/login/open`.
	 *
	 * @param {string} loginId - The login to re-open.
	 * @returns {LoginStatusView} The login's current view, or `unknown_login`.
	 */
	function open(loginId: string): LoginStatusView {
		const session = sessions.get(loginId);
		if (session === undefined) {
			return { ok: false, reason: "unknown_login", detail: `no login ${loginId}` };
		}
		openInBrowser(session);
		return viewOf(session);
	}

	function getStatus(loginId: string): LoginStatusView {
		sweep();
		const session = sessions.get(loginId);
		if (session === undefined) {
			return { ok: false, reason: "unknown_login", detail: `no login ${loginId}` };
		}
		return viewOf(session);
	}

	function cancel(loginId: string): Promise<LoginStatusView> {
		const session = sessions.get(loginId);
		if (session === undefined) {
			return Promise.resolve({
				ok: false,
				reason: "unknown_login",
				detail: `no login ${loginId}`,
			});
		}
		if (session.status === "pending") {
			session.status = "cancelled";
			session.detail = "cancelled by user";
		}
		return Promise.resolve(viewOf(session));
	}

	return { start, complete, getStatus, cancel, open };
}
