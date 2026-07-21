/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, eslint/prefer-promise-reject-errors, unicorn/numeric-separators-style, typescript/explicit-function-return-type */
/**
 * Intent: library-callable commands. Load-bearing:
 *
 *   - Flag-off tests are the GATED-PR proof: `addAccount`,
 *     `removeAccount`, `refreshAccount`, `setPrimary` return `{skipped:
 *     true}` and mutate NOTHING. Adversarial: bypass the flag on any of
 *     them and its flag-off test goes red.
 *   - `listAccounts` + `verifyAccount` are ALWAYS allowed (read-only).
 *   - `setPrimary` maintains PR1's exactly-one-primary invariant across the
 *     flip — the newly written registry has exactly one primary. Loosening
 *     the impl to allow zero primaries makes the invariant-check test red.
 *   - `removeAccount` is atomic-rollback: on registry write fail, the
 *     token store is restored to its pre-delete state.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../domain/registry.ts";
import type { OAuthTokens, VerifyResult } from "../oauth/models.ts";
import type { VerifyFn } from "../oauth/provisioning.ts";
import { assertNotOk, assertOk } from "../oauth/test-utils.ts";
import { InMemoryMutableTokenStore } from "../oauth/token-store-mut.ts";
import type { AtomicRegistryWriter } from "../registry/registry-writer.ts";
import {
	addAccount,
	type CliPorts,
	coerceUuid,
	listAccounts,
	refreshAccount,
	removeAccount,
	setPrimary,
	verifyAccount,
} from "./commands.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

function okVerify(uuid: string): VerifyResult {
	return { ok: true, subscriptionType: "Pro", rateLimitTier: "tier-2", accountUuid: uuid };
}

function baseRegistry(): AccountRegistry {
	return {
		accounts: [
			{
				uuid: coerceUuid(UUID_A),
				label: "Personal",
				isPrimary: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:a",
			},
			{
				uuid: coerceUuid(UUID_B),
				label: "Work",
				isPrimary: false,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:b",
			},
		],
	};
}

type MakePortsCtx = CliPorts & {
	writes: AccountRegistry[];
	tokenStore: InMemoryMutableTokenStore;
};

function makePorts(
	overrides: Partial<CliPorts> & {
		registry?: AccountRegistry;
		verify?: VerifyFn;
	} = {},
): MakePortsCtx {
	const tokenStore =
		(overrides.tokenStore as InMemoryMutableTokenStore | undefined) ??
		new InMemoryMutableTokenStore();
	const writes: AccountRegistry[] = [];
	const registryWriter: Pick<AtomicRegistryWriter, "write"> = overrides.registryWriter ?? {
		write: (r: AccountRegistry): Promise<{ backup: string | undefined }> => {
			writes.push(r);
			return Promise.resolve({ backup: undefined });
		},
	};
	const readRegistry =
		overrides.readRegistry ??
		((): Promise<AccountRegistry | undefined> => Promise.resolve(overrides.registry));
	const verify =
		overrides.verify ?? ((): Promise<VerifyResult> => Promise.resolve(okVerify(UUID_C)));
	return { tokenStore, registryWriter, readRegistry, verify, refresh: overrides.refresh, writes };
}

describe("addAccount — flag gate (GATED-PR)", () => {
	it("flag off → {skipped:true}, no writes to any port", async () => {
		const ports = makePorts();
		const result = await addAccount({
			label: "New",
			token: "t",
			ports,
			env: {},
		});
		expect(result).toEqual({
			ok: false,
			skipped: true,
			reason: expect.stringContaining("addAccount"),
		});
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});
	it("overrideFlag=true bypasses gate", async () => {
		const ports = makePorts();
		const result = await addAccount({ label: "New", token: "t", ports, overrideFlag: true });
		assertOk(result);
	});
	it("flag on via env → runs (pins the flagOn branch)", async () => {
		const ports = makePorts();
		const result = await addAccount({
			label: "New",
			token: "t",
			ports,
			env: { CLAUDE_MULTIACCT_ENABLE_SHIM: "1" },
		});
		assertOk(result);
	});
});

describe("listAccounts — always allowed", () => {
	it("returns [] when no registry exists", async () => {
		const ports = makePorts();
		const accounts = await listAccounts({ ports });
		expect(accounts).toEqual([]);
	});
	it("returns the accounts array (no flag gate)", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const accounts = await listAccounts({ ports });
		expect(accounts.map((a) => a.label)).toEqual(["Personal", "Work"]);
	});
});

describe("verifyAccount — always allowed", () => {
	it("returns not_found when no registry", async () => {
		const ports = makePorts();
		const r = await verifyAccount({ selector: { label: "x" }, ports });
		assertNotOk(r);
		expect(r.reason).toBe("not_found");
	});
	it("returns not_found when the selector matches nothing", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await verifyAccount({ selector: { label: "Nope" }, ports });
		assertNotOk(r);
	});
	it("returns not_found when neither uuid nor label is passed", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await verifyAccount({ selector: {}, ports });
		assertNotOk(r);
	});
	it("marks needsRefresh when the stored token is missing", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		// No token stored — soft-miss.
		const r = await verifyAccount({ selector: { label: "Personal" }, ports });
		assertOk(r);
		expect(r.needsRefresh).toBe(true);
	});
	it("marks needsRefresh when re-verify returns unauthorized", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			verify: () => Promise.resolve({ ok: false, kind: "unauthorized", detail: "dead" }),
		});
		await ports.tokenStore.put(coerceUuid(UUID_A), "t");
		const r = await verifyAccount({ selector: { uuid: UUID_A }, ports });
		assertOk(r);
		expect(r.needsRefresh).toBe(true);
	});
	it("does NOT mutate the registry (doesn't auto-flag)", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			verify: () => Promise.resolve({ ok: false, kind: "unauthorized", detail: "dead" }),
		});
		await ports.tokenStore.put(coerceUuid(UUID_A), "t");
		await verifyAccount({ selector: { uuid: UUID_A }, ports });
		expect(ports.writes).toEqual([]);
	});
	it("ok when verify succeeds; needsRefresh=false", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			verify: () => Promise.resolve(okVerify(UUID_A)),
		});
		await ports.tokenStore.put(coerceUuid(UUID_A), "t");
		const r = await verifyAccount({ selector: { uuid: UUID_A }, ports });
		assertOk(r);
		expect(r.needsRefresh).toBe(false);
	});
});

describe("removeAccount — flag gate + atomicity", () => {
	it("flag off → {skipped:true}, no writes", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		await ports.tokenStore.put(coerceUuid(UUID_B), "keychain:b");
		const r = await removeAccount({ selector: { label: "Work" }, ports, env: {} });
		expect(r).toEqual({
			ok: false,
			skipped: true,
			reason: expect.stringContaining("removeAccount"),
		});
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({ [UUID_B]: "keychain:b" });
	});

	it("removes a non-primary account happy path", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		await ports.tokenStore.put(coerceUuid(UUID_B), "keychain:b");
		const r = await removeAccount({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertOk(r);
		expect(ports.writes).toHaveLength(1);
		const [first] = ports.writes;
		expect(first?.accounts.map((a) => a.label)).toEqual(["Personal"]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});

	it("refuses to remove the primary when other accounts exist (PR1 invariant guard)", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await removeAccount({
			selector: { label: "Personal" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		expect(ports.writes).toEqual([]);
	});

	it("removes the last account (empty pool — no write, token deleted)", async () => {
		const [first0] = baseRegistry().accounts;
		if (first0 === undefined) {
			throw new Error("test setup");
		}
		const solo: AccountRegistry = { accounts: [first0] };
		const ports = makePorts({ registry: solo });
		await ports.tokenStore.put(coerceUuid(UUID_A), "keychain:a");
		const r = await removeAccount({
			selector: { uuid: UUID_A },
			ports,
			overrideFlag: true,
		});
		assertOk(r);
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});

	it("returns not_found when no registry", async () => {
		const ports = makePorts();
		const r = await removeAccount({ selector: { uuid: UUID_A }, ports, overrideFlag: true });
		assertNotOk(r);
	});

	it("returns not_found when the selector matches nothing", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await removeAccount({
			selector: { label: "Nope" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
	});

	it("ATOMIC rollback: writer throws AFTER token delete → token is RESTORED", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(coerceUuid(UUID_B), "keychain:b");
		const ports = makePorts({
			registry: baseRegistry(),
			tokenStore: store,
			registryWriter: { write: () => Promise.reject(new Error("simulated fail")) },
		});
		const r = await removeAccount({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		// Restored — pre-delete state preserved.
		expect(store.snapshot()).toEqual({ [UUID_B]: "keychain:b" });
	});

	it("token-store delete fails → {reason:'token_store_failed'}, no writer call", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(coerceUuid(UUID_B), "keychain:b");
		vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("kc fail"));
		const ports = makePorts({
			registry: baseRegistry(),
			tokenStore: store,
		});
		const r = await removeAccount({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		expect(ports.writes).toEqual([]);
	});

	it("token-store delete fails on empty-pool removal → token_store_failed", async () => {
		const [first0] = baseRegistry().accounts;
		if (first0 === undefined) {
			throw new Error("test setup");
		}
		const solo: AccountRegistry = { accounts: [first0] };
		const store = new InMemoryMutableTokenStore();
		vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("kc fail"));
		const ports = makePorts({ registry: solo, tokenStore: store });
		const r = await removeAccount({
			selector: { uuid: UUID_A },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
	});

	it("rollback restore ALSO fails → detail carries both messages", async () => {
		const store = new InMemoryMutableTokenStore();
		await store.put(coerceUuid(UUID_B), "keychain:b");
		vi.spyOn(store, "put").mockRejectedValueOnce(new Error("restore boom"));
		const ports = makePorts({
			registry: baseRegistry(),
			tokenStore: store,
			registryWriter: { write: () => Promise.reject(new Error("primary boom")) },
		});
		const r = await removeAccount({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const detail = "detail" in r ? r.detail : "";
		expect(detail).toContain("primary boom");
		expect(detail).toContain("token restore ALSO failed");
	});
});

describe("refreshAccount — flag gate + refresh flow", () => {
	const tokens: OAuthTokens = { accessToken: "a", refreshToken: "r", scopes: [] };
	it("flag off → {skipped:true}, no writes", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await refreshAccount({
			selector: { label: "Personal" },
			currentTokens: tokens,
			ports,
			env: {},
		});
		expect(r).toEqual({
			ok: false,
			skipped: true,
			reason: expect.stringContaining("refreshAccount"),
		});
		expect(ports.tokenStore.snapshot()).toEqual({});
	});

	it("not_found when no registry", async () => {
		const ports = makePorts();
		const r = await refreshAccount({
			selector: { label: "Personal" },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
	});

	it("not_found when selector matches nothing", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await refreshAccount({
			selector: { label: "Nope" },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
	});

	it("no_refresh_token when currentTokens lacks refresh_token (paste-a-token path)", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await refreshAccount({
			selector: { label: "Personal" },
			currentTokens: { accessToken: "a", scopes: [] },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("no_refresh_token");
	});

	it("no_refresh_impl when ports.refresh not wired", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await refreshAccount({
			selector: { label: "Personal" },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("no_refresh_impl");
	});

	it("refresh_failed when the refresh impl returns not-ok", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			refresh: () => Promise.resolve({ ok: false, kind: "invalid_grant", detail: "dead" }),
		});
		const r = await refreshAccount({
			selector: { label: "Personal" },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("refresh_failed");
	});

	it("happy path: puts the new tokens (JSON blob) under the account uuid", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			refresh: () =>
				Promise.resolve({
					ok: true,
					tokens: { accessToken: "NEW", refreshToken: "NEWR", scopes: ["s"] },
				}),
		});
		const r = await refreshAccount({
			selector: { uuid: UUID_A },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertOk(r);
		const stored = ports.tokenStore.snapshot()[UUID_A];
		expect(JSON.parse(stored ?? "{}").accessToken).toBe("NEW");
	});

	it("token_store_failed surfaces when put throws", async () => {
		const store = new InMemoryMutableTokenStore();
		vi.spyOn(store, "put").mockRejectedValueOnce(new Error("kc fail"));
		const ports = makePorts({
			registry: baseRegistry(),
			tokenStore: store,
			refresh: () => Promise.resolve({ ok: true, tokens: { accessToken: "n", scopes: [] } }),
		});
		const r = await refreshAccount({
			selector: { uuid: UUID_A },
			currentTokens: tokens,
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("token_store_failed");
	});
});

describe("setPrimary — flag gate + invariant (exactly one primary)", () => {
	it("flag off → {skipped:true}, no writes", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await setPrimary({ selector: { label: "Work" }, ports, env: {} });
		expect(r).toEqual({
			ok: false,
			skipped: true,
			reason: expect.stringContaining("setPrimary"),
		});
		expect(ports.writes).toEqual([]);
	});

	it("flip: newly written registry has EXACTLY one primary (adversarial: allow zero → RED)", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await setPrimary({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertOk(r);
		expect(ports.writes).toHaveLength(1);
		const [written] = ports.writes;
		if (written === undefined) {
			throw new Error("expected one written registry");
		}
		const primaries = written.accounts.filter((a) => a.isPrimary);
		expect(primaries).toHaveLength(1);
		expect(primaries[0]?.label).toBe("Work");
	});

	it("already_primary when the target is already the primary", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await setPrimary({
			selector: { label: "Personal" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("already_primary");
		expect(ports.writes).toEqual([]);
	});

	it("not_found when no registry", async () => {
		const ports = makePorts();
		const r = await setPrimary({ selector: { label: "x" }, ports, overrideFlag: true });
		assertNotOk(r);
	});

	it("not_found when selector matches nothing", async () => {
		const ports = makePorts({ registry: baseRegistry() });
		const r = await setPrimary({ selector: { label: "Nope" }, ports, overrideFlag: true });
		assertNotOk(r);
	});

	it("registry_write_failed surfaces when writer throws", async () => {
		const ports = makePorts({
			registry: baseRegistry(),
			registryWriter: { write: () => Promise.reject(new Error("wf")) },
		});
		const r = await setPrimary({
			selector: { label: "Work" },
			ports,
			overrideFlag: true,
		});
		assertNotOk(r);
		const reason = "reason" in r ? r.reason : "";
		expect(reason).toBe("registry_write_failed");
	});
});

describe("commands — env fallback to process.env", () => {
	it("defaults env to process.env when omitted (skip when flag unset)", async () => {
		delete process.env.CLAUDE_MULTIACCT_ENABLE_SHIM;
		const ports = makePorts({ registry: baseRegistry() });
		const r = await setPrimary({ selector: { label: "Work" }, ports });
		expect("skipped" in r && r.skipped).toBe(true);
	});
});

describe("coerceUuid", () => {
	it("returns the value for a valid uuid", () => {
		expect(coerceUuid(UUID_A)).toBe(UUID_A);
	});
	it("throws for a non-uuid string", () => {
		expect(() => coerceUuid("nope")).toThrow(/uuid/iu);
	});
});
