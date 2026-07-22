/* oxlint-disable vitest/expect-expect, typescript/explicit-function-return-type, vitest/no-conditional-in-test */
/**
 * Intent: `registerOrUpdateAccount` is the terminal step of the in-app OAuth
 * login — it turns a proven token + resolved identity into a pooled account.
 * Load-bearing behaviours pinned here:
 *
 *   1. A NEW accountUuid is provisioned as `source:"explicit"` with the real
 *      identity attached, `updated:false`.
 *   2. Re-adding an account already in the pool (dedup by `accountUuid`) is an
 *      UPSERT: the stored token is swapped, identity refreshed, and the local
 *      uuid / label / source PRESERVED — `updated:true`, never a second entry.
 *      Adversarial: change the match to always-miss and the "no duplicate on
 *      re-add" test reddens (two accounts appear).
 *   3. The update rolls the token back if the registry write fails, so a failed
 *      update never leaves a keychain token the registry disagrees with.
 *   4. Labels are derived from identity (email → displayName → uuid), never
 *      `account-N`.
 */

import { describe, expect, it } from "vitest";
import type { AccountProfile } from "../discovery/identity.ts";
import type { Account, ClaudeAccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { AtomicRegistryWriter } from "../registry/registry-writer.ts";
import { deriveLabel, type RegisterPorts, registerOrUpdateAccount } from "./register-account.ts";
import { assertNotOk, assertOk } from "./test-utils.ts";
import { InMemoryMutableTokenStore } from "./token-store-mut.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function profile(uuid: string, over: Partial<AccountProfile> = {}): AccountProfile {
	return {
		accountUuid: uuid as ClaudeAccountUuid,
		email: "alice@example.com",
		displayName: "Alice",
		subscriptionType: "claude_max",
		rateLimitTier: "unknown",
		...over,
	};
}

function makePorts(
	over: {
		registry?: AccountRegistry | undefined;
		registryWriter?: Pick<AtomicRegistryWriter, "write">;
		tokenStore?: InMemoryMutableTokenStore;
	} = {},
): RegisterPorts & { writes: AccountRegistry[]; tokenStore: InMemoryMutableTokenStore } {
	const tokenStore = over.tokenStore ?? new InMemoryMutableTokenStore();
	const writes: AccountRegistry[] = [];
	const registryWriter = over.registryWriter ?? {
		write: (r: AccountRegistry) => {
			writes.push(r);
			return Promise.resolve({ backup: undefined });
		},
	};
	const readRegistry = () => Promise.resolve(over.registry);
	return { tokenStore, registryWriter, readRegistry, writes };
}

describe("deriveLabel", () => {
	it("prefers email, then displayName, then a uuid slice — never account-N", () => {
		expect(deriveLabel(profile(UUID_A))).toBe("alice@example.com");
		expect(deriveLabel(profile(UUID_A, { email: undefined }))).toBe("Alice");
		expect(deriveLabel(profile(UUID_A, { email: undefined, displayName: undefined }))).toBe(
			`Claude ${UUID_A.slice(0, 8)}`,
		);
	});
});

describe("registerOrUpdateAccount — new account", () => {
	it("provisions a source:explicit account with identity and updated:false", async () => {
		const ports = makePorts({ registry: undefined });
		const result = await registerOrUpdateAccount({
			profile: profile(UUID_A),
			token: "tok-a",
			ports,
		});
		assertOk(result);
		expect(result.updated).toBe(false);
		expect(result.account.uuid).toBe(UUID_A);
		expect(result.account.accountUuid).toBe(UUID_A);
		expect(result.account.source).toBe("explicit");
		expect(result.account.label).toBe("alice@example.com");
		expect(result.account.identity).toStrictEqual({
			email: "alice@example.com",
			displayName: "Alice",
		});
		expect(await ports.tokenStore.get(result.account.uuid)).toBe("tok-a");
		expect(ports.writes).toHaveLength(1);
	});

	it("omits identity when the profile has neither email nor displayName", async () => {
		const ports = makePorts({ registry: undefined });
		const result = await registerOrUpdateAccount({
			profile: profile(UUID_A, { email: undefined, displayName: undefined }),
			token: "tok-a",
			ports,
		});
		assertOk(result);
		expect(result.account.identity).toBeUndefined();
		expect(result.account.label).toBe(`Claude ${UUID_A.slice(0, 8)}`);
	});

	it("honors an explicit label override", async () => {
		const ports = makePorts({ registry: undefined });
		const result = await registerOrUpdateAccount({
			profile: profile(UUID_A),
			token: "t",
			ports,
			label: "Work",
		});
		assertOk(result);
		expect(result.account.label).toBe("Work");
	});
});

