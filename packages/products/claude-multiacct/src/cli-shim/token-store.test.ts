/**
 * Intent: the `TokenStore` port allows an unknown uuid to be a soft miss
 * (`undefined`), but the shim's runtime only queries it AFTER resolving a
 * choice → a miss at that point is an invariant violation, not a soft case.
 * These tests pin that both adapters THROW on unknown uuids (Rule 12).
 * Round-trip pins put→get identity.
 *
 * `SecurityCliTokenStore` uses an injectable `exec` (defaults to
 * `child_process.execFile` promisified) so tests can assert EXACT argv —
 * shelling out to the real `security` CLI is opt-in via
 * `CMA_TEST_KEYCHAIN=1` and skipped by default so CI never prompts the user
 * keychain.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import {
	type ExecFileAsync,
	InMemoryTokenStore,
	KEYCHAIN_SERVICE,
	parseKeychainServiceAccounts,
	SecurityCliTokenStore,
} from "./token-store.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_MISSING = "99999999-9999-4999-8999-999999999999" as AccountUuid;

describe("InMemoryTokenStore", () => {
	it("round-trips put → get", async () => {
		const store = new InMemoryTokenStore();
		await store.put(UUID_A, "handle-1");
		await expect(store.get(UUID_A)).resolves.toBe("handle-1");
	});

	it("get on an unknown uuid THROWS (Rule 12 — fail loud)", async () => {
		const store = new InMemoryTokenStore();
		await expect(store.get(UUID_MISSING)).rejects.toThrow(/no token for account/u);
	});

	it("put with the same uuid overwrites (idempotent update)", async () => {
		const store = new InMemoryTokenStore();
		await store.put(UUID_A, "v1");
		await store.put(UUID_A, "v2");
		await expect(store.get(UUID_A)).resolves.toBe("v2");
	});
});

describe("SecurityCliTokenStore", () => {
	it("dedicated service name is isolated from Anthropic's Claude Safe Storage", () => {
		// If someone renames the constant to reuse Anthropic's service, we'd start
		// reading/writing the desktop's keychain item — data-loss risk. Pin it.
		expect(KEYCHAIN_SERVICE).toBe("com.claude-multiacct.tokens");
		expect(KEYCHAIN_SERVICE).not.toMatch(/Claude Safe Storage/iu);
	});

	it("get invokes `security find-generic-password -w` with the dedicated service + uuid", async () => {
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "handle-1\n", stderr: "" });
		const store = new SecurityCliTokenStore(exec);
		const value = await store.get(UUID_A);
		expect(value).toBe("handle-1");
		expect(exec).toHaveBeenCalledWith("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
			"-w",
		]);
	});

	it("get on an unknown uuid throws with the uuid in the message (fail loud)", async () => {
		const exec = vi.fn<ExecFileAsync>().mockRejectedValue(new Error("exit 44"));
		const store = new SecurityCliTokenStore(exec);
		await expect(store.get(UUID_MISSING)).rejects.toThrow(new RegExp(UUID_MISSING, "u"));
	});

	it("put invokes `security add-generic-password -U` (idempotent update)", async () => {
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "", stderr: "" });
		const store = new SecurityCliTokenStore(exec);
		await store.put(UUID_A, "handle-x");
		expect(exec).toHaveBeenCalledWith("security", [
			"add-generic-password",
			"-U",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
			"-w",
			"handle-x",
		]);
	});

	// Real-keychain smoke, opt-in only — CI does not run this because the
	// security framework may prompt for consent even on read.
	const runReal = process.platform === "darwin" && process.env.CMA_TEST_KEYCHAIN === "1";
	it.skipIf(!runReal)("round-trips through the real `security` CLI (opt-in)", async () => {
		const store = new SecurityCliTokenStore();
		await store.put(UUID_A, "test-real-handle");
		await expect(store.get(UUID_A)).resolves.toBe("test-real-handle");
	});
});

// A realistic `security dump-keychain` fragment: items across two services.
// Only items under our dedicated service must come back; the `Claude Safe
// Storage` item (Anthropic's own key) must be excluded — that exclusion is the
// load-bearing safety property the prune relies on.
function dumpWith(...blocks: string[]): string {
	return blocks.join("\n");
}
const SAFE_STORAGE_BLOCK = [
	'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
	'    class: "genp"',
	'    "acct"<blob>="Claude Key"',
	'    "svce"<blob>="Claude Safe Storage"',
].join("\n");
function ourBlock(uuid: string): string {
	return [
		'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
		'    class: "genp"',
		`    "acct"<blob>="${uuid}"`,
		'    "svce"<blob>="com.claude-multiacct.tokens"',
	].join("\n");
}

describe("parseKeychainServiceAccounts", () => {
	const safeStorageBlock = SAFE_STORAGE_BLOCK;

	it("returns ONLY the accounts under the requested service", () => {
		const dump = dumpWith(safeStorageBlock, ourBlock(UUID_A), ourBlock(UUID_B));
		const accounts = parseKeychainServiceAccounts(dump, KEYCHAIN_SERVICE);
		expect(accounts).toEqual([UUID_A, UUID_B]);
	});

	it("never returns the Claude Safe Storage item even when it is the only block", () => {
		expect(parseKeychainServiceAccounts(safeStorageBlock, KEYCHAIN_SERVICE)).toEqual([]);
	});

	it("de-dupes a repeated account and ignores a non-uuid acct under our service", () => {
		const dump = dumpWith(
			ourBlock(UUID_A),
			ourBlock(UUID_A),
			[
				'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
				'    "acct"<blob>="not-a-uuid"',
				'    "svce"<blob>="com.claude-multiacct.tokens"',
			].join("\n"),
		);
		expect(parseKeychainServiceAccounts(dump, KEYCHAIN_SERVICE)).toEqual([UUID_A]);
	});

	it("returns [] for an empty dump", () => {
		expect(parseKeychainServiceAccounts("", KEYCHAIN_SERVICE)).toEqual([]);
	});

	it("skips a block for our service that has no acct attribute", () => {
		const dump = dumpWith(
			[
				'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
				'    "svce"<blob>="com.claude-multiacct.tokens"',
			].join("\n"),
			ourBlock(UUID_A),
		);
		expect(parseKeychainServiceAccounts(dump, KEYCHAIN_SERVICE)).toEqual([UUID_A]);
	});
});
