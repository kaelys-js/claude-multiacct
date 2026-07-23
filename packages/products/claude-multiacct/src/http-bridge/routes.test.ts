/* oxlint-disable unicorn/consistent-function-scoping */
/**
 * Intent: pin the wire-contract shape of every endpoint AND the flag gate
 * on the one mutating route. Adversarial cases:
 *
 *  - Bypass the flag check in `handleSetChoice` → the "flag-off →
 *    skipped" test flips red. Landing this PR must not activate any
 *    behavior when the flag is off (Rule 12 gate).
 *  - Loosen the uuid validation → the "non-uuid path returns 400 with
 *    issue path" tests flip red for both session and account ids.
 *  - Drop the 404 default → the "unknown route" test flips red.
 *
 * Read-only routes (`/health`, `/accounts`, `/usage/:uuid`) fire with
 * mock deps; the shape assertions are strict (`toEqual`) so any silent
 * field addition trips these tests.
 */

import { describe, expect, it, vi } from "vitest";
import type { Account } from "../domain/account.ts";
import type { VerifyResult } from "../oauth/models.ts";
import {
	type AddAccountFn,
	dispatch,
	handleAddAccount,
	handleHealth,
	handleListAccounts,
	handleLoginCancel,
	handleLoginComplete,
	handleLoginOpen,
	handleLoginStart,
	handleLoginStatus,
	handleRemoveAccount,
	handleSetChoice,
	handleUsage,
	type LoginCancelFn,
	type LoginCompleteFn,
	type LoginOpenFn,
	type LoginStartFn,
	type LoginStatusFn,
	type RemoveAccountFn,
	type RouteDeps,
	type SignalSwapFn,
	type VerifyAccountFn,
} from "./routes.ts";

const acctUuid = "11111111-1111-4111-8111-111111111111";
const sessUuid = "22222222-2222-4222-8222-222222222222";

const sampleAccount: Account = {
	uuid: acctUuid as Account["uuid"],
	label: "test",
	encryptedTokenRef: "kc:ref",
	subscriptionType: "pro",
	rateLimitTier: "tier1",
};

const okVerify: VerifyResult = {
	ok: true,
	subscriptionType: "pro",
	rateLimitTier: "tier1",
	accountUuid: acctUuid,
};

function makeDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
	return {
		listAccounts: overrides.listAccounts ?? (() => Promise.resolve([sampleAccount])),
		activeAccountUuid: overrides.activeAccountUuid ?? (() => Promise.resolve(acctUuid)),
		addAccount:
			overrides.addAccount ??
			vi.fn<AddAccountFn>(() => Promise.resolve({ ok: true, account: sampleAccount })),
		removeAccount:
			overrides.removeAccount ??
			vi.fn<RemoveAccountFn>(() => Promise.resolve({ ok: true, removed: sampleAccount })),
		verifyAccount:
			overrides.verifyAccount ??
			vi.fn<VerifyAccountFn>(() =>
				Promise.resolve({
					ok: true,
					verify: okVerify,
					needsRefresh: false,
				}),
			),
		...(overrides.loginStart === undefined ? {} : { loginStart: overrides.loginStart }),
		...(overrides.loginStatus === undefined ? {} : { loginStatus: overrides.loginStatus }),
		...(overrides.loginComplete === undefined ? {} : { loginComplete: overrides.loginComplete }),
		...(overrides.loginCancel === undefined ? {} : { loginCancel: overrides.loginCancel }),
		...(overrides.loginOpen === undefined ? {} : { loginOpen: overrides.loginOpen }),
		choiceStore: overrides.choiceStore ?? {
			write: vi.fn<() => Promise<void>>(() => Promise.resolve()),
		},
		flagOn: overrides.flagOn ?? true,
		version: overrides.version ?? "0.0.0",
		port: overrides.port ?? 12_345,
		secretRotatedAt: overrides.secretRotatedAt ?? "2026-07-20T00:00:00.000Z",
		signalSwap: overrides.signalSwap ?? vi.fn<SignalSwapFn>(() => Promise.resolve("no-owner")),
		logger: overrides.logger ?? {
			log: vi.fn<(m: string) => void>(),
			warn: vi.fn<(m: string) => void>(),
		},
	};
}

