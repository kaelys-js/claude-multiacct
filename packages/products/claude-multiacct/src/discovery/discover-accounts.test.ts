/* eslint-disable vitest/no-conditional-in-test, vitest/require-to-throw-message, no-bitwise, eslint/no-bitwise, eslint/operator-assignment, unicorn/prefer-at, jsdoc/require-returns, jsdoc/require-param */
/**
 * Intent: `discoverAccounts` orchestrates auto-detection across three
 * sources (main Claude.app + clones + `claude` CLI keychain slots) and
 * deduplicates by SHA-256 of the token bytes. Every branch that talks
 * to the outside world is injected — this file exercises the whole
 * decision tree with fake ports.
 *
 * Adversarial: remove the seenThisRun dedup and the same token found
 * in both main app and CLI gets registered twice — "does not double-
 * register same token" flips RED. Remove the knownTokenHashes check
 * and re-running against a populated registry re-registers everyone —
 * "idempotent on rerun" flips RED.
 */

import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AccountUuid } from "../domain/account.ts";
import type { AccountRegistry } from "../domain/registry.ts";
import type { TokenStore } from "../ports.ts";
import { CHROMIUM_IV, CHROMIUM_V10_PREFIX, deriveChromiumKey } from "./chromium-crypto.ts";
import { deriveLabel, discoverAccounts, type DiscoveryPorts } from "./discover-accounts.ts";

const PASSWORD = "test-safe-storage-key";
const KEY = deriveChromiumKey(PASSWORD);

function encryptForTest(plaintext: string): Buffer {
	const cipher = createCipheriv("aes-128-cbc", KEY, CHROMIUM_IV);
	cipher.setAutoPadding(true);
	const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	return Buffer.concat([CHROMIUM_V10_PREFIX, ct]);
}

function mkTokenStore(entries: Record<string, string> = {}): TokenStore {
	return {
		get: (uuid: AccountUuid) => Promise.resolve(entries[uuid] as string | undefined),
		put: () => Promise.resolve(),
	} as unknown as TokenStore;
}

function mkPorts(overrides: Partial<DiscoveryPorts> = {}): DiscoveryPorts {
	const provisioned: Array<{ token: string; label: string; uuid: AccountUuid }> = [];
	const defaults: DiscoveryPorts = {
		readKeychainPassword: () => Promise.resolve(PASSWORD),
		listClaudeCliServices: () => Promise.resolve([]),
		readClaudeCliCredential: () => Promise.resolve(undefined),
		iterateLevelDb: async function* () {
			// yield nothing
		},
		iterateAppConfigJson: async function* () {
			// yield nothing
		},
		listCloneApps: () => Promise.resolve([]),
		provisionOne: ({ token, label }) => {
			const uuid =
				`${String(provisioned.length).padStart(8, "0")}-1111-4111-8111-000000000000` as AccountUuid;
			provisioned.push({ token, label, uuid });
			return Promise.resolve({ ok: true, uuid });
		},
		readRegistry: () => Promise.resolve(undefined),
		tokenStore: mkTokenStore(),
		logger: { log: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>() },
	};
	return { ...defaults, ...overrides };
}

