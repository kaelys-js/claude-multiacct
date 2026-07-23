/* oxlint-disable vitest/expect-expect, typescript/explicit-function-return-type, unicorn/numeric-separators-style, vitest/no-conditional-in-test, vitest/no-conditional-expect, jsdoc/require-returns, unicorn/no-useless-undefined */
/**
 * Intent: the login manager owns the stateful half of the in-app OAuth flow —
 * the pending logins, their loopback listeners, and the callback pipeline.
 * Load-bearing behaviours pinned here:
 *
 *   1. `start()` binds a listener, builds an authorize URL carrying the SAME
 *      redirect + state, and returns a pollable loginId.
 *   2. The callback validates `state` BEFORE any exchange — a mismatch is a
 *      hard reject with NO token exchange (CSRF). Adversarial: drop the state
 *      check and the "rejects mismatched state without exchanging" test reddens.
 *   3. The happy path runs exchange → profile → register, flips status to `done`
 *      with the account, and CLOSES the listener.
 *   4. Each failure stage (exchange / profile / register) yields `error` and a
 *      distinct browser status, and closes the listener.
 *   5. Abandoned pending logins are swept (closed + cancelled) once past the TTL.
 *   6. `nodeCallbackServer` really binds loopback and drives the handler.
 */

import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../discovery/identity.ts";
import type { Account, ClaudeAccountUuid } from "../domain/account.ts";
import {
	type CallbackPage,
	type CallbackQuery,
	createLoginManager,
	type LoginManagerDeps,
	nodeCallbackServer,
	type OpenCallbackServer,
} from "./login-manager.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

function account(): Account {
	return {
		uuid: UUID as Account["uuid"],
		label: "alice@example.com",
		subscriptionType: "claude_max",
		rateLimitTier: "unknown",
		encryptedTokenRef: UUID,
		accountUuid: UUID as ClaudeAccountUuid,
		source: "explicit",
	};
}

function profile(): AccountProfile {
	return {
		accountUuid: UUID as ClaudeAccountUuid,
		email: "alice@example.com",
		displayName: "Alice",
		subscriptionType: "claude_max",
		rateLimitTier: "unknown",
	};
}

/** A fake opener that captures the handler so a test can fire the callback. */
function fakeOpener(): {
	opener: OpenCallbackServer;
	fire: (q: CallbackQuery) => Promise<CallbackPage>;
	closedCount: () => number;
	closeThrows: () => void;
} {
	let handler: ((q: CallbackQuery) => Promise<CallbackPage>) | undefined;
	let closed = 0;
	let throwOnClose = false;
	const opener: OpenCallbackServer = (h) => {
		handler = h;
		return Promise.resolve({
			port: 5555,
			redirectUri: "http://127.0.0.1:5555/callback",
			close: () => {
				closed += 1;
				return throwOnClose ? Promise.reject(new Error("close boom")) : Promise.resolve();
			},
		});
	};
	return {
		opener,
		fire: (q) => {
			if (handler === undefined) {
				throw new Error("handler not registered");
			}
			return handler(q);
		},
		closedCount: () => closed,
		closeThrows: () => {
			throwOnClose = true;
		},
	};
}

function happyDeps(over: Partial<LoginManagerDeps> = {}): LoginManagerDeps {
	return {
		exchangeCode: () => Promise.resolve({ ok: true, tokens: { accessToken: "tok", scopes: [] } }),
		fetchProfile: () => Promise.resolve({ ok: true, profile: profile() }),
		register: () => Promise.resolve({ ok: true, account: account(), updated: false }),
		openCallbackServer: fakeOpener().opener,
		genLoginId: () => UUID,
		...over,
	};
}

describe("createLoginManager — start()", () => {
	it("binds a listener and returns an authorize URL carrying the redirect + state", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { loginId, authorizeUrl } = await mgr.start();
		expect(loginId).toBe(UUID);
		const url = new URL(authorizeUrl);
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5555/callback");
		expect(url.searchParams.get("state")).not.toBeNull();
		expect(mgr.getStatus(loginId)).toMatchObject({ ok: true, status: "pending" });
	});

	it("opens the authorize URL in the browser via the injected openUrl on start", async () => {
		const opened: string[] = [];
		const mgr = createLoginManager(happyDeps({ openUrl: (u) => opened.push(u) }));
		const { authorizeUrl } = await mgr.start();
		// The daemon (a Node process) opens the URL host-side — the renderer can't.
		expect(opened).toStrictEqual([authorizeUrl]);
	});

	it("a throwing openUrl is warned, not fatal to start()", async () => {
		const warnings: string[] = [];
		const mgr = createLoginManager(
			happyDeps({
				openUrl: () => {
					throw new Error("spawn boom");
				},
				logger: { log: () => undefined, warn: (m) => warnings.push(m) },
			}),
		);
		// start() still resolves with a usable loginId despite the opener throwing.
		const { loginId } = await mgr.start();
		expect(mgr.getStatus(loginId)).toMatchObject({ ok: true, status: "pending" });
		expect(warnings.some((w) => w.includes("open browser failed"))).toBe(true);
	});

	it("start() with no openUrl injected simply does not open (no throw)", async () => {
		const mgr = createLoginManager(happyDeps());
		const { authorizeUrl } = await mgr.start();
		expect(authorizeUrl).toContain("redirect_uri");
	});

	it("threads authorizeUrl/clientId/scope overrides into the URL", async () => {
		const mgr = createLoginManager(
			happyDeps({
				authorizeUrl: "https://example.test/authorize",
				clientId: "cid",
				scopes: ["a"],
			}),
		);
		const { authorizeUrl } = await mgr.start();
		const url = new URL(authorizeUrl);
		expect(url.origin + url.pathname).toBe("https://example.test/authorize");
		expect(url.searchParams.get("client_id")).toBe("cid");
		expect(url.searchParams.get("scope")).toBe("a");
	});
});

