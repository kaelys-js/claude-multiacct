/**
 * Intent: `account-admin.ts` is the seam between the pure add/remove routes and
 * the library pool mutations. Two things must hold:
 *
 *  1. ADD is provisioned through `cli/commands.ts::addAccount` with the token
 *     from the request, and every result — success, flag-off skip, and each
 *     provision failure kind — maps to the right HTTP status. The OAuth sign-in
 *     is mocked here via the injected `verify` port: no real Claude subprocess
 *     runs, exactly as the live daemon's verify would (only really talking to
 *     Claude), proving the mock seam the endpoint depends on.
 *  2. REMOVE runs the FULL teardown for real against in-memory stores. The two
 *     load-bearing guarantees are asserted directly: it removes ONLY the target
 *     (the other account's registry row and keychain token survive), and it
 *     FAILS CLOSED on a locked/failing keychain (the registry is never written
 *     when the token delete throws — the legacy over-broad-delete incident is
 *     why). Adversarial: swallow the delete error in
 *     `SecurityCliMutableTokenStore` (or drop the fail-closed ordering in
 *     `removeAccount`) and the "registry untouched" assertion flips red.
 */

import { describe, expect, it, vi } from "vitest";
import type { CliPorts } from "../cli/commands.ts";
import type { Account, AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { VerifyResult } from "../oauth/models.ts";
import { FLAG_ENABLED_VALUE, FLAG_ENV_VAR } from "../oauth/provisioning.ts";
import { InMemoryMutableTokenStore } from "../oauth/token-store-mut.ts";
import { makeAddAccount, makeRemoveAccount } from "./account-admin.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const ON = { [FLAG_ENV_VAR]: FLAG_ENABLED_VALUE };
const OFF: Record<string, string | undefined> = {};

// Module-scoped verify stubs (kept out of the `it` bodies so oxlint's
// consistent-function-scoping stays happy — they capture nothing local).
const verifyUnauthorized = (): Promise<VerifyResult> =>
	Promise.resolve({ ok: false, kind: "unauthorized", detail: "token rejected" });

function account(uuid: string, label: string): Account {
	return {
		uuid: uuid as AccountUuid,
		label,
		subscriptionType: "pro",
		rateLimitTier: "tier1",
		encryptedTokenRef: uuid,
	};
}

// Build CliPorts over in-memory stores. Returns the handles tests assert on.
function makePorts(opts: {
	registry: AccountRegistry | undefined;
	verify?: (token: string) => Promise<VerifyResult>;
	tokenStore?: CliPorts["tokenStore"];
	writeImpl?: (registry: AccountRegistry) => Promise<{ backup: string | undefined }>;
}): {
	ports: CliPorts;
	tokenStore: CliPorts["tokenStore"];
	write: ReturnType<typeof vi.fn>;
} {
	const tokenStore = opts.tokenStore ?? new InMemoryMutableTokenStore();
	const write = vi.fn<(registry: AccountRegistry) => Promise<{ backup: string | undefined }>>(
		opts.writeImpl ??
			((): Promise<{ backup: string | undefined }> => Promise.resolve({ backup: undefined })),
	);
	const ports: CliPorts = {
		tokenStore,
		registryWriter: { write },
		readRegistry: () => Promise.resolve(opts.registry),
		verify:
			opts.verify ??
			((): Promise<VerifyResult> =>
				Promise.resolve({
					ok: true,
					subscriptionType: "pro",
					rateLimitTier: "tier1",
					accountUuid: UUID_A,
				})),
	};
	return { ports, tokenStore, write };
}

describe("makeAddAccount", () => {
	it("provisions the account from the request token and returns it (verify mocked, no real sign-in)", async () => {
		const verify = vi.fn<(token: string) => Promise<VerifyResult>>(
			(): Promise<VerifyResult> =>
				Promise.resolve({
					ok: true,
					subscriptionType: "max",
					rateLimitTier: "tier2",
					accountUuid: UUID_A,
				}),
		);
		const { ports, tokenStore, write } = makePorts({ registry: undefined, verify });
		const add = makeAddAccount({ cliPorts: ports, env: ON });

		const outcome = await add({ label: "work", token: "sk-ant-oat-live" });

		expect(outcome).toEqual({
			ok: true,
			account: {
				uuid: UUID_A,
				label: "work",
				subscriptionType: "max",
				rateLimitTier: "tier2",
				encryptedTokenRef: UUID_A,
			},
		});
		// The token flowed to verify (the sign-in-proof seam) and into the store.
		expect(verify).toHaveBeenCalledWith("sk-ant-oat-live");
		await expect(tokenStore.get(UUID_A as AccountUuid)).resolves.toBe("sk-ant-oat-live");
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("flag-off env → 403 flag-off and NOTHING is provisioned", async () => {
		const { ports, write } = makePorts({ registry: undefined });
		const add = makeAddAccount({ cliPorts: ports, env: OFF });
		const outcome = await add({ label: "work", token: "t" });
		expect(outcome).toEqual({
			ok: false,
			status: 403,
			reason: "flag-off",
			detail: expect.any(String),
		});
		expect(write).not.toHaveBeenCalled();
	});

	it("verify failure → 400 (bad token is the caller's fault)", async () => {
		const { ports } = makePorts({ registry: undefined, verify: verifyUnauthorized });
		const outcome = await makeAddAccount({ cliPorts: ports, env: ON })({
			label: "w",
			token: "bad",
		});
		expect(outcome).toMatchObject({ ok: false, status: 400, reason: "verify_failed" });
	});

	it("duplicate label → 409 (conflict, not a 500)", async () => {
		const registry: AccountRegistry = { accounts: [account(UUID_B, "work")] };
		// The default verify returns UUID_A (a DIFFERENT uuid than the pooled
		// UUID_B), so it is the duplicate LABEL "work" that rejects, not the uuid.
		const { ports } = makePorts({ registry });
		const outcome = await makeAddAccount({ cliPorts: ports, env: ON })({
			label: "work",
			token: "t",
		});
		expect(outcome).toMatchObject({ ok: false, status: 409, reason: "duplicate_label" });
	});

	it("registry write failure → 500 (our fault, classified)", async () => {
		const { ports } = makePorts({
			registry: undefined,
			writeImpl: () => Promise.reject(new Error("disk full")),
		});
		const outcome = await makeAddAccount({ cliPorts: ports, env: ON })({ label: "w", token: "t" });
		expect(outcome).toMatchObject({ ok: false, status: 500, reason: "registry_write_failed" });
	});
});

describe("makeRemoveAccount", () => {
	it("removes ONLY the target: the other account's registry row + token survive", async () => {
		const registry: AccountRegistry = {
			accounts: [account(UUID_A, "keep"), account(UUID_B, "drop")],
		};
		const tokenStore = new InMemoryMutableTokenStore();
		await tokenStore.put(UUID_A as AccountUuid, "token-A");
		await tokenStore.put(UUID_B as AccountUuid, "token-B");
		const { ports, write } = makePorts({ registry, tokenStore });

		const outcome = await makeRemoveAccount({ cliPorts: ports, env: ON })(UUID_B);

		expect(outcome).toEqual({ ok: true, removed: account(UUID_B, "drop") });
		// The trimmed registry keeps exactly the non-target account.
		expect(write).toHaveBeenCalledTimes(1);
		const written = write.mock.calls[0]![0] as AccountRegistry;
		expect(written.accounts.map((a) => a.uuid)).toEqual([UUID_A]);
		// Target token gone; the other account's token is untouched.
		await expect(tokenStore.get(UUID_B as AccountUuid)).resolves.toBeUndefined();
		await expect(tokenStore.get(UUID_A as AccountUuid)).resolves.toBe("token-A");
	});

	it("unknown uuid → 404 not_found and no write", async () => {
		const registry: AccountRegistry = { accounts: [account(UUID_A, "keep")] };
		const { ports, write } = makePorts({ registry });
		const outcome = await makeRemoveAccount({ cliPorts: ports, env: ON })(UUID_B);
		expect(outcome).toMatchObject({ ok: false, status: 404, reason: "not_found" });
		expect(write).not.toHaveBeenCalled();
	});

	it("flag-off env → 403 flag-off and nothing is touched", async () => {
		const registry: AccountRegistry = { accounts: [account(UUID_A, "keep"), account(UUID_B, "x")] };
		const { ports, write } = makePorts({ registry });
		const outcome = await makeRemoveAccount({ cliPorts: ports, env: OFF })(UUID_B);
		expect(outcome).toMatchObject({ ok: false, status: 403, reason: "flag-off" });
		expect(write).not.toHaveBeenCalled();
	});

	it("FAILS CLOSED on a locked keychain: token delete throws → registry NEVER written (500)", async () => {
		const registry: AccountRegistry = {
			accounts: [account(UUID_A, "keep"), account(UUID_B, "drop")],
		};
		// A store whose read works (snapshot) but whose delete throws, modelling a
		// locked keychain. removeAccount must abort with token_store_failed and
		// leave the registry write untouched — dropping the row while the token
		// survives would be the opposite of fail-closed.
		const lockedStore: CliPorts["tokenStore"] = {
			get: () => Promise.resolve("token-B"),
			put: () => Promise.resolve(),
			delete: () => Promise.reject(new Error("keychain is locked")),
		};
		const { ports, write } = makePorts({ registry, tokenStore: lockedStore });

		const outcome = await makeRemoveAccount({ cliPorts: ports, env: ON })(UUID_B);

		expect(outcome).toMatchObject({ ok: false, status: 500, reason: "token_store_failed" });
		expect(write).not.toHaveBeenCalled();
	});

	it("registry write failure → 500 registry_write_failed (token rollback attempted)", async () => {
		const registry: AccountRegistry = {
			accounts: [account(UUID_A, "keep"), account(UUID_B, "drop")],
		};
		const tokenStore = new InMemoryMutableTokenStore();
		await tokenStore.put(UUID_B as AccountUuid, "token-B");
		const { ports } = makePorts({
			registry,
			tokenStore,
			writeImpl: () => Promise.reject(new Error("rename failed")),
		});

		const outcome = await makeRemoveAccount({ cliPorts: ports, env: ON })(UUID_B);

		expect(outcome).toMatchObject({ ok: false, status: 500, reason: "registry_write_failed" });
		// Rollback restored the token so the pool isn't left inconsistent.
		await expect(tokenStore.get(UUID_B as AccountUuid)).resolves.toBe("token-B");
	});
});
