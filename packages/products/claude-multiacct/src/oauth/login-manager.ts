/**
 * `@foundation/claude-multiacct` — in-app OAuth login orchestration.
 *
 * Drives the full "sign in to another Claude account from the app" flow and
 * holds the little bit of state the stateless HTTP bridge cannot: the pending
 * logins (their PKCE verifier + CSRF `state` + loopback listener) between the
 * moment the picker asks to start and the moment the browser redirect lands.
 *
 * # The flow
 *
 *   1. `start()` — mint PKCE + `state`, bind a loopback listener on
 *      `127.0.0.1:<ephemeral>/callback`, build the authorize URL, and hand
 *      `{loginId, authorizeUrl}` back. The picker opens that URL in the browser.
 *   2. The user signs in to the target account and consents. The auth server
 *      redirects the browser to the loopback `redirect_uri` with `?code&state`.
 *   3. The listener's handler runs: it validates `state` (CSRF — a mismatch is
 *      rejected BEFORE any exchange), exchanges the code for tokens, fetches the
 *      account's real identity from the profile API, and registers/updates the
 *      pool (dedup by `accountUuid`). It then shows the browser a done page and
 *      closes the listener.
 *   4. The picker polls `getStatus(loginId)` until it flips to `done`/`error`,
 *      then re-fetches `/accounts`.
 *
 * Every long-lived secret (`verifier`, tokens, code) stays inside the process;
 * only classified statuses cross the wire. Nothing here logs a token or a code.
 *
 * # State hygiene
 *
 * Abandoned logins (browser closed, user walked away) would otherwise leak a
 * bound listener. `start()` and `getStatus()` sweep sessions older than `ttlMs`
 * — closing their listeners and marking them `cancelled` — so a stale login
 * never holds a socket open. The sweep is driven by the injected `now`, not a
 * timer, so it is deterministic under test.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { Account } from "../domain/account.ts";
import type { AccountProfile, ProfileResult } from "../discovery/identity.ts";
import {
	buildAuthorizeUrl,
	createPkcePair,
	createState,
	type ExchangeResult,
	type RandomBytesFn,
} from "./login.ts";
import type { RegisterResult } from "./register-account.ts";

/** Terminal + in-flight statuses of a login session. */
export type LoginStatus = "pending" | "exchanging" | "done" | "error" | "cancelled";

/** What the browser is shown when it hits the loopback callback. */
export type CallbackPage = { status: number; html: string };

/** Parsed loopback callback query. */
export type CallbackQuery = {
	code?: string;
	state?: string;
	error?: string;
	errorDescription?: string;
};

/** A bound loopback listener. `close` is idempotent. */
export type CallbackServer = {
	/** The ephemeral port the listener bound. */
	port: number;
	/** The exact `redirect_uri` (`http://127.0.0.1:<port>/callback`). */
	redirectUri: string;
	/** Tear the listener down. Idempotent. */
	close: () => Promise<void>;
};

/**
 * Open a loopback listener that invokes `handler` when the browser hits
 * `/callback`. The handler resolves to the page the browser should see.
 */
export type OpenCallbackServer = (
	handler: (query: CallbackQuery) => Promise<CallbackPage>,
) => Promise<CallbackServer>;

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
}) => Promise<RegisterResult>;

/** Injected deps for {@link createLoginManager}. */
export type LoginManagerDeps = {
	exchangeCode: ExchangeCodeFn;
	fetchProfile: FetchProfileFn;
	register: RegisterFn;
	openCallbackServer: OpenCallbackServer;
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
	getStatus: (loginId: string) => LoginStatusView;
	cancel: (loginId: string) => Promise<LoginStatusView>;
};

