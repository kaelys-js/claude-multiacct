/**
 * `@foundation/claude-multiacct` — real-fs / real-keychain / real-LevelDB
 * bindings for `DiscoveryPorts`.
 *
 * The discovery module itself (`./discover-accounts.ts`) takes every
 * side-effect via an injected port bundle so tests never touch the real
 * machine. This file provides the runtime bindings the daemon uses at boot.
 *
 * Bindings:
 *   - `readKeychainPassword(service, account)` → `security find-generic-
 *     password -w -s <s> -a <a>`.
 *   - `listClaudeCliServices()` → probe a bounded set of candidate
 *     `Claude Code-credentials-<suffix>` service names with `security
 *     find-generic-password`, returning only the ones that resolve.
 *     Candidates come from labels already in `~/.config/claude-multiacct/
 *     registry.json`, from the unsuffixed canonical `Claude Code-credentials`
 *     service the stock CLI writes to, and from any label list a user has
 *     dropped into `~/.claude/.credentials.json` or `~/.claude/settings.json`
 *     (an `accounts` or `credentials` array of strings). We do NOT call
 *     `security dump-keychain` — under launchd it triggers a per-item ACL
 *     prompt that never returns, hanging the daemon at boot.
 *   - `readClaudeCliCredential(service)` → `security find-generic-password
 *     -w -s <service>`.
 *   - `iterateLevelDb(dir)` → best-effort scan via a small hand-rolled
 *     LevelDB reader that walks the log/ + ldb/ files in the store dir.
 *     Missing dir → empty iterator (silent). Read errors → warn + continue.
 *   - `listCloneApps()` → glob `~/Applications/Claude Account *.app`;
 *     derive label from bundle name; map to `~/Library/Application
 *     Support/Claude-<label>/`.
 *   - `provisionOne({token, label})` → wraps `provisionAccount` from
 *     `../oauth/provisioning.ts` with a synthetic verify (runtime doesn't
 *     have a stable identity-probe subcommand of the real Claude CLI — see
 *     `verify.ts` docstring).
 *
 * Adds no new npm dependency: LevelDB is walked with `node:fs` + a small
 * SST-block reader that handles Chromium's Local Storage layout (block-
 * compressed by default is opt-in — Local Storage / IndexedDB don't
 * enable it, so plain-format reads succeed).
 *
 * @module
 */

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AtomicRegistryWriter, nodeRegistryFsPort } from "../registry/registry-writer.ts";
import { defaultRegistryPath } from "../cli-shim/registry-store.ts";
import { provisionAccount } from "../oauth/provisioning.ts";
import type { VerifyResult } from "../oauth/models.ts";
import type { AccountUuid } from "../domain/account.ts";
import type { TokenStore } from "../ports.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
import type { DiscoveryPorts } from "./discover-accounts.ts";

const execFileAsync = promisify(execFile);

/**
 * Hard cap on every `security` invocation. Under launchd we have seen the
 * command block indefinitely on keychain ACL prompts (which never render);
 * a per-call timeout guarantees the daemon boot completes even if the
 * keychain is uncooperative.
 */
const SECURITY_CALL_TIMEOUT_MS = 5000;

const CLI_SERVICE_PREFIX = "Claude Code-credentials";

