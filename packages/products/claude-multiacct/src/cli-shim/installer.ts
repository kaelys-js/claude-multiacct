/**
 * `@foundation/claude-multiacct` — CLI-shim installer / uninstaller.
 *
 * The shim binary lives at `.../Claude.app/Contents/Resources/app.asar.unpacked/claude-code/<version>/claude.app/Contents/MacOS/claude`
 * (the CLI Claude Desktop spawns via `disclaimer`). This module owns three
 * ops on that directory:
 *
 *   - `install(cliDir, {shimSourcePath?, force?, overrideFlag?})` — renames
 *     the real CLI to `claude.real`, copies `shimSourcePath` into place as
 *     `claude`, chmods +x, ad-hoc codesigns. Idempotent: a second `install`
 *     on the same dir without `force` is a no-op. When `shimSourcePath` is
 *     omitted, the installer resolves to the bundled shim at
 *     `packages/products/claude-multiacct/dist/shim.js` (produced by
 *     `pnpm build:shim`). Missing default → loud throw (Rule 12).
 *
 *   - `uninstall(cliDir, {overrideFlag?})` — deletes `claude`, restores
 *     `claude.real` back to `claude`. Snapshots the removed shim to
 *     `~/.claude-multiacct-backups/<ts>/` first so the removal is reversible.
 *
 *   - `status(cliDir)` — reports `{installed, hasReal, hasShim}`; ALWAYS
 *     runs regardless of feature flag (read-only).
 *
 * # Feature flag (GATED PR — landing this must not change default behavior)
 *
 * `install` and `uninstall` are BOTH gated on
 * `process.env.CLAUDE_MULTIACCT_ENABLE_SHIM === "1"` OR an explicit
 * `{overrideFlag: true}` option (tests set the latter). When the flag is
 * off, they return `{skipped: true, reason}` and touch nothing. `status`
 * is not gated because reading a directory has no user-visible effect.
 *
 * # Snapshotting
 *
 * Every mutating operation snapshots BOTH `claude` and `claude.real` (if
 * present) into `~/.claude-multiacct-backups/<ISO-timestamp>/` before any
 * write. The snapshot is the reversibility contract: if the shim install
 * goes wrong on a user machine, they can point us at the timestamped dir
 * and get their original CLI back byte-for-byte.
 *
 * # Codesign
 *
 * The shim is ad-hoc signed (`codesign --sign -`) because the parent is
 * Claude Desktop's `disclaimer` launcher, which is libSystem-only and does
 * NOT check developer identity before exec. Injectable via
 * `deps.execFile` so tests never shell out.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const defaultExecFile = promisify(execFile) as unknown as (
	file: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Env-var name that gates every mutating installer op. GATED PR contract. */
export const FLAG_ENV_VAR = "CLAUDE_MULTIACCT_ENABLE_SHIM";
/** Value the flag must equal for mutating ops to run. */
export const FLAG_ENABLED_VALUE = "1";

/** Injected surface — filesystem + process — so tests never hit the real world. */
export type InstallerDeps = {
	execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
	env?: Record<string, string | undefined>;
	backupRoot?: string;
	logger?: { info: (message: string) => void; warn: (message: string) => void };
};

/** Silent no-op logger — exported so tests can pin the default-arg contract. */
export const silentInstallerLogger: {
	info: (message: string) => void;
	warn: (message: string) => void;
} = {
	info: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
	warn: (_message: string) => {
		// intentional no-op — the default when no logger is passed
	},
};

/** Common option flags. */
export type MutateOptions = {
	/** Overwrite an existing installation without complaint. */
	force?: boolean;
	/** Bypass the feature-flag gate. Test-only knob; do not set from prod. */
	overrideFlag?: boolean;
};

/** Skipped-because-flag-off result — every mutating op can return this. */
export type SkippedResult = { skipped: true; reason: string };

/** Successful install result. */
export type InstallResult =
	| { skipped: false; installed: true; alreadyInstalled: boolean; backup: string | undefined }
	| SkippedResult;