describe("registerOrUpdateAccount — re-add is an upsert (dedup by accountUuid)", () => {
	function existingAccount(): Account {
		return {
			uuid: UUID_A as Account["uuid"],
			label: "old-label",
			subscriptionType: "unknown",
			rateLimitTier: "unknown",
			encryptedTokenRef: UUID_A,
			accountUuid: UUID_A as ClaudeAccountUuid,
			source: "native",
		};
	}

	it("updates in place: swaps token, refreshes identity, keeps uuid/label/source; updated:true", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		await tokenStore.put(UUID_A as Account["uuid"], "old-token");
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({ registry, tokenStore });

		const result = await registerOrUpdateAccount({
			profile: profile(UUID_A, { email: "alice+new@example.com" }),
			token: "new-token",
			ports,
		});
		assertOk(result);
		expect(result.updated).toBe(true);
		// Identity refreshed, but the local uuid, label, and native source kept.
		expect(result.account.uuid).toBe(UUID_A);
		expect(result.account.label).toBe("old-label");
		expect(result.account.source).toBe("native");
		expect(result.account.subscriptionType).toBe("claude_max");
		expect(result.account.identity).toStrictEqual({
			email: "alice+new@example.com",
			displayName: "Alice",
		});
		// Token swapped; still exactly one registry entry.
		expect(await ports.tokenStore.get(UUID_A as Account["uuid"])).toBe("new-token");
		expect(ports.writes).toHaveLength(1);
		expect(ports.writes[0]!.accounts).toHaveLength(1);
	});

	it("updates the matching entry among several, leaving others untouched and identity intact when the profile omits it", async () => {
		const other: Account = {
			uuid: UUID_B as Account["uuid"],
			label: "bob",
			subscriptionType: "unknown",
			rateLimitTier: "unknown",
			encryptedTokenRef: UUID_B,
			accountUuid: UUID_B as ClaudeAccountUuid,
			source: "explicit",
		};
		const registry: AccountRegistry = { accounts: [other, existingAccount()] };
		const ports = makePorts({ registry });
		const result = await registerOrUpdateAccount({
			profile: profile(UUID_A, { email: undefined, displayName: undefined }),
			token: "t",
			ports,
		});
		assertOk(result);
		expect(result.updated).toBe(true);
		// No `identity` written when the profile has none (the spread is empty).
		expect(result.account.identity).toBeUndefined();
		// Both entries survive; only the match changed.
		expect(ports.writes[0]!.accounts).toHaveLength(2);
		expect(ports.writes[0]!.accounts.find((a) => a.uuid === UUID_B)).toStrictEqual(other);
	});

	it("token_store put rejecting a non-Error value still classifies as token_store_failed", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		// eslint-disable-next-line prefer-promise-reject-errors
		tokenStore.put = () => Promise.reject("bare string" as unknown as Error);
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({ registry, tokenStore });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("token_store_failed");
		expect(result.detail).toBe("bare string");
	});

	it("registry write rejecting a non-Error value still classifies as registry_write_failed", async () => {
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({
			registry,
			// eslint-disable-next-line prefer-promise-reject-errors
			registryWriter: { write: () => Promise.reject("disk gone" as unknown as Error) },
		});
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "new", ports });
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
		expect(result.detail).toContain("disk gone");
	});

	it("defaults a missing source to explicit on update", async () => {
		const acct = { ...existingAccount() };
		delete (acct as { source?: string }).source;
		const registry: AccountRegistry = { accounts: [acct] };
		const ports = makePorts({ registry });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertOk(result);
		expect(result.account.source).toBe("explicit");
	});

	it("token_store put failure on update → token_store_failed", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		tokenStore.put = () => Promise.reject(new Error("keychain locked"));
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({ registry, tokenStore });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("token_store_failed");
	});

	it("registry write failure on update → rolls the token back to the snapshot", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		await tokenStore.put(UUID_A as Account["uuid"], "old-token");
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({
			registry,
			tokenStore,
			registryWriter: { write: () => Promise.reject(new Error("disk full")) },
		});
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "new", ports });
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
		// Rolled back to the snapshot, not left as "new".
		expect(await tokenStore.get(UUID_A as Account["uuid"])).toBe("old-token");
	});

	it("registry write failure with no prior token → rollback deletes the just-put token", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({
			registry,
			tokenStore,
			registryWriter: { write: () => Promise.reject(new Error("disk full")) },
		});
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "new", ports });
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
		expect(await tokenStore.get(UUID_A as Account["uuid"])).toBeUndefined();
	});

	it("surfaces a secondary rollback failure in the detail", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		await tokenStore.put(UUID_A as Account["uuid"], "old-token");
		tokenStore.put = ((uuid: Account["uuid"], v: string) => {
			// First put (the token swap) succeeds; restore put throws a NON-Error
			// so the catch's `String(error)` fallback branch is exercised too.
			if (v === "old-token") {
				// eslint-disable-next-line prefer-promise-reject-errors
				return Promise.reject("restore boom" as unknown as Error);
			}
			return InMemoryMutableTokenStore.prototype.put.call(tokenStore, uuid, v);
		}) as InMemoryMutableTokenStore["put"];
		const registry: AccountRegistry = { accounts: [existingAccount()] };
		const ports = makePorts({
			registry,
			tokenStore,
			registryWriter: { write: () => Promise.reject(new Error("disk full")) },
		});
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "new", ports });
		assertNotOk(result);
		expect(result.detail).toContain("token rollback ALSO failed");
	});
});

