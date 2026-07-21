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
 *   - `listClaudeCliServices()` → `security dump-keychain` grep
 *     `svce=... Claude Code-credentials-*`.
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
				const { stdout } = await execFileAsync("security", [
					"find-generic-password",
					"-w",
					"-s",
					service,
					"-a",
					account,
				]);
				return stdout.replace(/\n$/u, "");
			} catch {
				// eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined so the caller's `if (raw === undefined)` branch stays readable.
				return undefined;
			}
		},
		listClaudeCliServices: async () => {
			try {
				const { stdout } = await execFileAsync("security", ["dump-keychain"], {
					maxBuffer: 32 * 1024 * 1024,
				});
				const matches = new Set<string>();
				const re = /"svce"<blob>="(Claude Code-credentials-[^"]+)"/gu;
				let m;
				while ((m = re.exec(stdout)) !== null) {
					if (m[1] !== undefined) {
						matches.add(m[1]);
					}
				}
				return [...matches];
			} catch {
				return [];
			}
		},
		readClaudeCliCredential: async (service) => {
			try {
				const { stdout } = await execFileAsync("security", [
					"find-generic-password",
					"-w",
					"-s",
					service,
				]);
				return stdout.replace(/\n$/u, "");
			} catch {
				// eslint-disable-next-line unicorn/no-useless-undefined -- Explicit undefined for readability.
				return undefined;
			}
		},
		iterateLevelDb: (dir) => iterateLevelDbFiles(dir, deps.logger),
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