describe("handleHealth", () => {
	it("returns 200 with version, port, secretRotatedAt (no auth)", () => {
		const r = handleHealth(makeDeps());
		expect(r).toEqual({
			status: 200,
			body: {
				ok: true,
				version: "0.0.0",
				port: 12_345,
				secretRotatedAt: "2026-07-20T00:00:00.000Z",
			},
		});
	});
});

describe("handleListAccounts", () => {
	it("returns the injected accounts list plus the runtime-active uuid", async () => {
		const r = await handleListAccounts(makeDeps());
		expect(r.status).toBe(200);
		// activeUuid is what the picker highlights — drop it from the handler and
		// the picker can no longer pre-select the account Claude.app is logged in as.
		expect(r.body).toEqual({ ok: true, accounts: [sampleAccount], activeUuid: acctUuid });
	});

	it("passes through activeUuid: undefined when the active account can't be resolved", async () => {
		// Fail-closed contract: an unreadable active token must surface as
		// undefined, not a guessed account. Hard-coding a uuid here would flip red.
		const r = await handleListAccounts(
			makeDeps({ activeAccountUuid: () => Promise.resolve(undefined) }),
		);
		expect(r.body).toEqual({ ok: true, accounts: [sampleAccount], activeUuid: undefined });
	});
});

describe("handleUsage", () => {
	it("returns 200 + verify on a valid uuid", async () => {
		const r = await handleUsage(makeDeps(), acctUuid);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, verify: okVerify, needsRefresh: false });
	});

	it("rejects a non-uuid with 400 and cites the path field (loosen uuid → RED)", async () => {
		const r = await handleUsage(makeDeps(), "not-a-uuid");
		expect(r.status).toBe(400);
		expect(String((r.body as { reason: string }).reason)).toMatch(/path :accountUuid/u);
	});

	it("propagates not_found from verifyAccount as 404", async () => {
		const deps = makeDeps({
			verifyAccount: vi.fn<VerifyAccountFn>(() =>
				Promise.resolve({
					ok: false,
					reason: "not_found",
					detail: "no account matches",
				}),
			),
		});
		const r = await handleUsage(deps, acctUuid);
		expect(r.status).toBe(404);
		expect((r.body as { reason: string }).reason).toBe("not_found");
	});

	it("a bare {ok:false} (no reason/detail) → 404 with the not_found/empty fallbacks", async () => {
		// verifyAccount may fail without populating reason/detail. The handler must
		// still yield a well-formed body rather than leaking `undefined` onto the
		// wire — so the `?? "not_found"` / `?? ""` fallbacks matter. Drop them and
		// the response body carries undefined fields, which the extension can't
		// render.
		const deps = makeDeps({
			verifyAccount: vi.fn<VerifyAccountFn>(() => Promise.resolve({ ok: false })),
		});
		const r = await handleUsage(deps, acctUuid);
		expect(r.status).toBe(404);
		expect(r.body).toEqual({ ok: false, reason: "not_found", detail: "" });
	});
});

