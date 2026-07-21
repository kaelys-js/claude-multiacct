/**
 * `@foundation/claude-multiacct` — concrete `TokenStore` implementations.
 *
 * Two adapters:
 *
 * - `InMemoryTokenStore` — a Map-backed impl for tests. `get` on a missing
 *   uuid THROWS (Rule 12: fail loud). The `TokenStore` port allows a soft
 *   `undefined` for unknown accounts, but the shim's runtime queries the
 *   store AFTER resolving a choice → an unknown uuid at that point is an
 *   invariant violation, not a soft miss.
 *
 * - `SecurityCliTokenStore` — writes/reads a macOS Keychain generic-password
 *   item via the `security` CLI, under a DEDICATED service name
 *   (`com.claude-multiacct.tokens`). Never reads Anthropic's own
 *   `Claude Safe Storage` item.
 *
 *   The class takes its `execFile`-shaped function via constructor injection
 *   rather than hard-wiring `node:child_process`, so unit tests can drive
 *   the exact CLI invocations against a fake without shelling out. The
 *   default is the real `execFile` promisified — the runtime path stays
 *   trivial for callers.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountUuid } from "../domain/account.ts";
import type { TokenStore } from "../ports.ts";

/** Keychain service name — dedicated to this tool, never Anthropic's. */
export const KEYCHAIN_SERVICE = "com.claude-multiacct.tokens";

/** Minimal `execFile`-shaped call the adapter needs. Test-injectable. */
export type ExecFileAsync = (
	file: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileAsync = promisify(execFile) as unknown as ExecFileAsync;

// Re-export the InMemory adapter from its own file so callers have one entry
// point per adapter but oxlint's `max-classes-per-file` remains happy.
export { InMemoryTokenStore } from "./in-memory-token-store.ts";

/**
 * `SecurityCliTokenStore` — macOS Keychain-backed adapter via the `security`
 * CLI. `exec` is injectable so tests can assert exact argv without spawning.
 */
export class SecurityCliTokenStore implements TokenStore {
	private readonly exec: ExecFileAsync;

	constructor(exec: ExecFileAsync = defaultExecFile) {
		this.exec = exec;
	}

	async get(accountUuid: AccountUuid): Promise<string> {
		try {
			const { stdout } = await this.exec("security", [
				"find-generic-password",
				"-s",
				KEYCHAIN_SERVICE,
				"-a",
				accountUuid,
				"-w",
			]);
			// -w emits the password followed by a trailing newline; strip it.
			return stdout.replace(/\n$/u, "");
		} catch (error) {
			throw new Error(`TokenStore: no keychain entry for account ${accountUuid}`, {
				cause: error,
			});
		}
	}

	async put(accountUuid: AccountUuid, encryptedTokenRef: string): Promise<void> {
		await this.exec("security", [
			"add-generic-password",
			"-U",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			accountUuid,
			"-w",
			encryptedTokenRef,
		]);
	}
}
