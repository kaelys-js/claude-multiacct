/**
 * `@foundation/claude-multiacct` — file-backed `AccountRegistry` reader.
 *
 * Reads `~/.config/claude-multiacct/registry.json`, validates via
 * `AccountRegistrySchema` (which enforces the exactly-one-primary, unique-uuid,
 * unique-label invariants), and returns the parsed registry. Missing file →
 * `undefined`. Corrupted / invalid file → `undefined` + warning. The shim
 * treats both as "no pool configured, pass through to primary" — same
 * fail-safe reasoning as `FsChoiceStore`: a rotted sidecar must not crash
 * the user's Code session.
 *
 * No writer in this PR — the pool is populated by later CLI flows.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { type AccountRegistry, AccountRegistrySchema } from "../domain/registry.ts";

/**
 * Default on-disk location for the registry file.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/registry.json`.
 */
export function defaultRegistryPath(): string {
	return join(homedir(), ".config", "claude-multiacct", "registry.json");
}

/** Minimal logger surface — same shape as `ChoiceStoreLogger`. */
export type RegistryStoreLogger = { warn: (message: string) => void };

/** Silent no-op logger — exported so tests can pin the default-arg contract. */
export const silentLogger: RegistryStoreLogger = {
	warn: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
};

/**
 * Read + validate the registry. Missing file → `undefined`.
 * Corrupted / schema-invalid file → `undefined` + `logger.warn`.
 *
 * @param {string} path - Absolute path to the registry file.
 * @param {RegistryStoreLogger} logger - Warning sink; defaults silent.
 * @returns {Promise<AccountRegistry | undefined>} Parsed registry, or `undefined` on missing/invalid.
 */
export async function readRegistry(
	path: string = defaultRegistryPath(),
	logger: RegistryStoreLogger = silentLogger,
): Promise<AccountRegistry | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return undefined;
		}
		logger.warn(`RegistryStore: unreadable registry ${path}: ${String(error)}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger.warn(`RegistryStore: corrupted registry ${path}: ${String(error)}`);
		return undefined;
	}
	const validated = v.safeParse(AccountRegistrySchema, parsed);
	if (!validated.success) {
		logger.warn(`RegistryStore: schema-invalid registry ${path}: ${validated.issues[0].message}`);
		return undefined;
	}
	return validated.output;
}
