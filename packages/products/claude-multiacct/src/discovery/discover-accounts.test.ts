/* oxlint-disable vitest/require-mock-type-parameters */
/**
 * Intent: discovery no longer imports every cached token — it reconciles EXACTLY
 * the native account into the pool and dedups by the real Claude account uuid.
 * The tests pin: it registers the detected native account once, it is idempotent
 * when that account is already pooled (dedup, not a second entry), it does
 * nothing when detection fails (fail closed), it surfaces a provisioning failure,
 * and its labels are always meaningful — never `account-N`.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountRegistry } from "../domain/registry.ts";
import { deriveNativeLabel, discoverAccounts, type DiscoveryPorts } from "./discover-accounts.ts";
import type { DetectedNativeAccount } from "./native-account.ts";

const NATIVE_UUID = "918f32f7-44c2-442e-8d5d-48ca3792ea95";
const LOCAL_UUID = "11111111-1111-4111-8111-111111111111";

function detected(overrides: Partial<DetectedNativeAccount> = {}): DetectedNativeAccount {
	return {
		accountUuid: NATIVE_UUID as never,
		token: "tok-native",
		identity: { email: "cole@icloud.com", displayName: "Cole" },
		subscriptionType: "claude_max",
		rateLimitTier: "unknown",
		...overrides,
	};
}

function registryWith(accountUuid: string): AccountRegistry {
	return {
		accounts: [
			{
				uuid: LOCAL_UUID as AccountRegistry["accounts"][0]["uuid"],
				label: "icloud",
				subscriptionType: "claude_max",
				rateLimitTier: "unknown",
				encryptedTokenRef: accountUuid,
				accountUuid: accountUuid as AccountRegistry["accounts"][0]["accountUuid"],
				source: "native",
			},
		],
	};
}

type PortOverrides = Partial<DiscoveryPorts>;

function makePorts(o: PortOverrides = {}): DiscoveryPorts & {
	provisionNative: ReturnType<typeof vi.fn>;
} {
	const provisionNative =
		(o.provisionNative as ReturnType<typeof vi.fn> | undefined) ??
		vi.fn(() => Promise.resolve({ ok: true, uuid: LOCAL_UUID }));
	return {
		detectNative: o.detectNative ?? (() => Promise.resolve(detected())),
		readRegistry: o.readRegistry ?? (() => Promise.resolve(undefined)),
		provisionNative,
		logger: o.logger ?? { log: vi.fn(), warn: vi.fn() },
	} as DiscoveryPorts & { provisionNative: ReturnType<typeof vi.fn> };
}

describe("discoverAccounts — native reconcile", () => {
	it("registers the detected native account (empty pool) with its real identity + label", async () => {
		const ports = makePorts();
		const outcome = await discoverAccounts(ports);
		expect(outcome.detected?.accountUuid).toBe(NATIVE_UUID);
		expect(outcome.registered).toEqual({ uuid: LOCAL_UUID, label: "icloud" });
		expect(outcome.alreadyRegistered).toBe(false);
		expect(ports.provisionNative).toHaveBeenCalledWith(
			expect.objectContaining({
				token: "tok-native",
				label: "icloud",
				accountUuid: NATIVE_UUID,
				identity: { email: "cole@icloud.com", displayName: "Cole" },
				subscriptionType: "claude_max",
			}),
		);
	});

	it("is idempotent: does NOT re-register when the accountUuid is already pooled (dedup)", async () => {
		const ports = makePorts({ readRegistry: () => Promise.resolve(registryWith(NATIVE_UUID)) });
		const outcome = await discoverAccounts(ports);
		expect(outcome.alreadyRegistered).toBe(true);
		expect(outcome.registered).toBeUndefined();
		expect(ports.provisionNative).not.toHaveBeenCalled();
	});

	it("registers when the pool holds a DIFFERENT account (accountUuid does not collide)", async () => {
		const other = "a473d7bb-17ac-43a7-abc0-a1343d7c2805";
		const ports = makePorts({ readRegistry: () => Promise.resolve(registryWith(other)) });
		const outcome = await discoverAccounts(ports);
		expect(outcome.alreadyRegistered).toBe(false);
		expect(ports.provisionNative).toHaveBeenCalledTimes(1);
	});

	it("does nothing when native detection fails (fail closed)", async () => {
		const ports = makePorts({ detectNative: () => Promise.resolve(undefined) });
		const outcome = await discoverAccounts(ports);
		expect(outcome).toEqual({
			detected: undefined,
			registered: undefined,
			alreadyRegistered: false,
			failed: undefined,
		});
		expect(ports.provisionNative).not.toHaveBeenCalled();
	});

	it("surfaces a provisioning failure without registering", async () => {
		const ports = makePorts({
			provisionNative: vi.fn(() =>
				Promise.resolve({
					ok: false as const,
					kind: "token_store_failed",
					detail: "keychain locked",
				}),
			),
		});
		const outcome = await discoverAccounts(ports);
		expect(outcome.registered).toBeUndefined();
		expect(outcome.failed).toEqual({ kind: "token_store_failed", detail: "keychain locked" });
	});
});

describe("deriveNativeLabel — always meaningful, never account-N", () => {
	it("maps icloud/me/mac emails to 'icloud'", () => {
		expect(deriveNativeLabel({ email: "a@icloud.com" })).toBe("icloud");
		expect(deriveNativeLabel({ email: "a@me.com" })).toBe("icloud");
		expect(deriveNativeLabel({ email: "a@mac.com" })).toBe("icloud");
	});

	it("maps gmail/googlemail to 'gmail'", () => {
		expect(deriveNativeLabel({ email: "a@gmail.com" })).toBe("gmail");
		expect(deriveNativeLabel({ email: "a@googlemail.com" })).toBe("gmail");
	});

	it("uses the domain's first label for other emails", () => {
		expect(deriveNativeLabel({ email: "me@work.co.uk" })).toBe("work");
	});

	it("falls back to a slugified display name when there is no usable email", () => {
		expect(deriveNativeLabel({ displayName: "Cole Bieker" })).toBe("cole-bieker");
		expect(deriveNativeLabel({ email: "a@", displayName: "Team Acct" })).toBe("team-acct");
	});

	it("falls back to 'native' when identity carries nothing usable", () => {
		expect(deriveNativeLabel({})).toBe("native");
		expect(deriveNativeLabel({ email: "a@", displayName: "   " })).toBe("native");
	});
});
