/**
 * `@foundation/claude-multiacct` — one-time keychain → file token migration.
 *
 * The bridge daemon runs under launchd with `SessionCreate=true` so its boot
 * path never blocks on a keychain ACL prompt that has nowhere to render. The
 * cost of that isolation: the daemon cannot read, write, or delete
 * login-keychain items, so per-account OAuth tokens can no longer live in the
 * keychain (`SecurityCliTokenStore`, service `com.claude-multiacct.tokens`).
 * The canonical store is now `FileTokenStore` — an AES-256-GCM encrypted,
 * 0600 file tree under `~/.config/claude-multiacct/tokens/` that BOTH the
 * keychain-blind daemon and the GUI-session shim read and write directly.
 *
 * This migration moves any token still in the legacy keychain into the file
 * store, so accounts registered under the old layout keep working after the
 * switch. It runs from a keychain-CAPABLE context (the `cma` CLI / `cma
 * install`, invoked interactively in the user's GUI session), never from the
 * daemon. It is:
 *
 *   - Idempotent — an account already present in the file store is skipped,
 *     never overwritten (a fresher file token always wins over a stale
 *     keychain copy).
 *   - Best-effort — a keychain read that misses or is refused is a skip, not a
 *     failure; only a file-store WRITE failure is counted as `failed`. The
 *     function never throws, so it can be wired into `cma install` without
 *     risking the whole install on an uncooperative keychain.
 *   - Confidential — token material is never logged. Log lines carry only the
 *     account uuid and the outcome.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { MutableTokenStore } from "./token-store-mut.ts";

/** Minimal log sink — token material is never passed to it. */
export type MigrationLogger = { log: (m: string) => void; warn: (m: string) => void };

/** Tally of what the migration did. */
export type MigrationResult = {
	/** Tokens copied keychain → file this run. */
	migrated: number;
	/** Accounts skipped (already in file store, or no legacy keychain token). */
	skipped: number;
	/** Accounts whose file-store write failed (surfaced, never silently dropped). */
	failed: number;
};

/** Injected surfaces the migration operates over. */
export type MigrationPorts = {
	/** Account uuids to consider — the pool's uuids, read from the registry. */
	uuids: readonly AccountUuid[];
	/**
	 * Read one account's token from the LEGACY keychain store. Must resolve to
	 * `undefined` (never throw) on a miss or a refused/timed-out read, so a
	 * keychain that cannot be reached is a skip rather than a hard failure.
	 */
	readKeychainToken: (uuid: AccountUuid) => Promise<string | undefined>;
	/** The canonical file store the daemon + shim now share. */
	fileStore: MutableTokenStore;
	logger: MigrationLogger;
};

/**
 * Migrate legacy keychain tokens into the file store. See the module docstring
 * for the idempotency / best-effort / confidentiality contract.
 *
 * @param {MigrationPorts} ports - Injected uuids + keychain reader + file store + logger.
 * @returns {Promise<MigrationResult>} Tally of migrated / skipped / failed accounts.
 */
export async function migrateKeychainTokensToFile(ports: MigrationPorts): Promise<MigrationResult> {
	const result = { migrated: 0, skipped: 0, failed: 0 };
	for (const uuid of ports.uuids) {
		// eslint-disable-next-line no-await-in-loop -- small fixed set (pool size); sequential keeps keychain reads from stampeding
		await migrateOne(uuid, ports, result);
	}
	return result;
}

/**
 * Migrate a single account: skip if already in the file store or if it has no
 * legacy keychain token; otherwise copy it in. Mutates `tally` in place. Never
 * throws — a file-store write failure is tallied + logged.
 *
 * @param {AccountUuid} uuid - The account to migrate.
 * @param {MigrationPorts} ports - Injected keychain reader + file store + logger.
 * @param {MigrationResult} tally - Running counters, mutated in place.
 * @returns {Promise<void>} Resolves once the account is handled.
 */
async function migrateOne(
	uuid: AccountUuid,
	ports: MigrationPorts,
	tally: MigrationResult,
): Promise<void> {
	// A present file token is authoritative — never clobber it with a stale
	// keychain copy. `get` may throw (FileTokenStore miss) or resolve
	// `undefined`; both mean "not in the file store yet".
	const existing = await ports.fileStore.get(uuid).catch(readMiss);
	if (existing !== undefined) {
		tally.skipped += 1;
		return;
	}
	const token = await ports.readKeychainToken(uuid).catch(readMiss);
	if (token === undefined) {
		// No legacy token to move (account added under the file store already, or
		// the keychain read was refused). Nothing to do — skip.
		tally.skipped += 1;
		return;
	}
	try {
		await ports.fileStore.put(uuid, token);
		tally.migrated += 1;
		ports.logger.log(`migrate-tokens: moved keychain token for ${uuid} → file store`);
	} catch (error) {
		tally.failed += 1;
		ports.logger.warn(
			`migrate-tokens: file-store write FAILED for ${uuid}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Coerce a rejected/absent token read to `undefined`. Single sanctioned site
 * for the "treat a failed read as absent" coercion so the loop stays branch-
 * clean.
 *
 * @returns {undefined} Always `undefined`.
 */
function readMiss(): undefined {
	// eslint-disable-next-line unicorn/no-useless-undefined -- explicit for the callers' `=== undefined` branch
	return undefined;
}
