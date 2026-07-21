/**
 * Intent: `SecurityCliMutableTokenStore` is what `provisionAccount` uses for
 * atomic rollback — if the registry write fails after the token write landed,
 * the pipeline calls `delete` to avoid an orphan keychain credential. So the
 * two things that matter here are: (1) `delete` issues the EXACT
 * `security delete-generic-password` argv against the dedicated service, and
 * (2) a delete of an already-absent entry is a silent no-op, because rollback
 * runs on error paths where the credential may or may not exist and must never
 * throw a second failure on top of the first.
 *
 * get/put are thin delegations to the base `SecurityCliTokenStore`; we assert
 * they reach the injected exec with the base adapter's argv so a refactor that
 * drops the delegation is caught.
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

	it("delete of an absent entry resolves without throwing (idempotent rollback)", async () => {
		// `security` exits non-zero when the item is missing. Rollback runs after a
		// prior failure, so a throw here would mask the original error and leave the
		// pipeline in a worse state than a plain no-op.
		const exec = vi
			.fn<ExecFileAsync>()
			.mockRejectedValue(new Error("SecKeychainSearchCopyNext: not found"));
		const store = new SecurityCliMutableTokenStore(exec);
		await expect(store.delete(UUID_A)).resolves.toBeUndefined();
	});

	it("get delegates to the base store's find-generic-password argv", async () => {
		const exec = vi.fn<ExecFileAsync>().mockResolvedValue({ stdout: "handle-1\n", stderr: "" });
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

	it("put delegates to the base store's add-generic-password argv", async () => {
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
			"handle-x",
		]);
	});
});