describe("discoverAccounts", () => {
	it("registers a token from the main Claude.app LevelDB (v10 → decrypt → JSON)", async () => {
		const provisioned: string[] = [];
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield {
							key: Buffer.from("some-key"),
							value: encryptForTest('{"access_token":"T-icloud","email":"me@icloud.com"}'),
						};
					}
				},
				provisionOne: ({ token, label }) => {
					provisioned.push(`${label}:${token}`);
					return Promise.resolve({
						ok: true,
						uuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as AccountUuid,
					});
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.registered[0]!.label).toBe("icloud");
		expect(provisioned).toContain("icloud:T-icloud");
	});

	it("registers a token from a Claude CLI keychain slot", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				listClaudeCliServices: () => Promise.resolve(["Claude Code-credentials-abc123"]),
				readClaudeCliCredential: () =>
					Promise.resolve('{"access_token":"T-cli","email":"me@gmail.com"}'),
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.registered[0]!.label).toBe("gmail");
	});

	it("does NOT double-register the same token found in both main app and CLI", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield {
							key: Buffer.from("k"),
							value: encryptForTest('{"access_token":"T-shared","email":"me@icloud.com"}'),
						};
					}
				},
				listClaudeCliServices: () => Promise.resolve(["Claude Code-credentials-abc"]),
				readClaudeCliCredential: () =>
					Promise.resolve('{"access_token":"T-shared","email":"me@icloud.com"}'),
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.skippedAlreadyRegistered).toBe(1);
	});

	it("is idempotent on rerun (skips tokens already in the registry)", async () => {
		const registered: AccountUuid = "cccccccc-1111-4111-8111-cccccccccccc" as AccountUuid;
		const existingRegistry: AccountRegistry = {
			accounts: [
				{
					uuid: registered,
					label: "icloud",
					subscriptionType: "unknown",
					rateLimitTier: "unknown",
					encryptedTokenRef: registered,
				},
			],
		} as AccountRegistry;
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield {
							key: Buffer.from("k"),
							value: encryptForTest('{"access_token":"T-known"}'),
						};
					}
				},
				readRegistry: () => Promise.resolve(existingRegistry),
				tokenStore: mkTokenStore({ [registered]: "T-known" }),
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.skippedAlreadyRegistered).toBe(1);
	});

	it("skips main-app scan when Claude Safe Storage key is missing (warns + moves on)", async () => {
		const logs: string[] = [];
		const outcome = await discoverAccounts(
			mkPorts({
				readKeychainPassword: () => Promise.resolve(undefined),
				logger: {
					log: () => {
						/* no-op */
					},
					warn: (m: string) => {
						logs.push(m);
					},
				},
			}),
		);
		expect(logs.some((m) => m.includes("no `Claude Safe Storage` key"))).toBe(true);
		expect(outcome.registered).toHaveLength(0);
	});

	it("captures classified provisioning failures without aborting the whole run", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield { key: Buffer.from("k"), value: encryptForTest('{"access_token":"T-1"}') };
					}
				},
				listClaudeCliServices: () => Promise.resolve(["Claude Code-credentials-x"]),
				readClaudeCliCredential: () => Promise.resolve('{"access_token":"T-2"}'),
				provisionOne: ({ token }) => {
					if (token === "T-1") {
						return Promise.resolve({ ok: false, kind: "verify_failed", detail: "network" });
					}
					return Promise.resolve({
						ok: true,
						uuid: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb" as AccountUuid,
					});
				},
			}),
		);
		expect(outcome.failed).toHaveLength(1);
		expect(outcome.failed[0]!.kind).toBe("verify_failed");
		expect(outcome.registered).toHaveLength(1);
	});

	it("silently skips leveldb entries that are not v10-encrypted", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield { key: Buffer.from("k1"), value: Buffer.from("plain text") };
						yield {
							key: Buffer.from("k2"),
							value: Buffer.concat([Buffer.from("v11"), Buffer.from("wrong-version")]),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.mainApp).toBe(2);
	});

	it("silently skips v10 entries whose decrypted content isn't OAuth JSON", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (
					dir,
				) /* eslint-disable-next-line vitest/no-conditional-in-test */ {
					if (dir.endsWith("Local Storage/leveldb")) {
						yield { key: Buffer.from("k"), value: encryptForTest('{"unrelated":"data"}') };
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
	});

	it("registers a token from Claude.app's config.json oauth:tokenCache (v10 → decrypt → JSON)", async () => {
		// Regression: modern Claude.app writes its OAuth token cache into
		// `config.json` via Electron `safeStorage`, not into Local Storage
		// / IndexedDB. Discovery must scan that path or it misses the
		// primary happy-path account on every up-to-date machine.
		const outcome = await discoverAccounts(
			mkPorts({
				iterateAppConfigJson: async function* (path) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (path.endsWith("/config.json")) {
						yield {
							key: Buffer.from("oauth:tokenCache", "utf8"),
							value: encryptForTest('{"access_token":"T-primary","email":"me@icloud.com"}'),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.registered[0]!.label).toBe("icloud");
		expect(outcome.scanned.mainApp).toBe(1);
	});

	it("counts a non-decryptable config.json blob under scanned but does not register anything", async () => {
		// The `found === undefined` branch of the config.json loop matters —
		// Claude.app also stores other v10 blobs (e.g. `dxt:allowlistCache:*`)
		// that decrypt to non-token JSON. Those must be scanned + skipped
		// silently, not treated as OAuth.
		const outcome = await discoverAccounts(
			mkPorts({
				iterateAppConfigJson: async function* () {
					yield {
						key: Buffer.from("dxt:allowlistCache"),
						value: encryptForTest('{"not":"oauth"}'),
					};
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.mainApp).toBe(1);
	});

	it("registers a token from a clone-app's LevelDB (shared safe-storage key)", async () => {
		// Covers the clone-app LevelDB scan branch: iterateLevelDb yields a
		// v10 blob under the clone's storeDir, tryDecryptAndExtract returns
		// a token, tryRegister accepts it.
		const outcome = await discoverAccounts(
			mkPorts({
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Gmail.app",
							label: "gmail",
							storeDir: "/tmp/claude-gmail",
						},
					]),
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.startsWith("/tmp/claude-gmail")) {
						yield {
							key: Buffer.from("k"),
							value: encryptForTest('{"access_token":"T-gmail","email":"me@gmail.com"}'),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.registered[0]!.label).toBe("gmail");
	});

	it("silently skips a v10 blob whose decrypt throws (truncated / bad IV / wrong key)", async () => {
		// Covers the `catch { return undefined }` branch inside
		// tryDecryptAndExtract — a corrupted blob must not surface as a
		// discovery failure, just be skipped.
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.endsWith("Local Storage/leveldb")) {
						// v10 prefix but zero cipher bytes → decryptV10 throws.
						yield { key: Buffer.from("k"), value: Buffer.from("v10") };
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.mainApp).toBe(1);
	});

	it("scans config.json for clone-app stores under the shared safe-storage key", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Work.app",
							label: "work",
							storeDir: "/tmp/claude-work",
						},
					]),
				iterateAppConfigJson: async function* (path) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (path.startsWith("/tmp/claude-work")) {
						yield {
							key: Buffer.from("oauth:tokenCache"),
							value: encryptForTest('{"access_token":"T-work","email":"me@work.co"}'),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.registered[0]!.label).toBe("work");
		expect(outcome.scanned.cloneApps).toBe(1);
	});

	it("deduplicates a token found in both LevelDB and config.json (Chromium double-write)", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.endsWith("Local Storage/leveldb")) {
						yield {
							key: Buffer.from("k"),
							value: encryptForTest('{"access_token":"T-dup","email":"a@icloud.com"}'),
						};
					}
				},
				iterateAppConfigJson: async function* () {
					yield {
						key: Buffer.from("oauth:tokenCache"),
						value: encryptForTest('{"access_token":"T-dup","email":"a@icloud.com"}'),
					};
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.skippedAlreadyRegistered).toBe(1);
	});

	it("skips the clone scan entirely when the shared safe-storage key is missing", async () => {
		// Clones decrypt with the SAME `Claude Safe Storage` key as the main app.
		// If that key never materialized (keychain read refused), the clone loop
		// must break immediately rather than call deriveChromiumKey(undefined) and
		// crash. A clone is present + its LevelDB would yield a token, but with no
		// key nothing is scanned or registered.
		const cloneIterated = vi.fn<() => void>();
		const outcome = await discoverAccounts(
			mkPorts({
				readKeychainPassword: () => Promise.resolve(undefined),
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Gmail.app",
							label: "gmail",
							storeDir: "/tmp/claude-gmail",
						},
					]),
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.startsWith("/tmp/claude-gmail")) {
						cloneIterated();
						yield {
							key: Buffer.from("k"),
							value: encryptForTest('{"access_token":"T-gmail","email":"me@gmail.com"}'),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.cloneApps).toBe(0);
		// The break fires before iterateLevelDb is ever consulted for the clone.
		expect(cloneIterated).not.toHaveBeenCalled();
	});

	it("counts but does not register a clone LevelDB value that is not a token", async () => {
		// The `found === undefined` side of the clone LevelDB loop: a v10 blob that
		// decrypts to non-OAuth JSON is scanned + skipped, not registered.
		const outcome = await discoverAccounts(
			mkPorts({
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Gmail.app",
							label: "gmail",
							storeDir: "/tmp/claude-gmail",
						},
					]),
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.startsWith("/tmp/claude-gmail") && dir.endsWith("leveldb")) {
						yield { key: Buffer.from("k"), value: encryptForTest('{"unrelated":"x"}') };
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.cloneApps).toBe(1);
	});

	it("counts but does not register a clone config.json value that is not a token", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Work.app",
							label: "work",
							storeDir: "/tmp/claude-work",
						},
					]),
				iterateAppConfigJson: async function* (path) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (path.startsWith("/tmp/claude-work")) {
						yield { key: Buffer.from("dxt:cache"), value: encryptForTest('{"unrelated":"x"}') };
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.cloneApps).toBe(1);
	});

	it("skips a v10 blob whose decrypt throws on a length-bearing (but corrupt) cipher", async () => {
		// tryDecryptAndExtract's catch (return undefined): a value that passes the
		// isEncrypted length check (>3 bytes) but whose ciphertext is not
		// block-aligned makes decryptV10 throw. Must be swallowed, not surfaced.
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.endsWith("Local Storage/leveldb")) {
						yield {
							key: Buffer.from("k"),
							value: Buffer.concat([Buffer.from("v10"), Buffer.from([1, 2, 3])]),
						};
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		expect(outcome.scanned.mainApp).toBe(1);
	});

	it("scans a CLI slot that reads empty (undefined) and one whose JSON isn't a token, registering neither", async () => {
		// raw === undefined → not counted (readClaudeCliCredential miss). raw
		// present but extractOauthFromPlaintext === undefined → counted, not
		// registered. Covers both false branches in the CLI loop.
		const outcome = await discoverAccounts(
			mkPorts({
				listClaudeCliServices: () =>
					Promise.resolve(["Claude Code-credentials-empty", "Claude Code-credentials-junk"]),
				readClaudeCliCredential: (service) =>
					service.endsWith("empty")
						? Promise.resolve(undefined)
						: Promise.resolve('{"unrelated":"not-a-token"}'),
			}),
		);
		expect(outcome.registered).toHaveLength(0);
		// Only the slot that returned a value is counted as scanned.
		expect(outcome.scanned.cliCredentials).toBe(1);
	});

	it("ignores a registry account whose stored token cannot be read (dedup hash skipped)", async () => {
		// hashExistingRegistry: tokenStore.get returns undefined (not a string) →
		// no hash added, so a fresh scan of the same account still registers.
		const registered: AccountUuid = "dddddddd-1111-4111-8111-dddddddddddd" as AccountUuid;
		const existingRegistry: AccountRegistry = {
			accounts: [
				{
					uuid: registered,
					label: "icloud",
					subscriptionType: "unknown",
					rateLimitTier: "unknown",
					encryptedTokenRef: registered,
				},
			],
		} as AccountRegistry;
		const outcome = await discoverAccounts(
			mkPorts({
				readRegistry: () => Promise.resolve(existingRegistry),
				// token store returns undefined for the registry account → no hash.
				tokenStore: mkTokenStore(),
				iterateLevelDb: async function* (dir) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (dir.endsWith("Local Storage/leveldb")) {
						yield { key: Buffer.from("k"), value: encryptForTest('{"access_token":"T-fresh"}') };
					}
				},
			}),
		);
		expect(outcome.registered).toHaveLength(1);
		expect(outcome.skippedAlreadyRegistered).toBe(0);
	});

	it("registers 2 distinct accounts from a real oauth:tokenCacheV2 map (3 entries, 2 uuids)", async () => {
		// Ground truth: modern Claude.app writes oauth:tokenCacheV2 as a MAP keyed
		// by "<accountUuid>:<ws>:<audience>:<scopeSet>" with { token, ... } records.
		// The old single-object extractor missed this shape entirely, so real
		// accounts were never auto-detected. Account B appears twice (profile-only
		// + inference); the inference-scoped token must be the one registered.
		const accountA = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
		const accountB = "a473d7bb-17ac-43a7-abc0-a1343d7c2805";
		const v2Map = JSON.stringify({
			[`${accountA}:ws-a:anthropic:profile inference`]: { token: "real-tok-A" },
			[`${accountB}:ws-b:anthropic:profile`]: { token: "real-tok-B-profile" },
			[`${accountB}:ws-b:anthropic:profile inference claude_code`]: {
				token: "real-tok-B-inference",
			},
		});
		const provisioned: string[] = [];
		const outcome = await discoverAccounts(
			mkPorts({
				iterateAppConfigJson: async function* (path) {
					// eslint-disable-next-line vitest/no-conditional-in-test
					if (path.endsWith("/config.json")) {
						yield { key: Buffer.from("oauth:tokenCacheV2", "utf8"), value: encryptForTest(v2Map) };
					}
				},
				provisionOne: ({ token, label }) => {
					provisioned.push(token);
					const uuid =
						`${String(provisioned.length).padStart(8, "0")}-1111-4111-8111-000000000000` as AccountUuid;
					return Promise.resolve({ ok: true, uuid, label } as { ok: true; uuid: AccountUuid });
				},
			}),
		);
		expect(outcome.registered).toHaveLength(2);
		// Both accounts registered; the map is a single scanned blob.
		expect(outcome.scanned.mainApp).toBe(1);
		// Account B's inference-scoped token wins over its profile-only token.
		expect(provisioned).toContain("real-tok-A");
		expect(provisioned).toContain("real-tok-B-inference");
		expect(provisioned).not.toContain("real-tok-B-profile");
	});

	it("registers tokens from clone apps sharing the parent's keychain key", async () => {
		const outcome = await discoverAccounts(
			mkPorts({
				iterateLevelDb: async function* () {
					// main app dir yields nothing; clone dir handled below
				},
				listCloneApps: () =>
					Promise.resolve([
						{
							bundlePath: "/Applications/Claude Account Work.app",
							label: "work",
							storeDir: "/tmp/claude-work-store",
						},
					]),
			}),
		);
		// Empty clone dir → nothing registered but no crash.
		expect(outcome.registered).toHaveLength(0);
	});
});