describe("createLoginManager — open (re-open the browser)", () => {
	it("re-opens a pending login's authorize URL and returns its view", async () => {
		const opened: string[] = [];
		const mgr = createLoginManager(happyDeps({ openUrl: (u) => opened.push(u) }));
		const { loginId, authorizeUrl } = await mgr.start();
		// One open from start; open() fires a second with the SAME url.
		const view = mgr.open(loginId);
		expect(view).toMatchObject({ ok: true, status: "pending" });
		expect(opened).toStrictEqual([authorizeUrl, authorizeUrl]);
	});

	it("open on an unknown login → unknown_login", () => {
		const mgr = createLoginManager(happyDeps({ openUrl: () => undefined }));
		expect(mgr.open("no-such")).toMatchObject({ ok: false, reason: "unknown_login" });
	});
});

describe("createLoginManager — getStatus", () => {
	it("unknown loginId → unknown_login", () => {
		const mgr = createLoginManager(happyDeps());
		const view = mgr.getStatus("no-such");
		expect(view).toStrictEqual({ ok: false, reason: "unknown_login", detail: "no login no-such" });
	});
});

describe("createLoginManager — callback happy path", () => {
	it("valid state + code → exchange→profile→register → done, account set, listener closed", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { loginId, authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";

		const page = await fake.fire({ code: "the-code", state });
		expect(page.status).toBe(200);
		expect(page.html).toContain("Signed in");

		const view = mgr.getStatus(loginId);
		expect(view).toMatchObject({ ok: true, status: "done", updated: false });
		if (view.ok) {
			expect(view.account?.uuid).toBe(UUID);
		}
		expect(fake.closedCount()).toBe(1);
	});

	it("forwards the exact code + verifier + state to the exchange", async () => {
		const fake = fakeOpener();
		let seen:
			| { code: string; codeVerifier: string; state: string; redirectUri: string }
			| undefined;
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				exchangeCode: (args) => {
					seen = args;
					return Promise.resolve({ ok: true, tokens: { accessToken: "tok", scopes: [] } });
				},
			}),
		);
		const { authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		await fake.fire({ code: "xyz", state });
		expect(seen?.code).toBe("xyz");
		expect(seen?.state).toBe(state);
		expect(seen?.redirectUri).toBe("http://127.0.0.1:5555/callback");
		expect(seen?.codeVerifier).not.toBe("");
	});
});

describe("createLoginManager — callback failure + CSRF", () => {
	it("rejects a mismatched state WITHOUT exchanging (CSRF)", async () => {
		const fake = fakeOpener();
		let exchanged = false;
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				exchangeCode: () => {
					exchanged = true;
					return Promise.resolve({ ok: true, tokens: { accessToken: "t", scopes: [] } });
				},
			}),
		);
		const { loginId } = await mgr.start();
		const page = await fake.fire({ code: "c", state: "WRONG" });
		expect(page.status).toBe(400);
		expect(exchanged).toBe(false);
		expect(mgr.getStatus(loginId)).toMatchObject({ ok: true, status: "error" });
	});

	it("missing state is also rejected as CSRF", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		await mgr.start();
		const page = await fake.fire({ code: "c" });
		expect(page.status).toBe(400);
	});

	it("authorize error param → error page, no exchange", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { loginId } = await mgr.start();
		const page = await fake.fire({ error: "access_denied", errorDescription: "user said no" });
		expect(page.status).toBe(400);
		const view = mgr.getStatus(loginId);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("access_denied");
		}
	});

	it("valid state but missing code → error", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const page = await fake.fire({ state });
		expect(page.status).toBe(400);
	});

	it("exchange failure → error, browser 502", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				exchangeCode: () =>
					Promise.resolve({ ok: false, kind: "invalid_grant", detail: "expired" }),
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const page = await fake.fire({ code: "c", state });
		expect(page.status).toBe(502);
		expect(mgr.getStatus(loginId)).toMatchObject({ ok: true, status: "error" });
	});

	it("profile failure → error, browser 502", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				fetchProfile: () => Promise.resolve({ ok: false, kind: "unauthorized", detail: "401" }),
			}),
		);
		const { authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const page = await fake.fire({ code: "c", state });
		expect(page.status).toBe(502);
	});

	it("register failure → error, browser 500", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				register: () =>
					Promise.resolve({ ok: false, kind: "registry_write_failed", detail: "disk" }),
			}),
		);
		const { authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const page = await fake.fire({ code: "c", state });
		expect(page.status).toBe(500);
	});

	it("a listener close that throws is warned, not fatal", async () => {
		const fake = fakeOpener();
		fake.closeThrows();
		const warnings: string[] = [];
		const mgr = createLoginManager(
			happyDeps({
				openCallbackServer: fake.opener,
				logger: { log: () => undefined, warn: (m) => warnings.push(m) },
			}),
		);
		const { authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		const page = await fake.fire({ code: "c", state });
		expect(page.status).toBe(200);
		expect(warnings.some((w) => w.includes("listener close failed"))).toBe(true);
	});
});

