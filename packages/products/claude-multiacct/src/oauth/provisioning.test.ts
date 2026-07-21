/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, eslint/prefer-promise-reject-errors, unicorn/numeric-separators-style, typescript/explicit-function-return-type */
/**
 * Intent: the ATOMICITY test is the load-bearing one — provisioning must
 * never leave the pool with a keychain token whose registry entry did not
 * land. The rollback fires when the registry writer throws AFTER the token
 * store succeeded; adversarial removal of the rollback makes the
 * "token store empty after writer throws" test go red.
 *
 * Every other test locks a distinct failure branch — GATED-PR flag skip,
 * verify_failed, duplicate_label, duplicate_uuid, token_store_failed — so
 * the classification cannot silently collapse.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../domain/registry.ts";
import type { AtomicRegistryWriter } from "../registry/registry-writer.ts";
import type { VerifyResult } from "./models.ts";
import {
	FLAG_ENV_VAR,
	provisionAccount,
	type ProvisionPorts,
	type VerifyFn,
} from "./provisioning.ts";
import { InMemoryMutableTokenStore } from "./token-store-mut.ts";
import { assertNotOk, assertOk } from "./test-utils.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function okVerify(uuid: string): VerifyResult {
	return { ok: true, subscriptionType: "Pro", rateLimitTier: "tier-2", accountUuid: uuid };
}

function makePorts(
	overrides: Partial<ProvisionPorts> & {
		verify?: VerifyFn;
		registry?: AccountRegistry | undefined;
	} = {},
): ProvisionPorts & {
	writes: AccountRegistry[];
	tokenStore: InMemoryMutableTokenStore;
} {
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
		overrides.verify ?? ((): Promise<VerifyResult> => Promise.resolve(okVerify(UUID_A)));
	return { tokenStore, registryWriter, readRegistry, verify, writes };
}

describe("provisionAccount — flag gate (GATED-PR contract)", () => {
	it("flag off → {ok:false, kind:'skipped'} and NO writes to any port", async () => {
		const ports = makePorts();
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			env: {},
		});
		expect(result).toEqual({
			ok: false,
			kind: "skipped",
			detail: expect.stringContaining(FLAG_ENV_VAR),
		});
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});
	it("overrideFlag=true bypasses the gate (test knob)", async () => {
		const ports = makePorts();
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			env: {},
			overrideFlag: true,
		});
		assertOk(result);
	});
	it("flag on via env → runs", async () => {
		const ports = makePorts();
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			env: { [FLAG_ENV_VAR]: "1" },
		});
		assertOk(result);
	});
});

describe("provisionAccount — verify_failed", () => {
	it("verify failure → {kind:'verify_failed'} and NO writes", async () => {
		const ports = makePorts({
			verify: () => Promise.resolve({ ok: false, kind: "unauthorized", detail: "bad token" }),
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		expect(result).toEqual({
			ok: false,
			kind: "verify_failed",
			detail: expect.stringContaining("unauthorized"),
		});
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});
});

describe("provisionAccount — duplicate rejects (PR1 invariants stay unforced-on writer)", () => {
	const existing: AccountRegistry = {
		accounts: [
			{
				uuid: UUID_A as AccountRegistry["accounts"][0]["uuid"],
				label: "Personal",
				isPrimary: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:a",
			},
		],
	};
	it("duplicate label → {kind:'duplicate_label'}, no writes", async () => {
		const ports = makePorts({
			registry: existing,
			verify: () => Promise.resolve(okVerify(UUID_B)),
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.kind).toBe("duplicate_label");
		expect(ports.writes).toEqual([]);
		expect(ports.tokenStore.snapshot()).toEqual({});
	});
	it("duplicate account uuid (from verify) → {kind:'duplicate_uuid'}, no writes", async () => {
		const ports = makePorts({
			registry: existing,
			verify: () => Promise.resolve(okVerify(UUID_A)),
		});
		const result = await provisionAccount({
			label: "Work",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.kind).toBe("duplicate_uuid");
		expect(ports.writes).toEqual([]);
	});
});

describe("provisionAccount — ATOMICITY (the load-bearing test)", () => {
	it("writer throws AFTER token-store put → token store is EMPTY (rollback fired)", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		const deleteSpy = vi.spyOn(tokenStore, "delete");
		const ports = makePorts({
			tokenStore,
			registryWriter: {
				write: () => Promise.reject(new Error("simulated write fail")),
			},
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
		expect(result.detail).toContain("simulated write fail");
		// The rollback assertion — the ONE thing that goes red under a
		// missing-rollback regression.
		expect(tokenStore.snapshot()).toEqual({});
		expect(deleteSpy).toHaveBeenCalled();
	});

	it("token-store put fails → {kind:'token_store_failed'}, no writer call", async () => {
		let writerCalls = 0;
		const failingStore = new InMemoryMutableTokenStore();
		vi.spyOn(failingStore, "put").mockRejectedValueOnce(new Error("keychain fell over"));
		const ports = makePorts({
			tokenStore: failingStore,
			registryWriter: {
				write: () => {
					writerCalls += 1;
					return Promise.resolve({ backup: undefined });
				},
			},
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.kind).toBe("token_store_failed");
		expect(writerCalls).toBe(0);
	});

	it("writer rejects with a raw string → detail stringifies via errMsg non-Error branch", async () => {
		const ports = makePorts({
			registryWriter: {
				// oxlint-disable-next-line prefer-promise-reject-errors
				write: () => Promise.reject("string-not-error"),
			},
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.detail).toContain("string-not-error");
	});

	it("rollback delete rejects with a raw string → detail carries both", async () => {
		const store = new InMemoryMutableTokenStore();
		// oxlint-disable-next-line prefer-promise-reject-errors
		vi.spyOn(store, "delete").mockRejectedValueOnce("raw-rollback");
		const ports = makePorts({
			tokenStore: store,
			// oxlint-disable-next-line prefer-promise-reject-errors
			registryWriter: { write: () => Promise.reject("raw-primary") },
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.detail).toContain("raw-primary");
		expect(result.detail).toContain("raw-rollback");
	});

	it("rollback delete ALSO fails → detail carries both errors (still surfaces write_failed)", async () => {
		const store = new InMemoryMutableTokenStore();
		vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("rollback boom"));
		const ports = makePorts({
			tokenStore: store,
			registryWriter: { write: () => Promise.reject(new Error("primary boom")) },
		});
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
		expect(result.detail).toContain("primary boom");
		expect(result.detail).toContain("rollback ALSO failed");
		expect(result.detail).toContain("rollback boom");
	});
});

describe("provisionAccount — happy path", () => {
	it("first account into empty pool becomes primary (PR1 invariant)", async () => {
		const ports = makePorts();
		const result = await provisionAccount({
			label: "Personal",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertOk(result);
		expect(result.account.isPrimary).toBe(true);
		expect(result.account.uuid).toBe(UUID_A);
		expect(result.account.label).toBe("Personal");
		expect(result.account.encryptedTokenRef).toBe(UUID_A);
		expect(ports.writes).toHaveLength(1);
		expect(ports.tokenStore.snapshot()[UUID_A]).toBe("t");
	});

	it("second account added to existing pool is non-primary by default", async () => {
		const existing: AccountRegistry = {
			accounts: [
				{
					uuid: UUID_A as AccountRegistry["accounts"][0]["uuid"],
					label: "Personal",
					isPrimary: true,
					subscriptionType: "Pro",
					rateLimitTier: "tier-2",
					encryptedTokenRef: "keychain:a",
				},
			],
		};
		const ports = makePorts({
			registry: existing,
			verify: () => Promise.resolve(okVerify(UUID_B)),
		});
		const result = await provisionAccount({
			label: "Work",
			token: "t",
			ports,
			overrideFlag: true,
		});
		assertOk(result);
		expect(result.account.isPrimary).toBe(false);
		expect(ports.writes[0]?.accounts).toHaveLength(2);
	});
});

describe("provisionAccount — default env fallback", () => {
	it("reads process.env when no env passed", async () => {
		// Ensure the flag is NOT set in process.env → default env → skipped.
		Reflect.deleteProperty(process.env, FLAG_ENV_VAR);
		const ports = makePorts();
		const result = await provisionAccount({ label: "P", token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("skipped");
	});
});
