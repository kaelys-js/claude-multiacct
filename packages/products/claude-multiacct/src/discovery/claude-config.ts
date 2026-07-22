/**
 * `@foundation/claude-multiacct` — read Claude.app's plaintext config markers.
 *
 * Claude.app writes `lastKnownAccountUuid` to `config.json` in CLEARTEXT (not a
 * v10 blob): it is the real account uuid of the account the app is currently
 * signed into. Reading it needs no keychain and no decryption, so even the
 * keychain-blind (`SessionCreate=true`) daemon can resolve the active account
 * from it — which is why active resolution now prefers this marker over the old
 * decrypt-the-legacy-cache path.
 *
 * The read is fail-closed: a missing file, unparseable JSON, or an absent /
 * non-string marker resolves to `undefined` so the caller falls back rather than
 * acting on a torn value. `fs` is injected for tests.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** JSON key Claude.app writes the current account's real uuid under. */
export const LAST_KNOWN_ACCOUNT_UUID_KEY = "lastKnownAccountUuid";

/**
 * Absolute path to Claude.app's `config.json`. Matches the location
 * `discovery/discover-accounts.ts` scans for the OAuth caches.
 *
 * @returns {string} `~/Library/Application Support/Claude/config.json`.
 */
export function defaultClaudeConfigJsonPath(): string {
	return join(homedir(), "Library", "Application Support", "Claude", "config.json");
}

/** Minimal read surface — test-injectable. */
export type ReadConfigFs = {
	readFile: (path: string) => Promise<string>;
};

/** Default read surface: real `node:fs/promises` in UTF-8. */
const nodeReadConfigFs: ReadConfigFs = { readFile: (p) => readFile(p, "utf8") };

/**
 * Read `lastKnownAccountUuid` from Claude.app's config.json, or `undefined` when
 * it cannot be trusted (missing file, non-JSON, non-object, absent/blank/
 * non-string marker). Never throws.
 *
 * @param {string} path - Absolute path to config.json.
 * @param {ReadConfigFs} [fs] - Injected read surface; defaults to `node:fs/promises`.
 * @returns {Promise<string | undefined>} The plaintext account uuid marker, or `undefined`.
 */
export async function readLastKnownAccountUuid(
	path: string,
	fs: ReadConfigFs = nodeReadConfigFs,
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
	const marker = (parsed as Record<string, unknown>)[LAST_KNOWN_ACCOUNT_UUID_KEY];
	return typeof marker === "string" && marker.length > 0 ? marker : undefined;
}
