/**
 * `@foundation/claude-multiacct` — orphan keychain-token prune.
 *
 * A token item under this tool's dedicated keychain service
 * (`com.claude-multiacct.tokens`) is an ORPHAN when no registry account
 * references its account uuid. Orphans accumulate when an account leaves the
 * registry without its token being dropped — e.g. the pre-D1 auto-import that
 * wrote several bogus token items that were later never registered. They are
 * dead weight and a small exposure surface, so a maintenance sweep deletes
 * them.
 *
 * Two safety properties are load-bearing:
 *
 *   1. **Target-only by construction.** The listing comes from
 *      {@link import("./token-store.ts").parseKeychainServiceAccounts}, which
 *      only ever returns items whose keychain service is exactly ours, so
 *      Anthropic's own `Claude Safe Storage` key is never even a candidate.
 *      Deletion goes through the same `MutableTokenStore.delete` used by
 *      `removeAccount`, which is scoped to `-s com.claude-multiacct.tokens`.
 *   2. **Fail-closed on an unreadable registry.** If the registry can't be
 *      read we cannot know what is referenced, so we delete NOTHING rather than
 *      treat every item as an orphan. An empty-but-present registry is a valid
 *      input (every item is genuinely an orphan); a MISSING registry is not.
 *
 * @module
 */

import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { ReadRegistryFn } from "../oauth/provisioning.ts";

/**
 * Coerce a throwable into a printable string. Single branch for coverage.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {string} `error.message` for `Error`, `String(error)` otherwise.
 */
function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The keychain surface the prune needs: enumerate this service's token items
 * and delete one by account uuid. Satisfied by `SecurityCliMutableTokenStore`.
 */
export type ListableTokenStore = {
	list(): Promise<AccountUuid[]>;
	delete(accountUuid: AccountUuid): Promise<void>;
};

/** Structured result of a prune run — counts + the exact ids acted on. */
export type OrphanPruneResult = {
	/** Every token account uuid found under this tool's service. */
	listed: AccountUuid[];
	/** The registry-referenced uuids (empty when the registry was unreadable). */
	referenced: AccountUuid[];
	/** Listed items with no registry entry — the deletion candidates. */
	orphans: AccountUuid[];
	/** Orphans successfully deleted. */
	deleted: AccountUuid[];
	/** Orphans whose delete threw, with the failure detail. */
	failures: Array<{ accountUuid: AccountUuid; detail: string }>;
	/** True when the registry was unreadable and the run deleted nothing. */
	abortedRegistryUnreadable: boolean;
};

/**
 * Pure selector: the listed token accounts that no registry entry references.
 *
 * @param {AccountUuid[]} listed - Token account uuids under our service.
 * @param {AccountRegistry} registry - The validated registry.
 * @returns {AccountUuid[]} Listed uuids absent from the registry.
 */
export function selectOrphanTokens(
	listed: readonly AccountUuid[],
	registry: AccountRegistry,
): AccountUuid[] {
	const referenced = new Set<string>(registry.accounts.map((a) => a.uuid));
	return listed.filter((uuid) => !referenced.has(uuid));
}

/** Optional log sink; both methods default to no-ops. */
export type PruneLogger = { log?: (m: string) => void; warn?: (m: string) => void };

/**
 * Delete every orphaned token item under this tool's keychain service.
 *
 * Reads the current registry, computes the orphan set, and deletes each orphan
 * (best-effort per item — one failing delete does not abort the rest). Deletes
 * NOTHING when the registry is unreadable (fail-closed). Never touches an item
 * outside our dedicated service (see the module doc).
 *
 * @param {object} args - `{ readRegistry, tokenStore, logger? }`.
 * @returns {Promise<OrphanPruneResult>} Counts + ids acted on.
 */
export async function pruneOrphanTokens(args: {
	readRegistry: ReadRegistryFn;
	tokenStore: ListableTokenStore;
	logger?: PruneLogger;
}): Promise<OrphanPruneResult> {
	const listed = await args.tokenStore.list();
	const registry = await args.readRegistry();
	if (registry === undefined) {
		args.logger?.warn?.(
			"token prune: registry unreadable — deleting nothing (fail-closed). Fix the registry, then re-run.",
		);
		return {
			listed,
			referenced: [],
			orphans: [],
			deleted: [],
			failures: [],
			abortedRegistryUnreadable: true,
		};
	}
	const referenced = registry.accounts.map((a) => a.uuid);
	const orphans = selectOrphanTokens(listed, registry);

	// Distinct keychain items → delete in parallel; each result is tagged so one
	// failure never masks another and the outcome lists are deterministic.
	const outcomes = await Promise.all(
		orphans.map(
			async (
				uuid,
			): Promise<
				{ uuid: AccountUuid; ok: true } | { uuid: AccountUuid; ok: false; detail: string }
			> => {
				try {
					await args.tokenStore.delete(uuid);
					return { uuid, ok: true };
				} catch (error) {
					return { uuid, ok: false, detail: errMsg(error) };
				}
			},
		),
	);
	const deleted: AccountUuid[] = [];
	const failures: Array<{ accountUuid: AccountUuid; detail: string }> = [];
	for (const outcome of outcomes) {
		if (outcome.ok) {
			deleted.push(outcome.uuid);
		} else {
			failures.push({ accountUuid: outcome.uuid, detail: outcome.detail });
		}
	}
	args.logger?.log?.(
		`token prune: listed=${String(listed.length)} referenced=${String(referenced.length)} orphans=${String(orphans.length)} deleted=${String(deleted.length)} failures=${String(failures.length)}`,
	);
	return { listed, referenced, orphans, deleted, failures, abortedRegistryUnreadable: false };
}
