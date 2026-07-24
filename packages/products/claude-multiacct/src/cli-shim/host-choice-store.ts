/**
 * `@foundation/claude-multiacct` — file-backed `HostChoiceStore`.
 *
 * Files under `~/.config/claude-multiacct/host-session-account/<hostId>.json`,
 * one per conversation, keyed on `CLAUDE_CODE_HOST_SESSION_ID`. Sibling to
 * `FsChoiceStore` (CLI-uuid-keyed) and deliberately a SEPARATE store: the two
 * live in different id namespaces, and the host store's schema must stay looser
 * (a `local_<uuid>` token, not a bare uuid) without loosening the strict
 * uuid-keyed choice store.
 *
 * Same soft-failure posture as `FsChoiceStore`: a missing/unreadable/corrupt
 * sidecar resolves to `undefined` (the shim's "fall back to primary" signal),
 * never a throw, so a rotted sidecar can't crash the user's Code session. The
 * id is validated against `isValidHostSessionId` BEFORE it is used to build a
 * path, so a malformed or hostile env value can never escape the directory.
 * Writes are atomic (`tmp + rename`).
 *
 * The `InMemoryHostChoiceStore` for tests lives in
 * `./in-memory-host-choice-store.ts` — one class per file for oxlint's
 * `max-classes-per-file`.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
	HostSessionChoiceSchema,
	isValidHostSessionId,
	type HostSessionChoice,
} from "../domain/host-session-choice.ts";
import type { HostChoiceStore } from "../ports.ts";
import { silentLogger, type ChoiceStoreLogger } from "./choice-store.ts";

/**
 * Default on-disk location for the per-conversation host-session sidecars.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/host-session-account/`.
 */
export function defaultHostChoiceStoreDir(): string {
	return join(homedir(), ".config", "claude-multiacct", "host-session-account");
}

/**
 * `FsHostChoiceStore` — per-conversation JSON files under `dir`, keyed on the
 * host session id. Atomic writes; corrupt/absent sidecars resolve to
 * `undefined` (warn + skip) so the shim falls back to primary rather than crash.
 */
export class FsHostChoiceStore implements HostChoiceStore {
	private readonly dir: string;
	private readonly logger: ChoiceStoreLogger;

	constructor(dir: string = defaultHostChoiceStoreDir(), logger: ChoiceStoreLogger = silentLogger) {
		this.dir = dir;
		this.logger = logger;
	}

	async read(hostSessionId: string): Promise<HostSessionChoice | undefined> {
		// Guard the id before it ever becomes a path segment — an invalid or
		// hostile `CLAUDE_CODE_HOST_SESSION_ID` must never build a filename.
		if (!isValidHostSessionId(hostSessionId)) {
			return undefined;
		}
		const full = join(this.dir, `${hostSessionId}.json`);
		let raw: string;
		try {
			raw = await readFile(full, "utf8");
		} catch {
			// Missing/unreadable → no recorded choice (the common case).
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			this.logger.warn(`FsHostChoiceStore: corrupted sidecar ${full}: ${String(error)}`);
			return undefined;
		}
		const validated = v.safeParse(HostSessionChoiceSchema, parsed);
		if (!validated.success) {
			this.logger.warn(
				`FsHostChoiceStore: schema-invalid sidecar ${full}: ${validated.issues[0].message}`,
			);
			return undefined;
		}
		// Defensive cross-check: the stored id must match the file it was read
		// from, or a hand-edited/renamed sidecar could bind the wrong conversation.
		if (validated.output.hostSessionId !== hostSessionId) {
			this.logger.warn(
				`FsHostChoiceStore: sidecar ${full} stores mismatched hostSessionId ${validated.output.hostSessionId}`,
			);
			return undefined;
		}
		return validated.output;
	}

	async write(choice: HostSessionChoice): Promise<void> {
		// Throws on an invalid id/choice — the caller writes best-effort, so a
		// bad env value is warned + swallowed there rather than persisted.
		v.parse(HostSessionChoiceSchema, choice);
		await mkdir(this.dir, { recursive: true });
		const finalPath = join(this.dir, `${choice.hostSessionId}.json`);
		const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
		await writeFile(tmpPath, JSON.stringify(choice), "utf8");
		await rename(tmpPath, finalPath);
	}
}

// Re-export the InMemory adapter from its own file so callers have one entry
// point per adapter but oxlint's `max-classes-per-file` remains happy.
export { InMemoryHostChoiceStore } from "./in-memory-host-choice-store.ts";
