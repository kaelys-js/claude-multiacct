/**
 * `@foundation/claude-multiacct` — real-fs / real-keychain / real-network
 * bindings for the native-account reconcile.
 *
 * `discover-accounts.ts` and `native-account.ts` take every side-effect via
 * injected ports so tests never touch the real machine. This file provides the
 * runtime bindings the daemon uses at boot:
 *
 *   - `readKeychainPassword` → `security find-generic-password` (decrypt key).
 *   - `iterateAppConfigJson` → read Claude.app's config.json and yield each
 *     base64 v10 blob (the `oauth:tokenCache*` values).
 *   - `readLastKnownAccountUuid` → read the plaintext marker from config.json.
 *   - `fetchProfile` → the real profile API via global `fetch`.
 *   - `provisionNative` → `provisionAccount` with the native account's real
 *     uuid + identity (source `native`), bypassing the CLI verify subprocess
 *     because the profile call already proved the token belongs to the account.
 *
 * The old scan-everything bindings (LevelDB reader, clone-app glob, CLI-slot
 * probing, synthetic random-uuid verify) are gone: the model no longer imports
 * arbitrary cached tokens, so their IO has no caller.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { VerifyResult } from "../oauth/models.ts";
import { provisionAccount } from "../oauth/provisioning.ts";
import { AtomicRegistryWriter, nodeRegistryFsPort } from "../registry/registry-writer.ts";
import { defaultRegistryPath } from "../cli-shim/registry-store.ts";
import type { MutableTokenStore } from "../oauth/token-store-mut.ts";
import type { ActiveTokenPorts } from "./active-token.ts";
import { defaultClaudeConfigJsonPath, readLastKnownAccountUuid } from "./claude-config.ts";
import type { DiscoveryPorts } from "./discover-accounts.ts";
import { fetchAccountProfile } from "./identity.ts";
import { detectNativeAccount } from "./native-account.ts";

const execFileAsync = promisify(execFile);

/**
 * Hard cap on every `security` invocation. Under launchd the command has been
 * seen to block on a keychain ACL prompt that never renders; a per-call timeout
 * guarantees boot completes even when the keychain is uncooperative.
 */
const SECURITY_CALL_TIMEOUT_MS = 5000;

export type RealPortDeps = {
	tokenStore: MutableTokenStore;
	readRegistry: () => Promise<AccountRegistry | undefined>;
	logger: { log: (m: string) => void; warn: (m: string) => void };
};

/**
 * Read one `security find-generic-password -w` value, timeout-bounded. Returns
 * `undefined` (never throws) when the item is missing, the read is refused, or
 * the call times out — the callers all branch on `=== undefined`.
 *
 * @param {string} service - Keychain service name.
 * @param {string} account - Keychain account name.
 * @param {{warn: (m: string) => void}} logger - Warn sink for the failure line.
 * @returns {Promise<string | undefined>} The password, or `undefined`.
 */
async function realReadKeychainPassword(
	service: string,
	account: string,
	logger: { warn: (m: string) => void },
): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"security",
			["find-generic-password", "-w", "-s", service, "-a", account],
			{ timeout: SECURITY_CALL_TIMEOUT_MS },
		);
		return stdout.replace(/\n$/u, "");
	} catch (error) {
		logger.warn(`readKeychainPassword(${service}/${account}) failed: ${String(error)}`);
		// eslint-disable-next-line unicorn/no-useless-undefined -- explicit for the caller's `=== undefined` branch
		return undefined;
	}
}

/**
 * Build the `ActiveTokenPorts` the gui-session companion needs to hash
 * Claude.app's live token (keychain + config.json v10 reads). Kept here so the
 * companion and the discovery ports share one keychain/config binding.
 *
 * @param {{warn: (m: string) => void}} logger - Warn sink.
 * @returns {ActiveTokenPorts} Keychain + config.json IO for `currentActiveTokenSha`.
 */
export function makeActiveTokenPorts(logger: { warn: (m: string) => void }): ActiveTokenPorts {
	return {
		readKeychainPassword: (service, account) => realReadKeychainPassword(service, account, logger),
		iterateAppConfigJson: (path) => iterateConfigJsonV10Values(path, logger),
		configJsonPath: defaultClaudeConfigJsonPath(),
	};
}

/**
 * Build a `DiscoveryPorts` bundle bound to real macOS side-effects.
 *
 * @param {RealPortDeps} deps - Injected shared surfaces.
 * @returns {DiscoveryPorts} Ready-to-use ports for `discoverAccounts`.
 */
export function makeRealDiscoveryPorts(deps: RealPortDeps): DiscoveryPorts {
	const registryWriter = new AtomicRegistryWriter({
		path: defaultRegistryPath(),
		fs: nodeRegistryFsPort(),
	});
	const configJsonPath = defaultClaudeConfigJsonPath();

	const readKeychainPassword = (service: string, account: string): Promise<string | undefined> =>
		realReadKeychainPassword(service, account, deps.logger);

	return {
		detectNative: () =>
			detectNativeAccount({
				readLastKnownAccountUuid: () => readLastKnownAccountUuid(configJsonPath),
				readKeychainPassword,
				iterateAppConfigJson: (path) => iterateConfigJsonV10Values(path, deps.logger),
				configJsonPath,
				fetchProfile: (token) => fetchAccountProfile(token, (url, init) => fetch(url, init)),
				logger: deps.logger,
			}),
		readRegistry: deps.readRegistry,
		provisionNative: async ({
			token,
			label,
			accountUuid,
			identity,
			subscriptionType,
			rateLimitTier,
		}) => {
			const verify = (): Promise<VerifyResult> =>
				Promise.resolve({ ok: true, subscriptionType, rateLimitTier, accountUuid } as VerifyResult);
			const result = await provisionAccount({
				token,
				label,
				identity,
				source: "native",
				ports: {
					tokenStore: deps.tokenStore,
					registryWriter,
					readRegistry: deps.readRegistry,
					verify,
				},
				overrideFlag: true,
			});
			if (result.ok) {
				return { ok: true, uuid: result.account.uuid as AccountUuid };
			}
			return { ok: false, kind: result.kind, detail: result.detail ?? "" };
		},
		logger: deps.logger,
	};
}

/**
 * Read an Electron `config.json` and yield each base64-encoded v10 blob stored
 * as a top-level string value, decoded to raw bytes. Modern Claude.app writes
 * `oauth:tokenCache` / `oauth:tokenCacheV2` here (Electron `safeStorage`).
 * Missing / unreadable / non-JSON file yields nothing (silent, no throw) so the
 * daemon still boots.
 *
 * @param {string} path - Absolute path to the `config.json` file.
 * @param {{warn: (m: string) => void}} logger - Warn sink for parse errors.
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
	// Chromium v10 blobs base64-encode to a string starting `djEw` (raw bytes
	// `v10` → base64 quartet `djEw`), so the prefix check alone identifies them.
	for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof val === "string" && val.startsWith("djEw")) {
			yield { key: Buffer.from(k, "utf8"), value: Buffer.from(val, "base64") };
		}
	}
}
