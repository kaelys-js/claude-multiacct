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
	dispatch,
	handleHealth,
	handleListAccounts,
	handleSetChoice,
	handleUsage,
	type RouteDeps,
	type SignalSwapFn,
	type VerifyAccountFn,
} from "./routes.ts";

const acctUuid = "11111111-1111-4111-8111-111111111111";
const sessUuid = "22222222-2222-4222-8222-222222222222";

const sampleAccount: Account = {
	uuid: acctUuid as Account["uuid"],
	label: "test",
	isPrimary: true,
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
		verifyAccount:
			overrides.verifyAccount ??
			vi.fn<VerifyAccountFn>(() =>
				Promise.resolve({
					ok: true,
					verify: okVerify,
					needsRefresh: false,
				}),
			),
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
	it("returns the injected accounts list", async () => {
		const r = await handleListAccounts(makeDeps());
		expect(r.status).toBe(200);
		expect(r.body).toEqual({ ok: true, accounts: [sampleAccount] });
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
});
