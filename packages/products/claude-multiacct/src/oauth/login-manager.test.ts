/* oxlint-disable vitest/expect-expect, typescript/explicit-function-return-type, unicorn/numeric-separators-style, vitest/no-conditional-in-test, vitest/no-conditional-expect, jsdoc/require-returns, unicorn/no-useless-undefined */
/**
 * Intent: the login manager owns the stateful half of the in-app OAuth flow —
 * the pending logins and the paste-back callback pipeline. The Claude account
 * client rejects loopback, so this is the MANUAL copy-the-code flow: no
 * 127.0.0.1 listener is bound. Load-bearing behaviours pinned here:
 *
 *   1. `start()` builds an authorize URL carrying the MANUAL redirect
 *      (`platform.claude.com/oauth/code/callback`) + a minted state, and returns
 *      a pollable loginId. Adversarial: bind a loopback redirect and the
 *      "manual redirect" assertion reddens.
 *   2. `complete()` splits the pasted `code#state` on the FIRST `#`, validates
 *      `state` BEFORE any exchange — a mismatch (or a paste with no `#`) is a hard
 *      reject with NO token exchange (CSRF).
 *   3. The happy path runs exchange → profile → register against the MANUAL
 *      redirect, flips status to `done` with the account.
 *   4. Each failure stage (exchange / profile / register) yields `error` and a
 *      distinct detail.
 *   5. Abandoned pending logins are swept (cancelled) once past the TTL.
 */

import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../discovery/identity.ts";
import type { Account, ClaudeAccountUuid } from "../domain/account.ts";
import { CLAUDE_MANUAL_REDIRECT_URL } from "./login.ts";
import { createLoginManager, type LoginManagerDeps } from "./login-manager.ts";

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

function happyDeps(over: Partial<LoginManagerDeps> = {}): LoginManagerDeps {
	return {
		exchangeCode: () => Promise.resolve({ ok: true, tokens: { accessToken: "tok", scopes: [] } }),
		fetchProfile: () => Promise.resolve({ ok: true, profile: profile() }),
		register: () => Promise.resolve({ ok: true, account: account(), updated: false }),
		genLoginId: () => UUID,
		...over,
	};
}

// The minted state for a started login, read off the authorize URL.
function stateOf(authorizeUrl: string): string {
	return new URL(authorizeUrl).searchParams.get("state") ?? "";
}