describe("registerOrUpdateAccount — new-path failures + label conflict", () => {
	it("maps a provision token_store failure to token_store_failed", async () => {
		const tokenStore = new InMemoryMutableTokenStore();
		tokenStore.put = () => Promise.reject(new Error("keychain locked"));
		const ports = makePorts({ registry: undefined, tokenStore });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("token_store_failed");
	});

	it("maps a provision registry-write failure to registry_write_failed", async () => {
		const ports = makePorts({
			registry: undefined,
			registryWriter: { write: () => Promise.reject(new Error("disk full")) },
		});
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("registry_write_failed");
	});

	it("retries with a uuid-suffixed label when a DIFFERENT account already holds the derived label", async () => {
		// Existing account B carries the same email-derived label but a different
		// accountUuid — so there is no uuid match, provisioning first hits
		// duplicate_label, and the retry must succeed with a unique label.
		const registry: AccountRegistry = {
			accounts: [
				{
					uuid: UUID_B as Account["uuid"],
					label: "alice@example.com",
					subscriptionType: "unknown",
					rateLimitTier: "unknown",
					encryptedTokenRef: UUID_B,
					accountUuid: UUID_B as ClaudeAccountUuid,
					source: "explicit",
				},
			],
		};
		const ports = makePorts({ registry });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertOk(result);
		expect(result.updated).toBe(false);
		expect(result.account.label).toBe(`alice@example.com (${UUID_A})`);
	});

	it("returns duplicate_label when even the suffixed retry collides", async () => {
		const registry: AccountRegistry = {
			accounts: [
				{
					uuid: UUID_B as Account["uuid"],
					label: "alice@example.com",
					subscriptionType: "unknown",
					rateLimitTier: "unknown",
					encryptedTokenRef: UUID_B,
					accountUuid: UUID_B as ClaudeAccountUuid,
					source: "explicit",
				},
				{
					uuid: "33333333-3333-4333-8333-333333333333" as Account["uuid"],
					label: `alice@example.com (${UUID_A})`,
					subscriptionType: "unknown",
					rateLimitTier: "unknown",
					encryptedTokenRef: "33333333-3333-4333-8333-333333333333",
					accountUuid: "33333333-3333-4333-8333-333333333333" as ClaudeAccountUuid,
					source: "explicit",
				},
			],
		};
		const ports = makePorts({ registry });
		const result = await registerOrUpdateAccount({ profile: profile(UUID_A), token: "t", ports });
		assertNotOk(result);
		expect(result.kind).toBe("duplicate_label");
	});
});
