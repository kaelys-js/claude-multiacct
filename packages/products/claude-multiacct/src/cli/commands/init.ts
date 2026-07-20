/**
 * `@foundation/claude-multiacct` — `cma init`.
 *
 * Creates `~/.config/claude-multiacct/` and writes a default `config.json`
 * with `enabled: false`. Idempotent: an existing (valid) config → no-op
 * with a message.
 *
 * # Rule 1 decision — no `registry.json` at init time
 *
 * PR1's `AccountRegistrySchema` requires exactly one primary account; an
 * empty `{accounts: []}` therefore fails validation. Three options were
 * on the table (see the PR6a spec's Rule-1 note):
 *
 *   (a) loosen PR1's schema to accept empty (touches PR1 — Rule 3 no);
 *   (b) write an unvalidated `{accounts: []}` placeholder;
 *   (c) skip the registry write entirely at init time.
 *
 * We pick (c). `provisionAccount` (PR4) already handles a missing
 * registry: it treats "no file yet" as the empty pool and marks the
 * first-added account primary in the same write. So the first
 * `cma account add` bootstraps a schema-valid `registry.json` via
 * existing infrastructure — no scaffolding stub, no half-valid file on
 * disk, no PR1 mutation. Rule 2.
 *
 * `--dry-run` reports intent without touching disk.
 *
 * @module
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type CmaConfig,
	defaultConfig,
	defaultConfigPath,
	read as readConfig,
	write as writeConfig,
} from "../config-store.ts";

/** Injectable ports so tests never touch the real fs. */
export type InitPorts = {
	/** Absolute path to `config.json`. Defaults to `defaultConfigPath()`. */
	configPath?: string;
	/** When true, report intent + skip disk writes. */
	dryRun?: boolean;
	/** Info/warn sink. Real CLI wires to `console.log` / `console.warn`. */
	logger: { log: (message: string) => void; warn: (message: string) => void };
	/** `mkdir -p` shape; defaults to `fs.mkdir`. */
	mkdirFn?: (path: string, opts: { recursive: true }) => Promise<unknown>;
	/** Injected config writer. */
	writeConfig?: (path: string | undefined, config: CmaConfig) => Promise<void>;
	/** Injected config reader. */
	readConfig?: (path?: string) => Promise<CmaConfig | undefined>;
};

/** `initCommand` result union. */
export type InitResult =
	| { ok: true; created: boolean; path: string }
	| { ok: false; reason: "write_failed"; detail: string };

/**
 * `cma init` — create `~/.config/claude-multiacct/config.json` if absent.
 *
 * @param {InitPorts} opts - Injected ports; see docstring.
 * @returns {Promise<InitResult>} Success (`created` true/false) or failure.
 */
export async function initCommand(opts: InitPorts): Promise<InitResult> {
	const path = opts.configPath ?? defaultConfigPath();
	const dir = dirname(path);
	const readFn = opts.readConfig ?? readConfig;
	const existing = await readFn(path);
	if (existing !== undefined) {
		opts.logger.log(`cma init: config already exists at ${path} (no-op)`);
		return { ok: true, created: false, path };
	}
	if (opts.dryRun === true) {
		opts.logger.log(`cma init [--dry-run]: would create ${dir}/ and ${path}`);
		return { ok: true, created: false, path };
	}
	const mkdirFn = opts.mkdirFn ?? mkdir;
	const writeFn = opts.writeConfig ?? writeConfig;
	try {
		await mkdirFn(dir, { recursive: true });
		await writeFn(path, defaultConfig());
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: "write_failed", detail };
	}
	opts.logger.log(`cma init: wrote ${path}`);
	opts.logger.log("cma init: registry.json will be bootstrapped on the first `cma account add`.");
	return { ok: true, created: true, path };
}
