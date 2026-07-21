/**
 * `@foundation/claude-multiacct` — `config.json` reader/writer.
 *
 * Complement to PR2's `registry-store.ts` for the SEPARATE `config.json`
 * sidecar. `config.json` holds the shim-enable flag + a few paths the CLI
 * uses to talk to the rest of the pool. `registry.json` still owns the
 * account list; keeping them in two files means a corrupted registry never
 * flips the enable flag, and vice versa.
 *
 * Failure model matches PR2's registry reader: missing → `undefined` (no
 * error), corrupted / schema-invalid → `undefined` + `logger.warn`. Rule 12
 * (fail loud) is served by the warning; Rule 2 (simplicity) is served by
 * not throwing — the CLI reads config on every invocation and a rotted
 * sidecar must not crash `cma --version` or `cma status`.
 *
 * Writes go through `atomicWriteJson` (PR5a) with `0o600` so the file is
 * owner-only. Nothing secret lives in `config.json` today, but future
 * fields (custom endpoints, tokens injected by an enterprise MDM profile)
 * would need it.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { type AtomicWriteFs, atomicWriteJson } from "../http-bridge/atomic-json.ts";

/**
 * `CmaConfig` — the on-disk shape of `config.json`.
 *
 * `strictObject` so an unknown key (`enable:` instead of `enabled:`) fails
 * validation loud instead of being silently ignored.
 */
export const CmaConfigSchema = v.strictObject({
	enabled: v.boolean(),
	logDir: v.pipe(v.string(), v.minLength(1)),
	bridgeJsonPath: v.pipe(v.string(), v.minLength(1)),
	configVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type CmaConfig = v.InferOutput<typeof CmaConfigSchema>;

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 *
 * @param {string} path - Path that may begin with `~`.
 * @returns {string} Absolute path with `~` resolved via `os.homedir()`.
 */
export function expandTilde(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

/**
 * Default on-disk location for the config file.
 *
 * @returns {string} Absolute path — `~/.config/claude-multiacct/config.json`.
 */
export function defaultConfigPath(): string {
	return join(homedir(), ".config", "claude-multiacct", "config.json");
}

/**
 * The default `CmaConfig` used when no config exists yet.
 *
 * @returns {CmaConfig} Defaults: `enabled: false`, logDir + bridgeJsonPath expanded.
 */
export function defaultConfig(): CmaConfig {
	return {
		enabled: false,
		logDir: expandTilde("~/.claude-multiacct/logs"),
		bridgeJsonPath: expandTilde("~/.config/claude-multiacct/bridge.json"),
		configVersion: 1,
	};
}

/** Minimal logger surface — same shape as `RegistryStoreLogger`. */
export type ConfigStoreLogger = { warn: (message: string) => void };

/** Silent no-op logger — exported so tests can pin the default-arg contract. */
export const silentLogger: ConfigStoreLogger = {
	warn: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
};

/** Injectable readFile shape so tests do not need a real fs. */
export type ReadFileFn = (path: string) => Promise<string>;

const defaultReadFile: ReadFileFn = (path) => readFile(path, "utf8");

/**
 * Read + validate `config.json`. Missing file → `undefined`. Corrupted or
 * schema-invalid file → `undefined` + `logger.warn`. Rule 12 loud on the
 * warning; Rule 2 non-fatal because a rotted sidecar must not crash the CLI.
 *
 * @param {string} [path] - Absolute path; defaults to `defaultConfigPath()`.
 * @param {ConfigStoreLogger} [logger] - Warning sink; defaults silent.
 * @param {ReadFileFn} [readFileFn] - Injected reader; defaults to `fs.readFile`.
 * @returns {Promise<CmaConfig | undefined>} Parsed config or `undefined`.
 */
export async function read(
	path: string = defaultConfigPath(),
	logger: ConfigStoreLogger = silentLogger,
	readFileFn: ReadFileFn = defaultReadFile,
): Promise<CmaConfig | undefined> {
	let raw: string;
	try {
		raw = await readFileFn(path);
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return undefined;
		}
		logger.warn(`ConfigStore: unreadable config ${path}: ${String(error)}`);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		logger.warn(`ConfigStore: corrupted config ${path}: ${String(error)}`);
		return undefined;
	}
	const validated = v.safeParse(CmaConfigSchema, parsed);
	if (!validated.success) {
		logger.warn(`ConfigStore: schema-invalid config ${path}: ${validated.issues[0].message}`);
		return undefined;
	}
	return validated.output;
}

/**
 * Read `config.json`, falling back to `defaultConfig()` on missing/invalid.
 *
 * @param {string} [path] - Absolute path; defaults to `defaultConfigPath()`.
 * @param {ConfigStoreLogger} [logger] - Warning sink; defaults silent.
 * @param {ReadFileFn} [readFileFn] - Injected reader; defaults to `fs.readFile`.
 * @returns {Promise<CmaConfig>} Parsed config, or defaults.
 */
export async function readOrDefault(
	path?: string,
	logger?: ConfigStoreLogger,
	readFileFn?: ReadFileFn,
): Promise<CmaConfig> {
	const existing = await read(path, logger, readFileFn);
	return existing ?? defaultConfig();
}

/**
 * Atomically write `config` to disk. Schema-validates BEFORE touching disk
 * so an invalid write never produces a tmp file.
 *
 * @param {string | undefined} pathArg - Absolute path; defaults to `defaultConfigPath()`.
 * @param {CmaConfig} config - Config value to persist.
 * @param {AtomicWriteFs} [fs] - Injected fs surface; defaults to `node:fs/promises`.
 * @returns {Promise<void>} Resolves once the rename has landed.
 */
export async function write(
	pathArg: string | undefined,
	config: CmaConfig,
	fs?: AtomicWriteFs,
): Promise<void> {
	// Validate BEFORE touching disk — an invalid config must never produce a
	// tmp file (mirrors AtomicRegistryWriter.write's validate-first stance).
	v.parse(CmaConfigSchema, config);
	const path = pathArg ?? defaultConfigPath();
	await atomicWriteJson(path, config, 0o600, fs);
}