describe("handleSetChoice (flag gate + validation)", () => {
	it("flag-off → 403 skipped:true, and the choice store is NOT called (bypass flag → adversarial RED)", async () => {
		const write = vi.fn<() => Promise<void>>(() => Promise.resolve());
		const deps = makeDeps({ flagOn: false, choiceStore: { write } });
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(403);
		expect(r.body).toEqual({ ok: false, skipped: true, reason: "flag-off" });
		expect(write).not.toHaveBeenCalled();
	});

	it("flag-on + valid → writes the choice and returns 200 with the stamped choice", async () => {
		const write = vi.fn<() => Promise<void>>(() => Promise.resolve());
		const deps = makeDeps({ choiceStore: { write } });
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(200);
		expect(write).toHaveBeenCalledTimes(1);
		const stamped = (
			r.body as { choice: { sessionUuid: string; accountUuid: string; chosenAt: string } }
		).choice;
		expect(stamped.sessionUuid).toBe(sessUuid);
		expect(stamped.accountUuid).toBe(acctUuid);
		expect(stamped.chosenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
	});

	it("fires signalSwap with the session uuid after persisting the choice (drop the signal → hot-swap regression RED)", async () => {
		const write = vi.fn<() => Promise<void>>(() => Promise.resolve());
		const signalSwap = vi.fn<SignalSwapFn>(() => Promise.resolve("signalled"));
		const deps = makeDeps({ choiceStore: { write }, signalSwap });
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(200);
		expect(write).toHaveBeenCalledTimes(1);
		expect(signalSwap).toHaveBeenCalledTimes(1);
		expect(signalSwap).toHaveBeenCalledWith(sessUuid);
	});

	it("response is unaffected by signalSwap outcome (no-owner is normal)", async () => {
		const signalSwap = vi.fn<SignalSwapFn>(() => Promise.resolve("no-owner"));
		const deps = makeDeps({ signalSwap });
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(200);
		expect((r.body as { ok: boolean }).ok).toBe(true);
		expect(signalSwap).toHaveBeenCalledOnce();
	});

	it("signalSwap that throws is swallowed and logged (choice still persists)", async () => {
		const write = vi.fn<() => Promise<void>>(() => Promise.resolve());
		const warn = vi.fn<(m: string) => void>();
		const signalSwap = vi.fn<SignalSwapFn>(() => Promise.reject(new Error("boom")));
		const deps = makeDeps({
			choiceStore: { write },
			signalSwap,
			logger: { log: vi.fn<(m: string) => void>(), warn },
		});
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(200);
		expect(write).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledOnce();
	});

	it("signalSwap rejecting a NON-Error value is still swallowed + stringified into the warn", async () => {
		// The catch stringifies non-Error throws via `String(error)`. A rejected
		// string (or anything not an Error) must not crash the request nor bypass
		// the warn — the choice still persists and returns 200.
		const warn = vi.fn<(m: string) => void>();
		// oxlint-disable-next-line prefer-promise-reject-errors -- exercising the non-Error branch of the catch
		const signalSwap = vi.fn<SignalSwapFn>(() => Promise.reject("ESRCH-string"));
		const deps = makeDeps({
			signalSwap,
			logger: { log: vi.fn<(m: string) => void>(), warn },
		});
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(200);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]![0]).toContain("ESRCH-string");
	});

	it("flag-off short-circuit does not fire signalSwap", async () => {
		const signalSwap = vi.fn<SignalSwapFn>(() => Promise.resolve("signalled"));
		const deps = makeDeps({ flagOn: false, signalSwap });
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: acctUuid });
		expect(r.status).toBe(403);
		expect(signalSwap).not.toHaveBeenCalled();
	});

	it("non-uuid sessionUuid → 400 with body path (loosen path validation → RED)", async () => {
		const deps = makeDeps();
		const r = await handleSetChoice(deps, "not-a-uuid", { accountUuid: acctUuid });
		expect(r.status).toBe(400);
		expect((r.body as { reason: string }).reason).toMatch(/path :sessionUuid/u);
	});

	it("body missing accountUuid → 400 with body issue path", async () => {
		const deps = makeDeps();
		const r = await handleSetChoice(deps, sessUuid, {});
		expect(r.status).toBe(400);
		expect((r.body as { reason: string }).reason).toMatch(/body/u);
	});

	it("body.accountUuid is not a uuid → 400", async () => {
		const deps = makeDeps();
		const r = await handleSetChoice(deps, sessUuid, { accountUuid: "not-a-uuid" });
		expect(r.status).toBe(400);
	});
});