/** Successful uninstall result. */
export type UninstallResult =
	| { skipped: false; uninstalled: true; wasInstalled: boolean; backup: string | undefined }
	| SkippedResult;

/** Read-only status — always runs, flag or not. */
export type StatusResult = {
	installed: boolean;
	hasShim: boolean;
	hasReal: boolean;
};

function flagOn(env: Record<string, string | undefined>): boolean {
	return env[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;
}

/**
 * Default snapshot root — `~/.claude-multiacct-backups/`. Exported for tests.
 *
 * @returns {string} Absolute path to the default snapshot root.
 */
export function defaultBackupRoot(): string {
	return join(homedir(), ".claude-multiacct-backups");
}

/**
 * Absolute path to the bundled shim (`dist/shim.js`) shipped alongside this
 * package. `install()` falls back to this when the caller omits
 * `shimSourcePath`, so a downstream consumer never needs to know where the
 * built artifact lives. Exported so tests can pin the resolution rule.
 *
 * The URL literal is package-relative: from `src/cli-shim/installer.ts` up two
 * levels to the package root, then into `dist/`.
 *
 * @returns {string} Absolute filesystem path to `dist/shim.js`.
 */
export function defaultShimSourcePath(): string {
	return fileURLToPath(new URL("../../dist/shim.js", import.meta.url));
}

/**
 * Resolve every optional dep to its concrete default. Kept small + testable.
 *
 * @param {InstallerDeps} deps - The caller-supplied deps (any subset).
 * @returns {object} All deps resolved to concrete values.
 */
function resolveDeps(deps: InstallerDeps): {
	env: Record<string, string | undefined>;
	log: { info: (message: string) => void; warn: (message: string) => void };
	exec: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
	backupRoot: string;
} {
	return {
		env: deps.env ?? (process.env as Record<string, string | undefined>),
		log: deps.logger ?? silentInstallerLogger,
		exec: deps.execFile ?? defaultExecFile,
		backupRoot: deps.backupRoot ?? defaultBackupRoot(),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isoStamp(): string {
	return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

/**
 * Snapshot every present file in `cliDir` (only the two we manage:
 * `claude`, `claude.real`) into `<backupRoot>/<isoStamp>/`. Returns the
 * absolute snapshot dir, or `undefined` if nothing needed backing up.
 *
 * @param {string} cliDir - Absolute path to `Contents/MacOS/`.
 * @param {string} backupRoot - Absolute root for timestamped snapshot dirs.
 * @returns {Promise<string | undefined>} Snapshot dir or `undefined` if nothing to back up.
 */
async function snapshot(cliDir: string, backupRoot: string): Promise<string | undefined> {
	const claudePath = join(cliDir, "claude");
	const realPath = join(cliDir, "claude.real");
	const hasClaude = await exists(claudePath);
	const hasReal = await exists(realPath);
	if (!hasClaude && !hasReal) {
		return undefined;
	}
	const dest = join(backupRoot, isoStamp());
	await mkdir(dest, { recursive: true });
	if (hasClaude) {
		await copyFile(claudePath, join(dest, "claude"));
	}
	if (hasReal) {
		await copyFile(realPath, join(dest, "claude.real"));
	}
	return dest;
}

/**
 * Read the shim state of a `Contents/MacOS/` directory. Read-only — safe to
 * call regardless of feature flag.
 *
 * `installed = hasReal`: the presence of `claude.real` is the reliable
 * signal, because the caller could have swapped the `claude` binary out.
 *
 * @param {string} cliDir - Absolute path to `Contents/MacOS/`.
 * @returns {Promise<StatusResult>} Shim install state for the dir.
 */
export async function status(cliDir: string): Promise<StatusResult> {
	const hasShim = await exists(join(cliDir, "claude"));
	const hasReal = await exists(join(cliDir, "claude.real"));
	return { installed: hasReal, hasShim, hasReal };
}

/**
 * Install the shim into `cliDir`. See module docstring for the full
 * sequence + the flag-gating contract.
 *
 * @param {string} cliDir - Absolute path to `Contents/MacOS/`.
 * @param {{shimSourcePath?: string} & MutateOptions} opts - `shimSourcePath` is
 *   the built shim binary/script to copy in as `claude`; when omitted, falls
 *   back to `defaultShimSourcePath()` (the bundled `dist/shim.js`).
 * @param {InstallerDeps} deps - Injected surface (tests).
 * @returns {Promise<InstallResult>} Skipped result when the flag is off, else the install outcome.
 */
export async function install(
	cliDir: string,
	opts: { shimSourcePath?: string } & MutateOptions,
	deps: InstallerDeps = {},
): Promise<InstallResult> {
	const { env, log, exec, backupRoot } = resolveDeps(deps);

	if (!opts.overrideFlag && !flagOn(env)) {
		const reason = `install: ${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"; refusing to modify ${cliDir} (Rule 12 loud no-op)`;
		log.warn(reason);
		return { skipped: true, reason };
	}

	const shimSourcePath = opts.shimSourcePath ?? defaultShimSourcePath();
	if (!(await exists(shimSourcePath))) {
		throw new Error(
			`install: packaged shim not found at ${shimSourcePath} — run \`pnpm build:shim\` first`,
		);
	}

	const claudePath = join(cliDir, "claude");
	const realPath = join(cliDir, "claude.real");

	const alreadyInstalled = await exists(realPath);
	if (alreadyInstalled && !opts.force) {
		log.info(`install: already installed at ${cliDir}; pass {force:true} to reinstall`);
		return {
			skipped: false,
			installed: true,
			alreadyInstalled: true,
			backup: undefined,
		};
	}

	const backup = await snapshot(cliDir, backupRoot);

	if (alreadyInstalled) {
		// force reinstall — drop the old shim entirely, restore real, then
		// re-run the swap. Simpler than a partial replace and matches uninstall.
		if (await exists(claudePath)) {
			await unlink(claudePath);
		}
		await rename(realPath, claudePath);
	}

	if (!(await exists(claudePath))) {
		throw new Error(
			`install: no CLI binary found at ${claudePath}; nothing to swap. Did you point at the right MacOS/ dir?`,
		);
	}

	await rename(claudePath, realPath);
	await copyFile(shimSourcePath, claudePath);
	await chmod(claudePath, 0o755);
	await exec("codesign", ["--force", "--sign", "-", claudePath]);
	log.info(`install: shim installed at ${cliDir}; backup=${String(backup)}`);

	return { skipped: false, installed: true, alreadyInstalled, backup };
}

/**
 * Uninstall the shim from `cliDir`. Restores `claude.real` → `claude` and
 * snapshots first.
 *
 * @param {string} cliDir - Absolute path to `Contents/MacOS/`.
 * @param {MutateOptions} opts - Standard flag override for tests.
 * @param {InstallerDeps} deps - Injected surface (tests).
 * @returns {Promise<UninstallResult>} Skipped result when the flag is off, else the uninstall outcome.
 */
export async function uninstall(
	cliDir: string,
	opts: MutateOptions = {},
	deps: InstallerDeps = {},
): Promise<UninstallResult> {
	const { env, log, backupRoot } = resolveDeps(deps);

	if (!opts.overrideFlag && !flagOn(env)) {
		const reason = `uninstall: ${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"; refusing to modify ${cliDir}`;
		log.warn(reason);
		return { skipped: true, reason };
	}

	const claudePath = join(cliDir, "claude");
	const realPath = join(cliDir, "claude.real");
	const wasInstalled = await exists(realPath);
	if (!wasInstalled) {
		log.info(`uninstall: nothing to do at ${cliDir}`);
		return { skipped: false, uninstalled: true, wasInstalled: false, backup: undefined };
	}
	const backup = await snapshot(cliDir, backupRoot);
	if (await exists(claudePath)) {
		await unlink(claudePath);
	}
	await rename(realPath, claudePath);
	log.info(`uninstall: restored ${claudePath}; backup=${String(backup)}`);
	return { skipped: false, uninstalled: true, wasInstalled: true, backup };
}
