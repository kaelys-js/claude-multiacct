/**
 * Intent: pin the keychain → file token migration contract that keeps
 * accounts registered under the old keychain layout working after the daemon
 * switched to the keychain-blind file store.
 *
 * WHY each behaviour matters:
 *   - A legacy keychain token MUST land in the file store, or the shim (which
 *     now reads the file store) can no longer inject that account's token and
 *     silently falls back to the primary account — a correctness regression.
 *   - An account already in the file store MUST be left untouched: a fresh
 *     token written post-switch must never be clobbered by a stale keychain
 *     copy (the file store is authoritative once populated).
 *   - A refused / missing keychain read MUST be a skip, not a failure, so the
 *     migration can run under `cma install` without a locked keychain aborting
 *     the whole install.
 *   - A file-store WRITE failure MUST be surfaced (counted + logged), never
 *     silently dropped (Rule 12).
 *   - Token material MUST NEVER reach the log sink (confidentiality — SR8 /
 *     the store's whole reason to encrypt at rest).
 */

import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import { InMemoryMutableTokenStore, type MutableTokenStore } from "./token-store-mut.ts";
import { migrateKeychainTokensToFile } from "./keychain-file-migration.ts";

const UUID_A = "aaaaaaaa-1111-4111-8111-111111111111" as AccountUuid;
const UUID_B = "bbbbbbbb-2222-4222-8222-222222222222" as AccountUuid;
const SECRET_TOKEN = "sk-ant-oat01-SUPER-SECRET-VALUE";

function noopLogger(): {
	log: ReturnType<typeof vi.fn<(m: string) => void>>;
	warn: ReturnType<typeof vi.fn<(m: string) => void>>;
} {
	return { log: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>() };
}

describe("migrateKeychainTokensToFile", () => {
	it("moves a legacy keychain token into the file store when it is not there yet", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		const logger = noopLogger();
		const keychain: Record<string, string> = { [UUID_A]: SECRET_TOKEN };
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: (uuid) => Promise.resolve(keychain[uuid]),
			fileStore,
			logger,
		});
		expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
		expect(await fileStore.get(UUID_A)).toBe(SECRET_TOKEN);
	});

	it("skips (never overwrites) an account already present in the file store", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		await fileStore.put(UUID_A, "file-store-fresh-token");
		const readKeychainToken = vi.fn<(uuid: AccountUuid) => Promise<string | undefined>>(() =>
			Promise.resolve(SECRET_TOKEN),
		);
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken,
			fileStore,
			logger: noopLogger(),
		});
		expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
		// The authoritative file token is untouched and the keychain was never read.
		expect(await fileStore.get(UUID_A)).toBe("file-store-fresh-token");
		expect(readKeychainToken).not.toHaveBeenCalled();
	});

	it("treats a missing keychain token as a skip, not a failure", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: () => Promise.resolve(undefined),
			fileStore,
			logger: noopLogger(),
		});
		expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
		expect(await fileStore.get(UUID_A)).toBeUndefined();
	});

	it("treats a refused keychain read (rejection) as a skip, never throwing", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: () => Promise.reject(new Error("keychain refused")),
			fileStore,
			logger: noopLogger(),
		});
		expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
	});

	it("counts a file-store write failure as failed and warns (fail loud)", async () => {
		const failingStore: MutableTokenStore = {
			get: () => Promise.resolve(undefined),
			put: () => Promise.reject(new Error("disk full")),
			getRecord: () => Promise.resolve(undefined),
			putRecord: () => Promise.reject(new Error("disk full")),
			delete: () => Promise.resolve(),
		};
		const logger = noopLogger();
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: () => Promise.resolve(SECRET_TOKEN),
			fileStore: failingStore,
			logger,
		});
		expect(result).toEqual({ migrated: 0, skipped: 0, failed: 1 });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("stringifies a non-Error write rejection in the warning (fail loud, no throw)", async () => {
		const failingStore: MutableTokenStore = {
			get: () => Promise.resolve(undefined),
			// eslint-disable-next-line prefer-promise-reject-errors -- deliberately a non-Error to exercise the String(error) branch
			put: () => Promise.reject("bare-string-fault"),
			getRecord: () => Promise.resolve(undefined),
			// eslint-disable-next-line prefer-promise-reject-errors -- mirror of put, unused here
			putRecord: () => Promise.reject("bare-string-fault"),
			delete: () => Promise.resolve(),
		};
		const logger = noopLogger();
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: () => Promise.resolve(SECRET_TOKEN),
			fileStore: failingStore,
			logger,
		});
		expect(result).toEqual({ migrated: 0, skipped: 0, failed: 1 });
		expect(logger.warn.mock.calls[0]?.[0]).toContain("bare-string-fault");
	});

	it("never writes token material to the log sink", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		const logger = noopLogger();
		await migrateKeychainTokensToFile({
			uuids: [UUID_A],
			readKeychainToken: () => Promise.resolve(SECRET_TOKEN),
			fileStore,
			logger,
		});
		const allLogged = [...logger.log.mock.calls, ...logger.warn.mock.calls].flat().join(" ");
		expect(allLogged).not.toContain(SECRET_TOKEN);
	});

	it("handles a mixed pool: one migrated, one already present, one missing", async () => {
		const fileStore = new InMemoryMutableTokenStore();
		await fileStore.put(UUID_B, "already-here");
		const UUID_C = "cccccccc-3333-4333-8333-333333333333" as AccountUuid;
		const keychain: Record<string, string> = { [UUID_A]: SECRET_TOKEN };
		const result = await migrateKeychainTokensToFile({
			uuids: [UUID_A, UUID_B, UUID_C],
			readKeychainToken: (uuid) => Promise.resolve(keychain[uuid]),
			fileStore,
			logger: noopLogger(),
		});
		expect(result).toEqual({ migrated: 1, skipped: 2, failed: 0 });
		expect(await fileStore.get(UUID_A)).toBe(SECRET_TOKEN);
		expect(await fileStore.get(UUID_B)).toBe("already-here");
	});
});
