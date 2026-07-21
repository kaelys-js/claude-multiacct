/**
 * `@foundation/claude-multiacct` — auto-detect signed-in accounts.
 *
 * Scans three source classes on macOS and registers every unique OAuth
 * token it finds:
 *
 *   1. **Main `/Applications/Claude.app`** — `~/Library/Application
 *      Support/Claude/Local Storage/leveldb/` + `IndexedDB/`. Values
 *      encrypted per Chromium's `v10` scheme using the `Claude Safe
 *      Storage` keychain key.
 *   2. **Clone apps** (`~/Applications/Claude Account *.app`) — each
 *      has its own `~/Library/Application Support/Claude-<label>/`
 *      store, decrypted with the same keychain key.
 *   3. **`claude` CLI keychain slots** — `Claude Code-credentials-*`
 *      generic-password entries. Each holds a raw OAuth JSON (`{access
 *      _token, refresh_token, ...}`) — no Chromium wrapping.
 *
 * Every unique token (dedup by SHA-256 of the raw bytes) becomes one
 * pool account:
 *   - Local uuid via `crypto.randomUUID()` (Anthropic never sees it).
 *   - Label from JSON `email` field where present, else `account-N`.
 *   - Registered via the caller-supplied `provisionOne` port so the
 *     write path (token store + registry writer + primary invariant)
 *     stays in oauth/provisioning.ts.
 *
 * Idempotent: existing registry entries are recovered by fetching each
 * account's token via the token store and hashing it; matches are
 * skipped without re-verification.
 *
 * Every filesystem, process, and keychain call is injected via `ports`
 * so tests never touch the real machine.
 *
 * @module
 */

import { createHash } from "node:crypto";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { TokenStore } from "../ports.ts";
import {
	decryptV10,
	deriveChromiumKey,
	extractOauthFromPlaintext,
	isEncrypted,
} from "./chromium-crypto.ts";