describe("createLoginManager — start()", () => {
	it("builds an authorize URL carrying the MANUAL redirect + a minted state", async () => {
		const mgr = createLoginManager(happyDeps());
		const { loginId, authorizeUrl } = await mgr.start();
		expect(loginId).toBe(UUID);
		const url = new URL(authorizeUrl);
		// The account client rejects loopback — the redirect is the manual callback.
		expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_MANUAL_REDIRECT_URL);
		expect(url.searchParams.get("redirect_uri")).not.toContain("127.0.0.1");
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

describe("createLoginManager — complete (paste code#state) happy path", () => {
	it("valid code#state → exchange→profile→register → done, account set", async () => {
		const mgr = createLoginManager(happyDeps());
		const { loginId, authorizeUrl } = await mgr.start();
		const state = stateOf(authorizeUrl);

		const view = await mgr.complete(loginId, `the-code#${state}`);
		expect(view).toMatchObject({ ok: true, status: "done", updated: false });
		if (view.ok) {
			expect(view.account?.uuid).toBe(UUID);
		}
		expect(mgr.getStatus(loginId)).toMatchObject({ ok: true, status: "done" });
	});

	it("forwards the exact code + verifier + state + MANUAL redirect to the exchange", async () => {
		let seen:
			| { code: string; codeVerifier: string; state: string; redirectUri: string }
			| undefined;
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: (args) => {
					seen = args;
					return Promise.resolve({ ok: true, tokens: { accessToken: "tok", scopes: [] } });
				},
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const state = stateOf(authorizeUrl);
		await mgr.complete(loginId, `xyz#${state}`);
		expect(seen?.code).toBe("xyz");
		expect(seen?.state).toBe(state);
		expect(seen?.redirectUri).toBe(CLAUDE_MANUAL_REDIRECT_URL);
		expect(seen?.codeVerifier).not.toBe("");
	});

	it("trims surrounding whitespace off the pasted code and state", async () => {
		let seen: { code: string; state: string } | undefined;
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: (args) => {
					seen = { code: args.code, state: args.state };
					return Promise.resolve({ ok: true, tokens: { accessToken: "tok", scopes: [] } });
				},
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const state = stateOf(authorizeUrl);
		const view = await mgr.complete(loginId, `  the-code  #  ${state}  `);
		expect(view).toMatchObject({ ok: true, status: "done" });
		expect(seen?.code).toBe("the-code");
	});

	it("reports updated:true when register updates an existing account", async () => {
		const mgr = createLoginManager(
			happyDeps({
				register: () => Promise.resolve({ ok: true, account: account(), updated: true }),
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const view = await mgr.complete(loginId, `c#${stateOf(authorizeUrl)}`);
		expect(view).toMatchObject({ ok: true, status: "done", updated: true });
	});
});

describe("createLoginManager — complete failure + CSRF", () => {
	it("rejects a mismatched state WITHOUT exchanging (CSRF)", async () => {
		let exchanged = false;
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: () => {
					exchanged = true;
					return Promise.resolve({ ok: true, tokens: { accessToken: "t", scopes: [] } });
				},
			}),
		);
		const { loginId } = await mgr.start();
		const view = await mgr.complete(loginId, "the-code#WRONG");
		expect(exchanged).toBe(false);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("state mismatch");
		}
	});

	it("a paste with no '#' (missing state) is rejected as CSRF, no exchange", async () => {
		let exchanged = false;
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: () => {
					exchanged = true;
					return Promise.resolve({ ok: true, tokens: { accessToken: "t", scopes: [] } });
				},
			}),
		);
		const { loginId } = await mgr.start();
		const view = await mgr.complete(loginId, "just-a-code-no-hash");
		expect(exchanged).toBe(false);
		expect(view).toMatchObject({ ok: true, status: "error" });
	});

	it("valid state but empty code → error, no exchange", async () => {
		let exchanged = false;
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: () => {
					exchanged = true;
					return Promise.resolve({ ok: true, tokens: { accessToken: "t", scopes: [] } });
				},
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const view = await mgr.complete(loginId, `#${stateOf(authorizeUrl)}`);
		expect(exchanged).toBe(false);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("no authorization code");
		}
	});

	it("complete on an unknown login → unknown_login", async () => {
		const mgr = createLoginManager(happyDeps());
		const view = await mgr.complete("no-such", "c#s");
		expect(view).toMatchObject({ ok: false, reason: "unknown_login" });
	});

	it("exchange failure → error with the classified detail", async () => {
		const mgr = createLoginManager(
			happyDeps({
				exchangeCode: () =>
					Promise.resolve({ ok: false, kind: "invalid_grant", detail: "expired" }),
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const view = await mgr.complete(loginId, `c#${stateOf(authorizeUrl)}`);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("invalid_grant");
		}
	});

	it("profile failure → error", async () => {
		const mgr = createLoginManager(
			happyDeps({
				fetchProfile: () => Promise.resolve({ ok: false, kind: "unauthorized", detail: "401" }),
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const view = await mgr.complete(loginId, `c#${stateOf(authorizeUrl)}`);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("profile fetch failed");
		}
	});

	it("register failure → error", async () => {
		const mgr = createLoginManager(
			happyDeps({
				register: () =>
					Promise.resolve({ ok: false, kind: "registry_write_failed", detail: "disk" }),
			}),
		);
		const { loginId, authorizeUrl } = await mgr.start();
		const view = await mgr.complete(loginId, `c#${stateOf(authorizeUrl)}`);
		expect(view).toMatchObject({ ok: true, status: "error" });
		if (view.ok) {
			expect(view.detail).toContain("register failed");
		}
	});
});

describe("createLoginManager — cancel + sweep", () => {
	it("cancel a pending login → cancelled", async () => {
		const mgr = createLoginManager(happyDeps());
		const { loginId } = await mgr.start();
		const view = await mgr.cancel(loginId);
		expect(view).toMatchObject({ ok: true, status: "cancelled" });
	});

	it("cancel an unknown login → unknown_login", async () => {
		const mgr = createLoginManager(happyDeps());
		expect(await mgr.cancel("nope")).toMatchObject({ ok: false, reason: "unknown_login" });
	});

	it("cancel a non-pending (done) login returns its view without changing status", async () => {
		const mgr = createLoginManager(happyDeps());
		const { loginId, authorizeUrl } = await mgr.start();
		await mgr.complete(loginId, `c#${stateOf(authorizeUrl)}`);
		const view = await mgr.cancel(loginId);
		expect(view).toMatchObject({ ok: true, status: "done" });
	});

	it("sweeps an abandoned pending login past the TTL (cancelled)", async () => {
		let clock = 1_000_000;
		const mgr = createLoginManager(happyDeps({ now: () => clock, ttlMs: 1000 }));
		const { loginId } = await mgr.start();
		clock += 5000; // past the TTL
		const view = mgr.getStatus(loginId);
		expect(view).toMatchObject({ ok: true, status: "cancelled" });
		if (view.ok) {
			expect(view.detail).toContain("timed out");
		}
	});
});