describe("handleAddAccount (flag gate + validation + status mapping)", () => {
	it("flag-off → 403 skipped:true and addAccount is NOT called (bypass flag → RED)", async () => {
		const addAccount = vi.fn<AddAccountFn>(() =>
			Promise.resolve({ ok: true, account: sampleAccount }),
		);
		const r = await handleAddAccount(makeDeps({ flagOn: false, addAccount }), {
			label: "x",
			token: "t",
		});
		expect(r.status).toBe(403);
		expect(r.body).toEqual({ ok: false, skipped: true, reason: "flag-off" });
		expect(addAccount).not.toHaveBeenCalled();
	});

	it("flag-on + valid body → 201 with the provisioned account, addAccount gets label+token", async () => {
		const addAccount = vi.fn<AddAccountFn>(() =>
			Promise.resolve({ ok: true, account: sampleAccount }),
		);
		const r = await handleAddAccount(makeDeps({ addAccount }), { label: "work", token: "sk-tok" });
		expect(r.status).toBe(201);
		expect(r.body).toEqual({ ok: true, account: sampleAccount });
		expect(addAccount).toHaveBeenCalledWith({ label: "work", token: "sk-tok" });
	});

	it("missing token → 400 with the body issue path (loosen the schema → RED)", async () => {
		const r = await handleAddAccount(makeDeps(), { label: "work" });
		expect(r.status).toBe(400);
		expect((r.body as { reason: string }).reason).toMatch(/body/u);
	});

	it("empty label → 400 (non-empty label is required)", async () => {
		const r = await handleAddAccount(makeDeps(), { label: "", token: "t" });
		expect(r.status).toBe(400);
	});

	it("an extra body field → 400 (strictObject rejects the stray key)", async () => {
		const r = await handleAddAccount(makeDeps(), { label: "w", token: "t", uuid: "x" });
		expect(r.status).toBe(400);
	});

	it("propagates a classified addAccount failure with its status + reason/detail", async () => {
		// The route must surface whatever status the orchestration chose (409 for a
		// duplicate here) rather than flattening every failure to 500.
		const addAccount = vi.fn<AddAccountFn>(() =>
			Promise.resolve({
				ok: false,
				status: 409,
				reason: "duplicate_label",
				detail: 'label "work" is already registered',
			}),
		);
		const r = await handleAddAccount(makeDeps({ addAccount }), { label: "work", token: "t" });
		expect(r.status).toBe(409);
		expect(r.body).toEqual({
			ok: false,
			reason: "duplicate_label",
			detail: 'label "work" is already registered',
		});
	});
});

describe("handleRemoveAccount (flag gate + validation + status mapping)", () => {
	it("flag-off → 403 skipped:true and removeAccount is NOT called (bypass flag → RED)", async () => {
		const removeAccount = vi.fn<RemoveAccountFn>(() =>
			Promise.resolve({ ok: true, removed: sampleAccount }),
		);
		const r = await handleRemoveAccount(makeDeps({ flagOn: false, removeAccount }), acctUuid);
		expect(r.status).toBe(403);
		expect(r.body).toEqual({ ok: false, skipped: true, reason: "flag-off" });
		expect(removeAccount).not.toHaveBeenCalled();
	});

	it("flag-on + valid uuid → 200 with the removed account", async () => {
		const removeAccount = vi.fn<RemoveAccountFn>(() =>
			Promise.resolve({ ok: true, removed: sampleAccount }),
		);
		const r = await handleRemoveAccount(makeDeps({ removeAccount }), acctUuid);
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, removed: sampleAccount });
		expect(removeAccount).toHaveBeenCalledWith(acctUuid);
	});

	it("non-uuid path → 400 citing :accountUuid (loosen the uuid check → RED)", async () => {
		const r = await handleRemoveAccount(makeDeps(), "not-a-uuid");
		expect(r.status).toBe(400);
		expect((r.body as { reason: string }).reason).toMatch(/path :accountUuid/u);
	});

	it("propagates a classified removeAccount failure (404 not_found)", async () => {
		const removeAccount = vi.fn<RemoveAccountFn>(() =>
			Promise.resolve({ ok: false, status: 404, reason: "not_found", detail: "no such account" }),
		);
		const r = await handleRemoveAccount(makeDeps({ removeAccount }), acctUuid);
		expect(r.status).toBe(404);
		expect(r.body).toEqual({ ok: false, reason: "not_found", detail: "no such account" });
	});
});