/** Injected side-effect surface — everything the discovery needs. */
export type DiscoveryPorts = {
	/**
	 * Read the `<AppName> Safe Storage` keychain password for the given
	 * account name (e.g. `Claude Key`). Returns undefined when the entry
	 * is missing OR the read is refused. Never throws.
	 */
	readKeychainPassword: (service: string, account: string) => Promise<string | undefined>;
	/**
	 * List `Claude Code-credentials-*` keychain services present in the
	 * user's login keychain. Each returned service name goes back through
	 * `readKeychainPassword(service, undefined)` (`-a` optional for these
	 * entries — pass empty string) to get the raw password bytes.
	 */
	listClaudeCliServices: () => Promise<string[]>;
	/** Read a `Claude Code-credentials-*` slot's raw value. */
	readClaudeCliCredential: (service: string) => Promise<string | undefined>;
	/**
	 * Enumerate the LevelDB entries under a Chromium data dir. Each entry
	 * is a raw value the caller decides how to interpret.
	 *
	 * Path is absolute, e.g. `~/Library/Application Support/Claude/Local
	 * Storage/leveldb/`. Missing dir → empty iterator.
	 */
	iterateLevelDb: (dir: string) => AsyncIterable<{ key: Buffer; value: Buffer }>;
	/**
	 * List `~/Applications/Claude Account *.app` clone bundles. Returns
	 * one entry per clone with its bundle path + label (derived from
	 * bundle name, e.g. `gmail` for `Claude Account Gmail.app`).
	 */
	listCloneApps: () => Promise<Array<{ bundlePath: string; label: string; storeDir: string }>>;
	/**
	 * Register one discovered account. Called once per unique token.
	 * Returns the assigned account uuid on success, or a classified
	 * failure. The caller (discoverAccounts) does NOT invoke this for
	 * already-registered tokens.
	 */
	provisionOne: (input: {
		token: string;
		label: string;
	}) => Promise<{ ok: true; uuid: AccountUuid } | { ok: false; kind: string; detail: string }>;
	/** Read the current registry (used for idempotency). */
	readRegistry: () => Promise<AccountRegistry | undefined>;
	/** Token store — used to hash existing accounts' tokens for dedup. */
	tokenStore: TokenStore;
	/** Log sink for warnings / progress. */
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

export type DiscoveryOutcome = {
	scanned: {
		mainApp: number;
		cloneApps: number;
		cliCredentials: number;
	};
	registered: Array<{ uuid: AccountUuid; label: string }>;
	skippedAlreadyRegistered: number;
	failed: Array<{ source: string; kind: string; detail: string }>;
};

/**
 * Auto-detect + register every OAuth token found on the machine.
 *
 * @param {DiscoveryPorts} ports - Injected side-effects.
 * @returns {Promise<DiscoveryOutcome>} Summary of scan + registration outcomes.
 */
export async function discoverAccounts(ports: DiscoveryPorts): Promise<DiscoveryOutcome> {
	const outcome: DiscoveryOutcome = {
		scanned: { mainApp: 0, cloneApps: 0, cliCredentials: 0 },
		registered: [],
		skippedAlreadyRegistered: 0,
		failed: [],
	};

	// Materialize the existing registry's tokens once so dedup is O(1).
	const knownTokenHashes = await hashExistingRegistry(ports);

	// Track tokens seen this run so we don't double-register when the
	// same account appears under both `Claude Code-credentials-<hash>`
	// AND the Local Storage LevelDB.
	const seenThisRun = new Set<string>();

	async function tryRegister(
		source: string,
		token: string,
		email: string | undefined,
	): Promise<void> {
		const hash = sha256Hex(token);
		if (knownTokenHashes.has(hash)) {
			outcome.skippedAlreadyRegistered += 1;
			return;
		}
		if (seenThisRun.has(hash)) {
			outcome.skippedAlreadyRegistered += 1;
			return;
		}
		seenThisRun.add(hash);
		const label = deriveLabel(email, source, outcome.registered.length + 1);
		const result = await ports.provisionOne({ token, label });
		if (result.ok) {
			outcome.registered.push({ uuid: result.uuid, label });
			ports.logger.log(`discovery: registered ${label} (${result.uuid}) from ${source}`);
		} else {
			outcome.failed.push({ source, kind: result.kind, detail: result.detail });
			ports.logger.warn(
				`discovery: registration failed for ${label} from ${source}: ${result.kind}: ${result.detail}`,
			);
		}
	}

	// Source 1: main Claude.app
	const mainPassword = await ports.readKeychainPassword("Claude Safe Storage", "Claude Key");
	// eslint-disable-next-line no-negated-condition, unicorn/no-negated-condition -- Positive branch (do the scan) is the primary path; the else is the exceptional early-return message. Inverting reads worse.
	if (mainPassword === undefined) {
		ports.logger.warn(
			"discovery: no `Claude Safe Storage` key in keychain; skipping main Claude.app scan",
		);
	} else {
		const key = deriveChromiumKey(mainPassword);
		const mainStore = mainAppStoreDir();
		for (const dir of chromiumStoreSubdirs(mainStore)) {
			// eslint-disable-next-line no-await-in-loop -- sequential per dir; iterateLevelDb is streaming already
			for await (const entry of ports.iterateLevelDb(dir)) {
				outcome.scanned.mainApp += 1;
				const found = tryDecryptAndExtract(entry.value, key);
				if (found !== undefined) {
					// eslint-disable-next-line no-await-in-loop -- registration is serial by design
					await tryRegister(`main:${dir}`, found.token, found.email);
				}
			}
		}
	}

	// Source 2: clone apps
	const clones = await ports.listCloneApps();
	for (const clone of clones) {
		// Clones share the same `Claude Safe Storage` key (Electron reuses
		// the parent product's keychain service name).
		if (mainPassword === undefined) {
			break;
		}
		const key = deriveChromiumKey(mainPassword);
		for (const dir of chromiumStoreSubdirs(clone.storeDir)) {
			// eslint-disable-next-line no-await-in-loop -- sequential
			for await (const entry of ports.iterateLevelDb(dir)) {
				outcome.scanned.cloneApps += 1;
				const found = tryDecryptAndExtract(entry.value, key);
				if (found !== undefined) {
					// eslint-disable-next-line no-await-in-loop -- serial
					await tryRegister(`clone:${clone.label}:${dir}`, found.token, found.email);
				}
			}
		}
	}

	// Source 3: `claude` CLI keychain slots
	const cliServices = await ports.listClaudeCliServices();
	for (const service of cliServices) {
		// eslint-disable-next-line no-await-in-loop -- per-slot, serial
		const raw = await ports.readClaudeCliCredential(service);
		if (raw !== undefined) {
			outcome.scanned.cliCredentials += 1;
			const parsed = extractOauthFromPlaintext(Buffer.from(raw, "utf8"));
			if (parsed !== undefined) {
				// eslint-disable-next-line no-await-in-loop -- serial
				await tryRegister(`cli:${service}`, parsed.token, parsed.email);
			}
		}
	}

	return outcome;
}

/**
 * Best-effort decrypt + extract in one call. Returns undefined if the
 * value isn't a `v10`-prefixed encrypted blob, or decrypts but isn't a
 * token-bearing JSON.
 *
 * @param {Buffer} value - LevelDB value bytes.
 * @param {Buffer} key - 16-byte AES-128 key.
 * @returns {{token: string; email: string | undefined} | undefined} Extracted OAuth data or `undefined` when the value isn't v10-prefixed or the decrypted content isn't token-bearing JSON.
 */
function tryDecryptAndExtract(
	value: Buffer,
	key: Buffer,
): { token: string; email: string | undefined } | undefined {
	if (!isEncrypted(value)) {
		return undefined;
	}
	let plaintext: Buffer;
	try {
		plaintext = decryptV10(value, key);
	} catch {
		return undefined;
	}
	return extractOauthFromPlaintext(plaintext);
}

/**
 * Hash every existing-registry account's token bytes for dedup.
 *
 * @param {DiscoveryPorts} ports - Injected ports.
 * @returns {Promise<Set<string>>} Set of hex-encoded SHA-256 digests.
 */
async function hashExistingRegistry(ports: DiscoveryPorts): Promise<Set<string>> {
	const hashes = new Set<string>();
	const registry = await ports.readRegistry();
	if (registry === undefined) {
		return hashes;
	}
	for (const account of registry.accounts) {
		try {
			// eslint-disable-next-line no-await-in-loop -- serial dedup init
			const token = await ports.tokenStore.get(account.uuid);
			if (typeof token === "string") {
				hashes.add(sha256Hex(token));
			}
		} catch {
			// Missing/unreadable entry — treat as unknown; if the token
			// re-appears in a scan we'll register a fresh account. Not
			// ideal but the alternative (silently corrupt registry) is worse.
		}
	}
	return hashes;
}

/**
 * SHA-256 hash of a UTF-8 string, hex-encoded.
 *
 * @param {string} input - Input.
 * @returns {string} 64-char hex digest.
 */
function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function mainAppStoreDir(): string {
	return `${process.env["HOME"] ?? ""}/Library/Application Support/Claude`;
}

/**
 * Return the Chromium Local Storage + IndexedDB dirs under a parent
 * data dir.
 *
 * @param {string} appStoreDir - `~/Library/Application Support/<App>/`.
 * @returns {string[]} Absolute paths that iterateLevelDb should scan.
 */
export function chromiumStoreSubdirs(appStoreDir: string): string[] {
	return [`${appStoreDir}/Local Storage/leveldb`, `${appStoreDir}/IndexedDB`];
}

/**
 * Derive a human-friendly label from an email + source hint.
 *
 * @param {string | undefined} email - Extracted email, if any.
 * @param {string} source - Discovery source (unused if email is set).
 * @param {number} n - 1-based ordinal for fallback labels.
 * @returns {string} Label.
 */
export function deriveLabel(email: string | undefined, source: string, n: number): string {
	if (email !== undefined) {
		if (email.endsWith("@icloud.com") || email.endsWith("@me.com") || email.endsWith("@mac.com")) {
			return "icloud";
		}
		if (email.endsWith("@gmail.com") || email.endsWith("@googlemail.com")) {
			return "gmail";
		}
		// domain-based label: `me@work.co.uk` → `work`.
		const at = email.indexOf("@");
		if (at >= 0) {
			const domain = email.slice(at + 1);
			const [first] = domain.split(".");
			if (first !== undefined && first.length > 0) {
				return first;
			}
		}
	}
	// Fall back to source-derived label.
	if (source.startsWith("clone:")) {
		const parts = source.split(":");
		return parts[1] ?? `account-${String(n)}`;
	}
	if (source.startsWith("cli:")) {
		return `cli-${String(n)}`;
	}
	return `account-${String(n)}`;
}