export type RealPortDeps = {
	tokenStore: MutableTokenStore;
	readRegistry: () => Promise<AccountRegistry | undefined>;
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

/**
 * Build a `DiscoveryPorts` bundle bound to real macOS side-effects.
 *
 * @param {RealPortDeps} deps - Injected shared surfaces.
 * @returns {DiscoveryPorts} Ready-to-use ports.
 */
/**
 * Mint a fresh v4 uuid as the LOCAL pool identifier. Anthropic never
 * sees this uuid, so it doesn't need to match any server-side id.
 * Subscription + tier default to "unknown"; daemon `/usage` fills them
 * from the real API response on first fetch.
 *
 * @param {string} _token - OAuth token; ignored by the synthetic path.
 * @returns {Promise<{ok:true,...}>} Verify result with a fresh uuid.
 */
function syntheticVerify(_token: string): Promise<VerifyResult> {
	return Promise.resolve({
		ok: true,
		subscriptionType: "unknown",
		rateLimitTier: "unknown",
		accountUuid: crypto.randomUUID(),
	} as VerifyResult);
}

export function makeRealDiscoveryPorts(deps: RealPortDeps): DiscoveryPorts {
	const registryWriter = new AtomicRegistryWriter({
		path: defaultRegistryPath(),
		fs: nodeRegistryFsPort(),
	});
	return {
		readKeychainPassword: async (service, account) => {
			try {
				const { stdout } = await execFileAsync(
					"security",
					["find-generic-password", "-w", "-s", service, "-a", account],
					{ timeout: SECURITY_CALL_TIMEOUT_MS },
				);
				return stdout.replace(/\n$/u, "");
			} catch (error) {
				// Log the classified failure. Without this the caller only sees
				// "no key in keychain" and can't tell missing-item from ACL
				// denial from timeout — three very different fix paths.
				deps.logger.warn(`readKeychainPassword(${service}/${account}) failed: ${String(error)}`);
				// eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined so the caller's `if (raw === undefined)` branch stays readable.
				return undefined;
			}
		},
		listClaudeCliServices: () => listClaudeCliServices(deps.readRegistry, deps.logger),
		readClaudeCliCredential: async (service) => {
			try {
				const { stdout } = await execFileAsync(
					"security",
					["find-generic-password", "-w", "-s", service],
					{ timeout: SECURITY_CALL_TIMEOUT_MS },
				);
				return stdout.replace(/\n$/u, "");
			} catch {
				// eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined for readability.
				return undefined;
			}
		},
		iterateLevelDb: (dir) => iterateLevelDbFiles(dir, deps.logger),
		iterateAppConfigJson: (path) => iterateConfigJsonV10Values(path, deps.logger),
		listCloneApps: async () => {
			const appsDir = join(homedir(), "Applications");
			let entries: string[];
			try {
				entries = await readdir(appsDir);
			} catch {
				return [];
			}
			const out: Array<{ bundlePath: string; label: string; storeDir: string }> = [];
			for (const name of entries) {
				const match = /^Claude Account (.+)\.app$/u.exec(name);
				if (match !== null && match[1] !== undefined) {
					const label = match[1].trim().toLowerCase().replaceAll(/\s+/gu, "-");
					const bundlePath = join(appsDir, name);
					const storeDir = join(
						homedir(),
						"Library",
						"Application Support",
						`Claude-${label.charAt(0).toUpperCase() + label.slice(1)}`,
					);
					out.push({ bundlePath, label, storeDir });
				}
			}
			return out;
		},
		provisionOne: async ({ token, label }) => {
			const result = await provisionAccount({
				token,
				label,
				ports: {
					tokenStore: deps.tokenStore,
					registryWriter,
					readRegistry: deps.readRegistry,
					verify: syntheticVerify,
				},
				overrideFlag: true,
			});
			if (result.ok) {
				return { ok: true, uuid: result.account.uuid as AccountUuid };
			}
			return { ok: false, kind: result.kind, detail: result.detail ?? "" };
		},
		readRegistry: deps.readRegistry,
		tokenStore: deps.tokenStore as TokenStore,
		logger: deps.logger,
	};
}

/**
 * Best-effort iterate every value stored in a Chromium LevelDB dir. Yields
 * `{key, value}` pairs; keys are the raw LevelDB keys (bytes), values are
 * the raw values (bytes). Missing dir → empty. Read errors on individual
 * files → warn + skip.
 *
 * Reads only the `*.log` (recent writes) + `*.ldb` (compacted SSTs) files.
 * Handles the plain (uncompressed) key/value block layout Chromium uses
 * for Local Storage / IndexedDB.
 *
 * @param {string} dir - Absolute path to the leveldb directory.
 * @param {{warn: (m: string) => void}} logger - Warn sink.
 * @yields {{key: Buffer, value: Buffer}} Per-value pairs found in the LevelDB dir.
 */
async function* iterateLevelDbFiles(
	dir: string,
	logger: { warn: (m: string) => void },
): AsyncIterable<{ key: Buffer; value: Buffer }> {
	let entries: string[];
	try {
		const st = await stat(dir);
		if (!st.isDirectory()) {
			return;
		}
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.endsWith(".log") || name.endsWith(".ldb")) {
			const file = join(dir, name);
			let raw: Buffer | undefined;
			try {
				// eslint-disable-next-line no-await-in-loop -- serial file reads bound by directory size
				raw = await readFile(file);
			} catch (error) {
				logger.warn(`iterateLevelDb: read ${file} failed: ${String(error)}`);
			}
			if (raw !== undefined) {
				// Scan the raw bytes for `v10`-prefixed values embedded anywhere in
				// the file. This is a lossy heuristic — LevelDB's on-disk format
				// interleaves records with block trailers + CRCs — but Chromium's
				// encrypted values (starting `v10`) are distinct enough to locate
				// via byte-scanning. Each candidate hit yields the plain-scan slice
				// starting at `v10` up to a plausible cipher-length boundary.
				for (const { key, value } of scanV10Values(raw)) {
					yield { key, value };
				}
			}
		}
	}
}