describe("deriveLabel", () => {
	it("recognises icloud/me/mac addresses", () => {
		expect(deriveLabel("a@icloud.com", "main", 1)).toBe("icloud");
		expect(deriveLabel("a@me.com", "main", 1)).toBe("icloud");
		expect(deriveLabel("a@mac.com", "main", 1)).toBe("icloud");
	});
	it("recognises gmail addresses", () => {
		expect(deriveLabel("a@gmail.com", "main", 1)).toBe("gmail");
		expect(deriveLabel("a@googlemail.com", "main", 1)).toBe("gmail");
	});
	it("uses first domain segment for other emails", () => {
		expect(deriveLabel("a@work.co.uk", "main", 1)).toBe("work");
	});
	it("falls back to clone label for source-derived", () => {
		expect(deriveLabel(undefined, "clone:teamacct:store", 1)).toBe("teamacct");
	});
	it("falls back to cli-N for CLI slots without email", () => {
		expect(deriveLabel(undefined, "cli:Claude Code-credentials-x", 3)).toBe("cli-3");
	});
	it("falls back to account-N for main source without email", () => {
		expect(deriveLabel(undefined, "main:dir", 2)).toBe("account-2");
	});

	it("falls back to the source label when the email has no @ (no domain to derive)", () => {
		// email present but malformed (no "@") → the domain branch is skipped and
		// the source-derived fallback wins.
		expect(deriveLabel("notanemail", "cli:x", 4)).toBe("cli-4");
	});

	it("falls back to the source label when the email domain's first segment is empty", () => {
		// "a@" → domain "" → first segment "" (length 0) → source fallback.
		expect(deriveLabel("a@", "main:dir", 7)).toBe("account-7");
	});
});