describe("dispatch (routing table)", () => {
	it("routes GET /health", async () => {
		const r = await dispatch({ method: "GET", pathname: "/health" }, makeDeps());
		expect(r.status).toBe(200);
	});
	it("routes GET /accounts", async () => {
		const r = await dispatch({ method: "GET", pathname: "/accounts" }, makeDeps());
		expect(r.status).toBe(200);
	});
	it("routes GET /usage/:uuid", async () => {
		const r = await dispatch({ method: "GET", pathname: `/usage/${acctUuid}` }, makeDeps());
		expect(r.status).toBe(200);
	});
	it("routes POST /accounts to handleAddAccount (201)", async () => {
		const r = await dispatch(
			{ method: "POST", pathname: "/accounts", body: { label: "w", token: "t" } },
			makeDeps(),
		);
		expect(r.status).toBe(201);
	});
	it("routes DELETE /accounts/:uuid to handleRemoveAccount (200)", async () => {
		const r = await dispatch({ method: "DELETE", pathname: `/accounts/${acctUuid}` }, makeDeps());
		expect(r.status).toBe(200);
	});
	it("routes POST /choice/:uuid", async () => {
		const r = await dispatch(
			{ method: "POST", pathname: `/choice/${sessUuid}`, body: { accountUuid: acctUuid } },
			makeDeps(),
		);
		expect(r.status).toBe(200);
	});
	it("returns 404 JSON for unknown paths (drop the default → RED)", async () => {
		const r = await dispatch({ method: "GET", pathname: "/nope" }, makeDeps());
		expect(r.status).toBe(404);
		expect((r.body as { reason: string }).reason).toMatch(/no route/u);
	});
	it("returns 404 for wrong methods", async () => {
		const r = await dispatch({ method: "DELETE", pathname: "/accounts" }, makeDeps());
		expect(r.status).toBe(404);
	});
	it("routes POST /accounts/login/start", async () => {
		const loginStart: LoginStartFn = () =>
			Promise.resolve({ ok: true, loginId: acctUuid, authorizeUrl: "https://a/authorize" });
		const r = await dispatch(
			{ method: "POST", pathname: "/accounts/login/start" },
			makeDeps({ loginStart }),
		);
		expect(r.status).toBe(200);
	});
	it("routes POST /accounts/login/complete", async () => {
		const loginComplete: LoginCompleteFn = () => Promise.resolve({ ok: true, status: "done" });
		const r = await dispatch(
			{
				method: "POST",
				pathname: "/accounts/login/complete",
				body: { loginId: acctUuid, code: "abc#def" },
			},
			makeDeps({ loginComplete }),
		);
		expect(r.status).toBe(200);
	});
	it("routes GET /accounts/login/status/:loginId", async () => {
		const loginStatus: LoginStatusFn = () => ({ ok: true, status: "pending" });
		const r = await dispatch(
			{ method: "GET", pathname: `/accounts/login/status/${acctUuid}` },
			makeDeps({ loginStatus }),
		);
		expect(r.status).toBe(200);
	});
	it("routes POST /accounts/login/cancel/:loginId", async () => {
		const loginCancel: LoginCancelFn = () => Promise.resolve({ ok: true, status: "cancelled" });
		const r = await dispatch(
			{ method: "POST", pathname: `/accounts/login/cancel/${acctUuid}` },
			makeDeps({ loginCancel }),
		);
		expect(r.status).toBe(200);
	});
	it("routes POST /accounts/login/open/:loginId", async () => {
		const loginOpen: LoginOpenFn = () => ({ ok: true, status: "pending" });
		const r = await dispatch(
			{ method: "POST", pathname: `/accounts/login/open/${acctUuid}` },
			makeDeps({ loginOpen }),
		);
		expect(r.status).toBe(200);
	});
});

