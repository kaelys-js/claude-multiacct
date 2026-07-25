/**
 * Intent: `SecurityCliMutableTokenStore` is what `provisionAccount` uses for
 * atomic rollback — if the registry write fails after the token write landed,
 * the pipeline calls `delete` to avoid an orphan keychain credential. So the
 * two things that matter here are: (1) `delete` issues the EXACT
 * `security delete-generic-password` argv against the dedicated service, and
 * (2) delete distinguishes "already gone" from "could not touch the keychain".
 * An absent item (exit 44 / errSecItemNotFound) is a silent no-op — rollback
 * runs on error paths where the credential may or may not exist and must never
 * throw a second failure on top of the first. But ANY other failure (a locked
 * keychain, a denied ACL) must PROPAGATE: `removeAccount` deletes the token
 * before the registry write, so swallowing a real keychain error would drop the
 * registry entry while the credential lingers — the opposite of fail-closed.
 *
 * get/put reach the base `SecurityCliTokenStore` argv; we assert that so a
 * refactor dropping the delegation is caught.
 *
 * The record surface carries the rest of the intent. `refreshToken` +
 * `expiresAt` are the ONLY material that can renew an expiring access token, so
 * a store that persists just `accessToken` silently kills every account it
 * writes about an hour later, recoverable only by re-registering. An earlier
 * build of `putRecord` did exactly that. The round-trip test below fails if the
 * drop comes back, and the legacy test pins that a keychain secret written by a
 * pre-record build still reads as a record rather than as a corrupt entry.
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import { SecurityCliMutableTokenStore } from "./mutable-token-store.ts";
import { type ExecFileAsync, KEYCHAIN_SERVICE } from "./token-store.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111" as AccountUuid;

describe("SecurityCliMutableTokenStore", () => {
	it("delete issues `security delete-generic-password` for the dedicated service + uuid", async () => {
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "", stderr: "" });
		const store = new SecurityCliMutableTokenStore(exec);
		await store.delete(UUID_A);
		expect(exec).toHaveBeenCalledWith("security", [
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
		]);
	});

	it("delete of an absent entry (exit 44) resolves without throwing (idempotent rollback)", async () => {
		// `security` exits 44 (errSecItemNotFound) when the item is missing.
		// Rollback runs after a prior failure, so a throw here would mask the
		// original error and leave the pipeline in a worse state than a no-op.
		const notFound = Object.assign(new Error("security: SecItemNotFound"), { code: 44 });
		const exec = vi.fn<ExecFileAsync>().mockRejectedValue(notFound);
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.delete(UUID_A)).resolves.toBeUndefined();
	});

	it("delete treats the CLI's 'could not be found' message as absent even without an exit code", async () => {
		// Fallback path: some `security` builds reject with the message but no
		// numeric `code`. The message match keeps those idempotent.
		const notFound = new Error(
			"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
		);
		const exec = vi.fn<ExecFileAsync>().mockRejectedValue(notFound);
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.delete(UUID_A)).resolves.toBeUndefined();
	});

	it("delete PROPAGATES a locked-keychain failure (fail-closed, not swallowed)", async () => {
		// A locked keychain is NOT item-not-found. Swallowing it would let
		// removeAccount drop the registry entry while the token survives. The
		// throw is what keeps removal fail-closed; delete it and this flips red.
		const locked = Object.assign(
			new Error("The user name or passphrase you entered is not correct."),
			{
				code: 51,
				stderr: "SecKeychain: user interaction is not allowed",
			},
		);
		const exec = vi.fn<ExecFileAsync>().mockRejectedValue(locked);
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.delete(UUID_A)).rejects.toThrow(/keychain delete failed/u);
	});

	it("get delegates to the base store's find-generic-password argv", async () => {
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({
			stdout: `${JSON.stringify({ accessToken: "handle-1" })}\n`,
			stderr: "",
		});
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.get(UUID_A)).resolves.toBe("handle-1");
		expect(exec).toHaveBeenCalledWith("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
			"-w",
		]);
	});

	it("put stores the access token as a one-field record via add-generic-password", async () => {
		// `put` is the access-token-only view over `putRecord`, exactly as in
		// FileTokenStore, so the secret is always a record — never sometimes a
		// bare string and sometimes JSON depending on which method was called.
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "", stderr: "" });
		const store = new SecurityCliMutableTokenStore(exec);
		await store.put(UUID_A, "handle-x");
		expect(exec).toHaveBeenCalledWith("security", [
			"add-generic-password",
			"-U",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
			"-w",
			JSON.stringify({ accessToken: "handle-x" }),
		]);
	});

	it("putRecord → getRecord round-trips the FULL record (refreshToken + expiresAt survive)", async () => {
		// The regression this pins: putRecord used to write only
		// `record.accessToken`, so refreshToken + expiresAt were dropped on the
		// floor. The access token expires in about an hour and refreshToken is the
		// only thing that can renew it, so an account provisioned through this
		// store became unusable with no recovery but a manual re-register. Feed
		// the secret that putRecord wrote back through getRecord: anything less
		// than byte-equality means credential material was lost in storage.
		const record = {
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresAt: "2026-07-25T12:00:00.000Z",
		};
		// The secret asserted on the write is the exact byte string replayed to the
		// read, so this is a real round-trip with no capture plumbing (and no
		// conditional in the mock).
		const secret = JSON.stringify(record);
		const writer = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "", stderr: "" });
		await new SecurityCliMutableTokenStore(writer).putRecord(UUID_A, record);
		expect(writer).toHaveBeenCalledWith("security", [
			"add-generic-password",
			"-U",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			UUID_A,
			"-w",
			secret,
		]);
		const reader = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: `${secret}\n`, stderr: "" });
		const store = new SecurityCliMutableTokenStore(reader);
		await expect(store.getRecord(UUID_A)).resolves.toStrictEqual(record);
		// And the access-token view still yields a bearer token, not the JSON.
		await expect(store.get(UUID_A)).resolves.toBe("at-1");
	});

	it("getRecord reads a LEGACY bare-string secret as an access-token-only record", async () => {
		// Items written before the record format hold the raw token. Decoding
		// must accept that forever — a strict JSON parse would make every
		// pre-upgrade account read as corrupt and break the install on update,
		// which is worse than the bug being fixed.
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "legacy-token\n", stderr: "" });
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.getRecord(UUID_A)).resolves.toStrictEqual({
			accessToken: "legacy-token",
		});
		await expect(store.get(UUID_A)).resolves.toBe("legacy-token");
	});

	it("list dumps the keychain (attributes only) and returns this service's account uuids", async () => {
		// `dump-keychain` WITHOUT `-d`: metadata only, no secret decrypt, no
		// prompt. The parse keeps only items under our dedicated service.
		const UUID_B = "22222222-2222-4222-8222-222222222222";
		const dump = [
			'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
			'    "acct"<blob>="Claude Key"',
			'    "svce"<blob>="Claude Safe Storage"',
			'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
			`    "acct"<blob>="${UUID_A}"`,
			'    "svce"<blob>="com.claude-multiacct.tokens"',
			'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
			`    "acct"<blob>="${UUID_B}"`,
			'    "svce"<blob>="com.claude-multiacct.tokens"',
			"",
		].join("\n");
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: dump, stderr: "" });
		const store = new SecurityCliMutableTokenStore(exec);
		const listed = await store.list();
		expect(exec).toHaveBeenCalledWith("security", ["dump-keychain"]);
		// Safe Storage is NOT returned; both of our items are.
		expect(listed).toEqual([UUID_A, UUID_B]);
	});
});