/**
 * Read an Electron `config.json` and yield each base64-encoded v10 blob
 * embedded as a top-level string value, decoded to raw bytes. This is the
 * shape modern Claude.app uses for `oauth:tokenCache` /
 * `oauth:tokenCacheV2` — the desktop client stopped writing those tokens
 * into Local Storage / IndexedDB and moved them into `config.json` via
 * Electron's `safeStorage` API. Missing / unreadable / non-JSON file
 * yields nothing (silent, no throw); the daemon must still boot.
 *
 * @param {string} path - Absolute path to the `config.json` file.
 * @param {{warn: (m: string) => void}} logger - Warn sink for read/parse errors.
 * @yields {{key: Buffer, value: Buffer}} JSON key + decoded v10 blob bytes.
 */
async function* iterateConfigJsonV10Values(
	path: string,
	logger: { warn: (m: string) => void },
): AsyncIterable<{ key: Buffer; value: Buffer }> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger.warn(`iterateAppConfigJson: ${path} is not valid JSON: ${String(error)}`);
		return;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return;
	}
	// Chromium v10 blobs base64-encode to a string starting `djEw` because
	// the raw bytes are `v10` (0x76 0x31 0x30) → base64 quartet `djEw`.
	// That first quartet decodes to exactly those three bytes, so the
	// prefix check is sufficient — no need to re-verify after decoding.
	for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof v === "string" && v.startsWith("djEw")) {
			yield { key: Buffer.from(k, "utf8"), value: Buffer.from(v, "base64") };
		}
	}
}

/**
 * Byte-scan a raw LevelDB file for `v10`-prefixed values. Yields each
 * candidate blob for the caller to attempt decrypt on. Cipher length is
 * heuristically bounded — we take chunks up to the next `v10` prefix or
 * a plausible max size (32KB), whichever comes first.
 *
 * @param {Buffer} raw - Raw file bytes.
 * @yields {{key: Buffer, value: Buffer}} Each v10-prefixed candidate.
 */
function* scanV10Values(raw: Buffer): Iterable<{ key: Buffer; value: Buffer }> {
	const prefix = Buffer.from("v10");
	let idx = 0;
	while (idx < raw.length) {
		const hit = raw.indexOf(prefix, idx);
		if (hit === -1) {
			return;
		}
		// Find next v10 after this one; slice up to that (or max 32KB).
		const nextHit = raw.indexOf(prefix, hit + prefix.length);
		const end = nextHit === -1 ? Math.min(hit + 32_768, raw.length) : nextHit;
		const value = raw.subarray(hit, end);
		yield { key: Buffer.from([]), value };
		idx = end;
	}
}