describe("in-app OAuth login routes", () => {
	it("start: flag off → 403 skipped, no manager call", async () => {
		const loginStart = vi.fn<LoginStartFn>(() =>
			Promise.resolve({ ok: true, loginId: acctUuid, authorizeUrl: "x" }),
		);
		const r = await handleLoginStart(makeDeps({ flagOn: false, loginStart }));
		expect(r.status).toBe(403);
		expect((r.body as { skipped: boolean }).skipped).toBe(true);
		expect(loginStart).not.toHaveBeenCalled();
	});

	it("start: manager not wired → 503 login_unavailable", async () => {
		const r = await handleLoginStart(makeDeps({ flagOn: true }));
		expect(r.status).toBe(503);
		expect((r.body as { reason: string }).reason).toBe("login_unavailable");
	});

	it("start: success → 200 with loginId + authorizeUrl", async () => {
		const loginStart: LoginStartFn = () =>
			Promise.resolve({ ok: true, loginId: acctUuid, authorizeUrl: "https://a/authorize?x=1" });
		const r = await handleLoginStart(makeDeps({ loginStart }));
		expect(r.status).toBe(200);
		expect(r.body).toStrictEqual({
			ok: true,
			loginId: acctUuid,
			authorizeUrl: "https://a/authorize?x=1",
		});
	});

	it("start: manager failure → mapped status + reason", async () => {
		const loginStart: LoginStartFn = () =>
			Promise.resolve({ ok: false, status: 500, reason: "login_start_failed", detail: "boom" });
		const r = await handleLoginStart(makeDeps({ loginStart }));
		expect(r.status).toBe(500);
		expect((r.body as { reason: string }).reason).toBe("login_start_failed");
	});

	it("status: not wired → 503", async () => {
		const r = await handleLoginStatus(makeDeps(), acctUuid);
		expect(r.status).toBe(503);
	});

	it("status: bad loginId → 400", async () => {
		const loginStatus: LoginStatusFn = () => ({ ok: true, status: "pending" });
		const r = await handleLoginStatus(makeDeps({ loginStatus }), "not-a-uuid");
		expect(r.status).toBe(400);
	});

	it("status: done → 200 with account + updated + detail passed through", async () => {
		const loginStatus: LoginStatusFn = () => ({
			ok: true,
			status: "done",
			account: sampleAccount,
			updated: true,
			detail: "added",
		});
		const r = await handleLoginStatus(makeDeps({ loginStatus }), acctUuid);
		expect(r.status).toBe(200);
		expect(r.body).toStrictEqual({
			ok: true,
			status: "done",
			account: sampleAccount,
			updated: true,
			detail: "added",
		});
	});

	it("status: unknown login → 404", async () => {
		const loginStatus: LoginStatusFn = () =>
			({ ok: false, reason: "unknown_login", detail: "no login" }) as ReturnType<LoginStatusFn>;
		const r = await handleLoginStatus(makeDeps({ loginStatus }), acctUuid);
		expect(r.status).toBe(404);
	});

	it("complete: flag off → 403 skipped, no manager call", async () => {
		const loginComplete = vi.fn<LoginCompleteFn>(() =>
			Promise.resolve({ ok: true, status: "done" }),
		);
		const r = await handleLoginComplete(makeDeps({ flagOn: false, loginComplete }), {
			loginId: acctUuid,
			code: "c#s",
		});
		expect(r.status).toBe(403);
		expect((r.body as { skipped: boolean }).skipped).toBe(true);
		expect(loginComplete).not.toHaveBeenCalled();
	});

	it("complete: not wired → 503 login_unavailable", async () => {
		const r = await handleLoginComplete(makeDeps({ flagOn: true }), {
			loginId: acctUuid,
			code: "c#s",
		});
		expect(r.status).toBe(503);
		expect((r.body as { reason: string }).reason).toBe("login_unavailable");
	});

	it("complete: bad body (missing code) → 400 with body issue path", async () => {
		const loginComplete: LoginCompleteFn = () => Promise.resolve({ ok: true, status: "done" });
		const r = await handleLoginComplete(makeDeps({ loginComplete }), { loginId: acctUuid });
		expect(r.status).toBe(400);
		expect((r.body as { reason: string }).reason).toMatch(/body/u);
	});

	it("complete: non-uuid loginId → 400", async () => {
		const loginComplete: LoginCompleteFn = () => Promise.resolve({ ok: true, status: "done" });
		const r = await handleLoginComplete(makeDeps({ loginComplete }), {
			loginId: "not-a-uuid",
			code: "c#s",
		});
		expect(r.status).toBe(400);
	});

	it("complete: success → 200 with status + account + updated passed through, forwards loginId + code", async () => {
		const loginComplete = vi.fn<LoginCompleteFn>(() =>
			Promise.resolve({ ok: true, status: "done", account: sampleAccount, updated: false }),
		);
		const r = await handleLoginComplete(makeDeps({ loginComplete }), {
			loginId: acctUuid,
			code: "the-code#the-state",
		});
		expect(r.status).toBe(200);
		expect(r.body).toStrictEqual({
			ok: true,
			status: "done",
			account: sampleAccount,
			updated: false,
		});
		expect(loginComplete).toHaveBeenCalledWith(acctUuid, "the-code#the-state");
	});

	it("complete: unknown login → 404", async () => {
		const loginComplete: LoginCompleteFn = () =>
			Promise.resolve({ ok: false, reason: "unknown_login", detail: "no login" });
		const r = await handleLoginComplete(makeDeps({ loginComplete }), {
			loginId: acctUuid,
			code: "c#s",
		});
		expect(r.status).toBe(404);
	});

	it("cancel: not wired → 503", async () => {
		const r = await handleLoginCancel(makeDeps(), acctUuid);
		expect(r.status).toBe(503);
	});

	it("cancel: bad loginId → 400", async () => {
		const loginCancel: LoginCancelFn = () => Promise.resolve({ ok: true, status: "cancelled" });
		const r = await handleLoginCancel(makeDeps({ loginCancel }), "bad");
		expect(r.status).toBe(400);
	});

	it("cancel: success → 200 status + detail", async () => {
		const loginCancel: LoginCancelFn = () =>
			Promise.resolve({ ok: true, status: "cancelled", detail: "cancelled by user" });
		const r = await handleLoginCancel(makeDeps({ loginCancel }), acctUuid);
		expect(r.status).toBe(200);
		expect(r.body).toStrictEqual({ ok: true, status: "cancelled", detail: "cancelled by user" });
	});

	it("cancel: unknown login → 404", async () => {
		const loginCancel: LoginCancelFn = () =>
			Promise.resolve({ ok: false, reason: "unknown_login", detail: "no login" });
		const r = await handleLoginCancel(makeDeps({ loginCancel }), acctUuid);
		expect(r.status).toBe(404);
	});

	it("open: not wired → 503", async () => {
		const r = await handleLoginOpen(makeDeps(), acctUuid);
		expect(r.status).toBe(503);
		expect((r.body as { reason: string }).reason).toBe("login_unavailable");
	});

	it("open: bad loginId → 400", async () => {
		const loginOpen: LoginOpenFn = () => ({ ok: true, status: "pending" });
		const r = await handleLoginOpen(makeDeps({ loginOpen }), "not-a-uuid");
		expect(r.status).toBe(400);
	});

	it("open: not flag-gated — opens even with the flag off (a login only exists post-start)", async () => {
		const loginOpen = vi.fn<LoginOpenFn>(() => ({ ok: true, status: "pending" }));
		const r = await handleLoginOpen(makeDeps({ flagOn: false, loginOpen }), acctUuid);
		expect(r.status).toBe(200);
		expect(loginOpen).toHaveBeenCalledWith(acctUuid);
	});

	it("open: success → 200 status + detail passed through", async () => {
		const loginOpen: LoginOpenFn = () =>
			Promise.resolve({ ok: true, status: "pending", detail: "reopened" });
		const r = await handleLoginOpen(makeDeps({ loginOpen }), acctUuid);
		expect(r.status).toBe(200);
		expect(r.body).toStrictEqual({ ok: true, status: "pending", detail: "reopened" });
	});

	it("open: unknown login → 404", async () => {
		const loginOpen: LoginOpenFn = () => ({
			ok: false,
			reason: "unknown_login",
			detail: "no login",
		});
		const r = await handleLoginOpen(makeDeps({ loginOpen }), acctUuid);
		expect(r.status).toBe(404);
	});
});
