/**
 * `@foundation/claude-multiacct` — file-backed `ChoiceStore` implementation.
 *
 * Files under `~/.config/claude-multiacct/session-account/<sessionUuid>.json`,
 * one file per session. Per-file (rather than one aggregate file) so
 * concurrent shim invocations on distinct sessions do not race on a shared
 * write. Writes are atomic via `tmp + rename`; readers see either the
 * previous version or the new one, never a truncated file.
 *
 * Missing file → the composed `read()` returns an empty store (the shim's
 * fall-back-to-primary signal). A corrupted file — either non-JSON or JSON
 * that fails the domain schema — logs a warning to `stderr` and is treated
 * as absent. That is deliberate (Rule 12 loud, but not fatal for THIS
 * path): the shim must never crash the user's Code session because the
 * choice sidecar rotted; the correct failure mode is "route to primary and
 * warn". The token/registry paths still fail loud when their invariants
 * break — this soft-failure decision is scoped to the choice sidecar.
 *
 * The `InMemoryChoiceStore` for tests lives in `./in-memory-choice-store.ts`
 * — one class per file for oxlint's `max-classes-per-file`.
 *
 * @module
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
	ChoiceStoreStateSchema,
	type ChoiceStoreState,
	type SessionAccountChoice,
	SessionAccountChoiceSchema,
} from "../domain/session-choice.ts";
import type { ChoiceStore } from "../ports.ts";

/**
 * Default on-disk location for the per-session choice sidecars.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/session-account/`.
 */
export function defaultChoiceStoreDir(): string {
	return join(homedir(), ".config", "claude-multiacct", "session-account");
}

/** Minimal logger surface — stderr-bound console at runtime, silent in tests. */
export type ChoiceStoreLogger = { warn: (message: string) => void };

/** Silent no-op logger — exported so tests can pin the default-arg contract. */
export const silentLogger: ChoiceStoreLogger = {
	warn: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
};

/**
 * Load one sidecar. Returns undefined + warns on any read/parse/schema error.
 *
 * @param {string} dir - Directory containing the sidecar file.
 * @param {string} name - Sidecar file name.
 * @param {ChoiceStoreLogger} logger - Warning sink.
 * @returns {Promise<SessionAccountChoice | undefined>} Parsed choice or `undefined` on any error.
 */
async function loadOne(
	dir: string,
	name: string,
	logger: ChoiceStoreLogger,
): Promise<SessionAccountChoice | undefined> {
	const full = join(dir, name);
	let raw: string;
	try {
		raw = await readFile(full, "utf8");
	} catch (error) {
		logger.warn(`FsChoiceStore: unreadable sidecar ${full}: ${String(error)}`);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger.warn(`FsChoiceStore: corrupted sidecar ${full}: ${String(error)}`);
		return;
	}
	const validated = v.safeParse(SessionAccountChoiceSchema, parsed);
	if (!validated.success) {
		logger.warn(`FsChoiceStore: schema-invalid sidecar ${full}: ${validated.issues[0].message}`);
		return;
	}
	return validated.output;
}

/**
 * `FsChoiceStore` — per-session JSON files under `dir`. Atomic writes
 * (`tmp + rename`). Corrupted sidecars log + are skipped so the shim can
 * still fall back to primary rather than crash.
 */
export class FsChoiceStore implements ChoiceStore {
	private readonly dir: string;
	private readonly logger: ChoiceStoreLogger;

	constructor(dir: string = defaultChoiceStoreDir(), logger: ChoiceStoreLogger = silentLogger) {
		this.dir = dir;
		this.logger = logger;
	}

	async read(): Promise<ChoiceStoreState> {
		let filenames: string[];
		try {
			filenames = await readdir(this.dir);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				return v.parse(ChoiceStoreStateSchema, {});
			}
			throw error;
		}
		const jsonFiles = filenames.filter((name) => name.endsWith(".json"));
		// Fan out reads in parallel — one file per session, no order dependency.
		const loaded = await Promise.all(jsonFiles.map((name) => loadOne(this.dir, name, this.logger)));
		const state: Record<string, SessionAccountChoice> = {};
		for (const choice of loaded) {
			if (choice !== undefined) {
				state[choice.sessionUuid] = choice;
			}
		}
		return v.parse(ChoiceStoreStateSchema, state);
	}

	async write(choice: SessionAccountChoice): Promise<void> {
		v.parse(SessionAccountChoiceSchema, choice);
		await mkdir(this.dir, { recursive: true });
		const finalPath = join(this.dir, `${choice.sessionUuid}.json`);
		const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
		await writeFile(tmpPath, JSON.stringify(choice), "utf8");
		await rename(tmpPath, finalPath);
	}
}

// Re-export the InMemory adapter from its own file so callers have one entry
// point per adapter but oxlint's `max-classes-per-file` remains happy.
export { InMemoryChoiceStore } from "./in-memory-choice-store.ts";