/**
 * Discover which `Claude Code-credentials-*` keychain services actually
 * resolve on this box. `security find-generic-password` does not accept a
 * glob, so we gather candidate service names from three known-safe sources
 * and probe each one — a targeted probe cannot trigger the ACL-prompt hang
 * that made `security dump-keychain` unusable under launchd.
 *
 * Sources, in order of trust:
 *   1. Labels already recorded in `~/.config/claude-multiacct/registry.json`.
 *      These have already been provisioned once; probing them lets discovery
 *      re-associate a rotated token with the same slot.
 *   2. The unsuffixed canonical `Claude Code-credentials` service the stock
 *      Anthropic CLI writes to on a fresh login.
 *   3. A string list a user has dropped into `~/.claude/.credentials.json`
 *      or `~/.claude/settings.json`, either as the top-level array or as
 *      an `accounts` / `credentials` array-of-strings field. This is the
 *      escape hatch for the multi-slot case where the stock CLI has stored
 *      several accounts under distinct suffixes. We accept only explicit
 *      string arrays because settings.json in the wild carries unrelated
 *      top-level keys we must not probe as service names.
 *
 * Each label is expanded to `Claude Code-credentials-<label>` if it does not
 * already start with that prefix. Duplicates are collapsed. We probe with
 * the same 5-second hard cap the other `security` calls use.
 *
 * @param {() => Promise<AccountRegistry | undefined>} readRegistry - Registry reader.
 * @param {{warn: (m: string) => void}} logger - Warn sink.
 * @returns {Promise<string[]>} Every candidate that resolved, deduplicated.
 */
async function listClaudeCliServices(
	readRegistry: () => Promise<AccountRegistry | undefined>,
	logger: { warn: (m: string) => void },
): Promise<string[]> {
	const candidates = new Set<string>([CLI_SERVICE_PREFIX]);
	try {
		const registry = await readRegistry();
		if (registry !== undefined) {
			for (const account of registry.accounts) {
				candidates.add(toServiceName(account.label));
			}
		}
	} catch (error) {
		logger.warn(`listClaudeCliServices: registry read failed: ${String(error)}`);
	}
	for (const path of claudeLabelFiles()) {
		// eslint-disable-next-line no-await-in-loop -- two files, serial
		for (const label of await readLabelListFile(path, logger)) {
			candidates.add(toServiceName(label));
		}
	}
	const resolved: string[] = [];
	for (const service of candidates) {
		try {
			// eslint-disable-next-line no-await-in-loop -- serial keychain probes
			await execFileAsync("security", ["find-generic-password", "-s", service], {
				timeout: SECURITY_CALL_TIMEOUT_MS,
			});
			resolved.push(service);
		} catch {
			// Not found (exit 44) or timed out — either way, skip.
		}
	}
	return resolved;
}

function toServiceName(label: string): string {
	return label.startsWith(`${CLI_SERVICE_PREFIX}-`) || label === CLI_SERVICE_PREFIX
		? label
		: `${CLI_SERVICE_PREFIX}-${label}`;
}

function claudeLabelFiles(): string[] {
	const claudeDir = join(homedir(), ".claude");
	return [join(claudeDir, ".credentials.json"), join(claudeDir, "settings.json")];
}

/**
 * Read a JSON file and pull any string labels out of it. Accepts three
 * shapes: a top-level array of strings, an object with an `accounts` or
 * `credentials` array of strings, or an object whose own keys are labels
 * (the natural shape for `{ "<label>": {...token...} }`). Missing file or
 * malformed JSON returns empty and warns — the daemon must still boot.
 *
 * @param {string} path - Absolute path to the candidate label file.
 * @param {{warn: (m: string) => void}} logger - Warn sink.
 * @returns {Promise<string[]>} Extracted labels; empty if the file is absent or unreadable.
 */
async function readLabelListFile(
	path: string,
	logger: { warn: (m: string) => void },
): Promise<string[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger.warn(`listClaudeCliServices: ${path} is not valid JSON: ${String(error)}`);
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed.filter((x): x is string => typeof x === "string");
	}
	if (parsed !== null && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		for (const key of ["accounts", "credentials"] as const) {
			const value = obj[key];
			if (Array.isArray(value)) {
				return value.filter((x): x is string => typeof x === "string");
			}
		}
	}
	return [];
}