describe("createLoginManager — cancel + sweep", () => {
	it("cancel a pending login → cancelled + listener closed", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { loginId } = await mgr.start();
		const view = await mgr.cancel(loginId);
		expect(view).toMatchObject({ ok: true, status: "cancelled" });
		expect(fake.closedCount()).toBe(1);
	});

	it("cancel an unknown login → unknown_login", async () => {
		const mgr = createLoginManager(happyDeps());
		expect(await mgr.cancel("nope")).toMatchObject({ ok: false, reason: "unknown_login" });
	});

	it("cancel a non-pending (done) login returns its view without re-closing", async () => {
		const fake = fakeOpener();
		const mgr = createLoginManager(happyDeps({ openCallbackServer: fake.opener }));
		const { loginId, authorizeUrl } = await mgr.start();
		const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
		await fake.fire({ code: "c", state });
		const view = await mgr.cancel(loginId);
		expect(view).toMatchObject({ ok: true, status: "done" });
		// Only the completion close, not a second one from cancel.
		expect(fake.closedCount()).toBe(1);
	});

	it("sweeps an abandoned pending login past the TTL (closed + cancelled)", async () => {
		const fake = fakeOpener();
		let clock = 1_000_000;
		const mgr = createLoginManager(
			happyDeps({ openCallbackServer: fake.opener, now: () => clock, ttlMs: 1000 }),
		);
		const { loginId } = await mgr.start();
		clock += 5000; // past the TTL
		const view = mgr.getStatus(loginId);
		expect(view).toMatchObject({ ok: true, status: "cancelled" });
		expect(fake.closedCount()).toBe(1);
	});
});

describe("nodeCallbackServer — real loopback listener", () => {
	it("serves /callback by invoking the handler and 404s other paths", async () => {
		let seen: CallbackQuery | undefined;
		const server = await nodeCallbackServer()((query) => {
			seen = query;
			return Promise.resolve({ status: 200, html: "<b>ok</b>" });
		});
		try {
			const base = server.redirectUri.replace(/\/callback$/u, "");
			const good = await fetch(`${server.redirectUri}?code=abc&state=st&error_description=none`);
			expect(good.status).toBe(200);
			expect(await good.text()).toContain("ok");
			expect(seen).toStrictEqual({ code: "abc", state: "st", errorDescription: "none" });

			const bad = await fetch(`${base}/nope`);
			expect(bad.status).toBe(404);
		} finally {
			await server.close();
		}
	});

	it("a handler that throws yields a 500", async () => {
		const server = await nodeCallbackServer()(() => Promise.reject(new Error("handler boom")));
		try {
			const res = await fetch(`${server.redirectUri}?code=c`);
			expect(res.status).toBe(500);
			expect(await res.text()).toContain("handler boom");
		} finally {
			await server.close();
		}
	});

	it("honors a custom host/path", async () => {
		const server = await nodeCallbackServer({ path: "/cb" })(() =>
			Promise.resolve({ status: 200, html: "hi" }),
		);
		try {
			expect(server.redirectUri).toContain("/cb");
			const res = await fetch(server.redirectUri);
			expect(res.status).toBe(200);
		} finally {
			await server.close();
		}
	});
});

describe("createLoginManager over the REAL loopback listener (no deadlock)", () => {
	it("start() → browser hits the real loopback redirect → done, no hang", async () => {
		// Regression pin: the callback closes the listener from INSIDE its own
		// request handler. If close() awaited the connection drain, this hangs
		// (the drain waits for the response, the response waits for the handler,
		// the handler waits for close). The 10s test timeout would trip.
		const mgr = createLoginManager(happyDeps({ openCallbackServer: nodeCallbackServer() }));
		const { loginId, authorizeUrl } = await mgr.start();
		const url = new URL(authorizeUrl);
		const redirect = url.searchParams.get("redirect_uri") ?? "";
		const state = url.searchParams.get("state") ?? "";

		// The loopback listener is really up (404 on an unknown path).
		const base = redirect.replace(/\/callback$/u, "");
		const probe = await fetch(`${base}/nope`);
		expect(probe.status).toBe(404);

		// The browser redirect lands with the synthetic code + minted state.
		const page = await fetch(`${redirect}?code=SYNTH&state=${encodeURIComponent(state)}`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("Signed in");

		const view = mgr.getStatus(loginId);
		expect(view).toMatchObject({ ok: true, status: "done" });
	});
});
