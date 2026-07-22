/**
 * `@foundation/claude-multiacct` — the active-token companion → daemon IPC file.
 *
 * The companion (gui session, keychain-capable) resolves which pooled account
 * Claude.app is logged in as and writes the answer here; the bridge daemon
 * (`SessionCreate=true`, keychain-blind) reads it to fill `/accounts`'s
 * `activeUuid`. A plain JSON file is the whole channel — the daemon already
 * reads sidecar files (`bridge.json`, the registry), so this matches the
 * existing IPC shape rather than standing up a socket.
 *
 * The write goes through `atomicWriteJson` (tmp + rename) at mode `0o600`, so a
 * reader ever only sees the previous or the complete new record, never a torn
 * one, and the file is owner-only.
 *
 * Fail-closed reads are the contract: any missing file, unparseable JSON, or
 * absent/blank `activeUuid` resolves to `undefined`, which lets the daemon fall
 * back to its first-account default rather than surfacing a stale or malformed
 * guess.
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, type AtomicWriteFs } from "../http-bridge/atomic-json.ts";

/** Basename of the IPC file inside `~/.claude-multiacct/`. */
export const ACTIVE_ACCOUNT_FILENAME = "active-account.json";

/**
 * Absolute path to the IPC file. Both the companion boot glue and the daemon
 * boot glue resolve through this so the writer and reader can never disagree.
 *
 * @returns {string} `~/.claude-multiacct/active-account.json`.
 */
export function defaultActiveAccountPath(): string {
	return join(homedir(), ".claude-multiacct", ACTIVE_ACCOUNT_FILENAME);
}

/**
 * The record the companion writes. `activeUuid` is `null` (not a fallback uuid)
 * whenever the companion could not positively match Claude.app's live token to
 * a pooled account — the daemon owns the fallback decision, so the file only
 * ever asserts a confident match. `activeTokenSha` is carried for observability
 * (proof/debugging); the daemon does not need it.
 */
export type ActiveAccountRecord = {
	activeUuid: string | null;
	activeTokenSha: string | null;
	computedAt: string;
};

/**
 * Atomically publish the companion's resolution to `path`.
 *
 * @param {string} path - Absolute destination (see `defaultActiveAccountPath`).
 * @param {ActiveAccountRecord} record - The resolution to publish.
 * @param {AtomicWriteFs} [deps] - Injected fs surface; defaults to `node:fs/promises`.
 * @returns {Promise<void>} Resolves once the rename has landed.
 */
export async function writeActiveAccount(
	path: string,
	record: ActiveAccountRecord,
	deps?: AtomicWriteFs,
): Promise<void> {
	await atomicWriteJson(path, record, 0o600, deps);
}

/** Minimal read surface the daemon needs. Test-injectable. */
export type ReadActiveAccountFs = {
	readFile: (path: string) => Promise<string>;
};

/**
 * Read the companion's published `activeUuid`, or `undefined` when it cannot be
 * trusted. Fail-closed on every failure mode (see module docstring): missing
 * file, non-JSON, non-object, or an `activeUuid` that is not a non-empty string
 * (covers the deliberate `null` the companion writes for "no confident match").
 *
 * @param {string} path - Absolute path to the IPC file.
 * @param {ReadActiveAccountFs} fs - Injected read surface.
 * @returns {Promise<string | undefined>} The active account uuid, or `undefined`.
 */
export async function readActiveUuid(
	path: string,
	fs: ReadActiveAccountFs,
): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(path);
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const uuid = (parsed as { activeUuid?: unknown }).activeUuid;
	return typeof uuid === "string" && uuid.length > 0 ? uuid : undefined;
}