type Session = {
	loginId: string;
	state: string;
	verifier: string;
	redirectUri: string;
	server: CallbackServer;
	status: LoginStatus;
	account?: Account;
	updated?: boolean;
	detail?: string;
	createdAt: number;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/**
 * Minimal, self-contained HTML page shown in the browser after the redirect.
 *
 * @param {string} title - Heading text.
 * @param {string} message - Body copy under the heading.
 * @returns {string} A complete HTML document.
 */
function page(title: string, message: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#262624;color:#f5f4ef;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:26rem;text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#a6a39a;line-height:1.5}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

const DONE_PAGE = page("Signed in", "You can close this tab and return to Claude.");

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
 * @returns {LoginManager} `{start, getStatus, cancel}`.
 */
export function createLoginManager(deps: LoginManagerDeps): LoginManager {
	const sessions = new Map<string, Session>();
	const now = deps.now ?? Date.now;
	const genLoginId = deps.genLoginId ?? randomUUID;
	const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
	const logger = deps.logger ?? SILENT_LOGGER;

	/**
	 * Close a session's listener, swallowing (and warning on) a double-close.
	 *
	 * @param {Session} session - The session whose listener to close.
	 * @returns {Promise<void>} Resolves once the close is attempted.
	 */
	async function closeServer(session: Session): Promise<void> {
		try {
			await session.server.close();
		} catch (error) {
			logger.warn(
				`login ${session.loginId}: listener close failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Expire any pending session older than the TTL. */
	function sweep(): void {
		const cutoff = now() - ttlMs;
		for (const session of sessions.values()) {
			if (session.status === "pending" && session.createdAt < cutoff) {
				session.status = "cancelled";
				session.detail = "login timed out";
				// eslint-disable-next-line typescript/no-floating-promises -- best-effort teardown of an abandoned listener
				closeServer(session);
			}
		}
	}

	/**
	 * Run the callback: validate state (CSRF), exchange, fetch identity, register.
	 * Returns the page the browser should see. Never logs the code or token.
	 *
	 * @param {Session} session - The pending session the callback belongs to.
	 * @param {CallbackQuery} query - The parsed loopback callback query.
	 * @returns {Promise<CallbackPage>} The page to render in the browser.
	 */
	async function handleCallback(session: Session, query: CallbackQuery): Promise<CallbackPage> {
		if (query.error !== undefined) {
			session.status = "error";
			session.detail = `authorization denied: ${query.error}${query.errorDescription === undefined ? "" : ` (${query.errorDescription})`}`;
			logger.log(`login ${session.loginId}: denied at authorize`);
			await closeServer(session);
			return {
				status: 400,
				html: page("Sign-in failed", "Authorization was denied. Return to Claude and try again."),
			};
		}
		// CSRF: a mismatched or missing state is rejected BEFORE any exchange.
		if (query.state === undefined || query.state !== session.state) {
			session.status = "error";
			session.detail = "state mismatch (possible CSRF); ignored";
			logger.warn(`login ${session.loginId}: state mismatch — rejected`);
			await closeServer(session);
			return {
				status: 400,
				html: page("Sign-in failed", "Security check failed. Return to Claude and try again."),
			};
		}
		if (query.code === undefined || query.code === "") {
			session.status = "error";
			session.detail = "callback missing authorization code";
			await closeServer(session);
			return {
				status: 400,
				html: page("Sign-in failed", "No authorization code. Return to Claude and try again."),
			};
		}

		session.status = "exchanging";
		const exchanged = await deps.exchangeCode({
			code: query.code,
			codeVerifier: session.verifier,
			state: session.state,
			redirectUri: session.redirectUri,
		});
		if (!exchanged.ok) {
			session.status = "error";
			session.detail = `token exchange failed: ${exchanged.kind}: ${exchanged.detail}`;
			logger.warn(`login ${session.loginId}: exchange failed (${exchanged.kind})`);
			await closeServer(session);
			return {
				status: 502,
				html: page(
					"Sign-in failed",
					"Could not complete the token exchange. Return to Claude and try again.",
				),
			};
		}

		const profile = await deps.fetchProfile(exchanged.tokens.accessToken);
		if (!profile.ok) {
			session.status = "error";
			session.detail = `profile fetch failed: ${profile.kind}: ${profile.detail}`;
			logger.warn(`login ${session.loginId}: profile failed (${profile.kind})`);
			await closeServer(session);
			return {
				status: 502,
				html: page(
					"Sign-in failed",
					"Could not read the account profile. Return to Claude and try again.",
				),
			};
		}

		const registered = await deps.register({
			profile: profile.profile,
			token: exchanged.tokens.accessToken,
		});
		if (!registered.ok) {
			session.status = "error";
			session.detail = `register failed: ${registered.kind}: ${registered.detail}`;
			logger.warn(`login ${session.loginId}: register failed (${registered.kind})`);
			await closeServer(session);
			return {
				status: 500,
				html: page(
					"Sign-in failed",
					"Could not register the account. Return to Claude and try again.",
				),
			};
		}

		session.status = "done";
		session.account = registered.account;
		session.updated = registered.updated;
		logger.log(
			`login ${session.loginId}: ${registered.updated ? "updated" : "added"} account ${registered.account.uuid}`,
		);
		await closeServer(session);
		return { status: 200, html: DONE_PAGE };
	}

	/**
	 * Start a login: mint PKCE + state, bind a listener, build the authorize URL.
	 *
	 * @returns {Promise<LoginStartResult>} The `loginId` to poll and the URL to open.
	 */
	async function start(): Promise<LoginStartResult> {
		sweep();
		const loginId = genLoginId();
		const state = createState(deps.randomBytes);
		const { verifier, challenge } = createPkcePair(deps.randomBytes);

		// The handler closes over `session`, which is assigned right after the
		// listener binds. A callback cannot arrive before the browser opens the
		// authorize URL we return below, so the reference is always populated.
		// eslint-disable-next-line prefer-const -- forward-declared: captured by the handler closure before assignment
		let session: Session;
		const server = await deps.openCallbackServer((query) => handleCallback(session, query));

		const authorizeUrl = buildAuthorizeUrl({
			...(deps.authorizeUrl === undefined ? {} : { authorizeUrl: deps.authorizeUrl }),
			...(deps.clientId === undefined ? {} : { clientId: deps.clientId }),
			...(deps.scopes === undefined ? {} : { scopes: deps.scopes }),
			redirectUri: server.redirectUri,
			state,
			codeChallenge: challenge,
		});

		session = {
			loginId,
			state,
			verifier,
			redirectUri: server.redirectUri,
			server,
			status: "pending",
			createdAt: now(),
		};
		sessions.set(loginId, session);
		logger.log(`login ${loginId}: listening on ${server.redirectUri}`);
		return { loginId, authorizeUrl };
	}

	function getStatus(loginId: string): LoginStatusView {
		sweep();
		const session = sessions.get(loginId);
		if (session === undefined) {
			return { ok: false, reason: "unknown_login", detail: `no login ${loginId}` };
		}
		return viewOf(session);
	}

	async function cancel(loginId: string): Promise<LoginStatusView> {
		const session = sessions.get(loginId);
		if (session === undefined) {
			return { ok: false, reason: "unknown_login", detail: `no login ${loginId}` };
		}
		if (session.status === "pending") {
			session.status = "cancelled";
			session.detail = "cancelled by user";
			await closeServer(session);
		}
		return viewOf(session);
	}

	return { start, getStatus, cancel };
}

/** Args for {@link nodeCallbackServer}. */
export type NodeCallbackServerDeps = {
	/** Bind host; defaults to `127.0.0.1`. Never anything but loopback. */
	host?: string;
	/** Callback path; defaults to `/callback`. */
	path?: string;
};

/**
 * Real loopback listener backed by `node:http`, bound to `127.0.0.1:0`. This is
 * the production {@link OpenCallbackServer}. Only `/callback` is served; any
 * other path 404s so a stray probe cannot drive the exchange.
 *
 * @param {NodeCallbackServerDeps} [cfg] - Host/path overrides.
 * @returns {OpenCallbackServer} An opener the login manager injects.
 */
export function nodeCallbackServer(cfg: NodeCallbackServerDeps = {}): OpenCallbackServer {
	const host = cfg.host ?? "127.0.0.1";
	const path = cfg.path ?? "/callback";
	return async (handler) => {
		const { createServer } = await import("node:http");
		const server = createServer((req, res) => {
			// eslint-disable-next-line typescript/no-floating-promises -- fire-and-forget request handler; all errors are caught inside
			(async (): Promise<void> => {
				try {
					const url = new URL(req.url ?? "/", `http://${host}`);
					if (url.pathname !== path) {
						res.writeHead(404, { "content-type": "text/plain" });
						res.end("not found");
						return;
					}
					const get = (k: string): Record<string, string> => {
						const val = url.searchParams.get(k);
						return val === null ? {} : { [k]: val };
					};
					const query: CallbackQuery = {
						...get("code"),
						...get("state"),
						...get("error"),
						...(url.searchParams.get("error_description") === null
							? {}
							: { errorDescription: url.searchParams.get("error_description") as string }),
					};
					const result = await handler(query);
					res.writeHead(result.status, { "content-type": "text/html; charset=utf-8" });
					res.end(result.html);
				} catch (error: unknown) {
					res.writeHead(500, { "content-type": "text/plain" });
					res.end(error instanceof Error ? error.message : String(error));
				}
			})();
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, host, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		const address = server.address();
		/* c8 ignore next 3 -- AddressInfo is always an object for a tcp listen. */
		if (address === null || typeof address === "string") {
			throw new Error("callback server: expected AddressInfo");
		}
		const { port } = address;
		return {
			port,
			redirectUri: `http://${host}:${String(port)}${path}`,
			// Stop accepting new connections and resolve immediately. We do NOT
			// await the drain callback: `close()` is invoked from inside the
			// callback handler itself (before its response has flushed), so
			// awaiting the drain would deadlock — the drain waits for the response,
			// the response waits for the handler, the handler waits for close.
			// Idle keep-alive sockets are dropped so the port frees promptly; the
			// in-flight callback response finishes on its own already-open socket.
			close: () =>
				new Promise<void>((resolve) => {
					server.close();
					server.closeIdleConnections();
					resolve();
				}),
		};
	};
}
