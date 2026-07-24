/**
 * `@foundation/claude-multiacct` — CLI-shim installer / uninstaller.
 *
 * The shim binary lives at `.../Claude.app/Contents/Resources/app.asar.unpacked/claude-code/<version>/claude.app/Contents/MacOS/claude`
 * (the CLI Claude Desktop spawns via `disclaimer`). This module owns three
 * ops on that directory:
 *
 *   - `install(cliDir, {shimSourcePath?, force?, overrideFlag?})` — renames
 *     the real CLI to `claude.real`, copies `shimSourcePath` into place as
 *     `claude`, chmods +x, ad-hoc codesigns, then sets the macOS `uchg`
 *     immutable flag on BOTH `claude` (the shim) and `claude.real` (the real
 *     binary). Idempotent: a second `install` on the same dir without `force`
 *     is a no-op. When `shimSourcePath` is omitted, the installer resolves to
 *     the bundled shim at `packages/products/claude-multiacct/dist/shim.js`
 *     (produced by `pnpm build:shim`). Missing default → loud throw (Rule 12).
 *
 * # Immutability (the install-race fix — `uchg` on both binaries)
 *
 * Claude Desktop re-materializes its `app.asar.unpacked/claude-code/<version>/`
 * bundle from the packaged asar on every launch. Without a guard, that launch
 * overwrites our planted shim back to the stock CLI before the watcher can heal
 * it — the account switch silently stops working for the first session after an
 * app restart. Setting the `uchg` user-immutable flag on the planted `claude`
 * (and on the renamed `claude.real`) is the fix: the app's re-materialize does
 * a plain write, and macOS refuses to overwrite a `uchg` file, so the shim
 * survives the launch. This is the INTENDED mechanism, not a side effect. The
 * cost is that our own mutating ops (`force` reinstall, `uninstall`) must clear
 * the flag first — `chflags nouchg` — before they can rename or replace either
 * file; both paths below do exactly that. A brand-new Claude version drops a
 * fresh `claude-code/<newver>/` sibling with an unlocked stock CLI, so the
 * watcher's per-version `install()` re-plants AND re-locks the shim there (a
 * lock on the old version's bundle never covers a new one).
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
 * `install` is gated on `process.env.CLAUDE_MULTIACCT_ENABLE_SHIM === "1"`
 * OR an explicit `{overrideFlag: true}` / `{flag: true}` option (tests set
 * the former two). When the gate is off, `install` returns `{skipped: true,
 * reason}` and touches nothing. `status` is not gated because reading a
 * directory has no user-visible effect.
 *
 * `uninstall` is DELIBERATELY NOT gated. You must always be able to remove
 * what is installed: a system whose `config.enabled` is false (or whose env
 * flag is unset) still has a physically-planted, `uchg`-locked shim on disk,
 * and refusing to uninstall it would strand the machine in "disabled but
 * still swapping, and unremovable via the flag". The enable flag gates
 * turning the shim ON, never the ability to take it back off. `uninstall` is
 * a no-op only when there is genuinely nothing installed (`claude.real`
 * absent). Its callers (`cma uninstall`, install rollback) always want the
 * removal to proceed, and the watcher never calls it (its reconcile emits no
 * uninstall actions), so decoupling here changes no other behaviour.
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
import { basename, dirname, join } from "node:path";
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
	/**
	 * Authoritative enable flag from the CLI's `isEnabled({env, config})`
	 * decision, consulted by `install` only (`uninstall` is never gated):
	 *   - `flag: true` → proceed with the install.
	 *   - `flag: false` → skip with reason (behaves exactly like flag-off env).
	 *   - `flag: undefined` (default) → legacy env-var + overrideFlag path.
	 * This lets `cma install` propagate `config.enabled` without requiring
	 * the env var to be set in the calling shell.
	 */
	flag?: boolean;
};

/** Skipped-because-gate-off result — `install` returns this when the flag is off. */
export type SkippedResult = { skipped: true; reason: string };

/** Successful install result. */
export type InstallResult =
	| { skipped: false; installed: true; alreadyInstalled: boolean; backup: string | undefined }
	| SkippedResult;

/**
 * Uninstall result. There is no skipped variant: `uninstall` is not gated, so
 * it always runs — `wasInstalled: false` is the "nothing to remove" outcome.
 * `skipped: false` is retained so a caller can discriminate this from the other
 * subsystems' skippable uninstall results with the same `"skipped" in r` check.
 */
export type UninstallResult = {
	skipped: false;
	uninstalled: true;
	wasInstalled: boolean;
	backup: string | undefined;
};

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
 * Decide whether `install` is gated. Returns `undefined` when it may proceed,
 * or a `SkippedResult` shape when it must skip. Only `install` consults this —
 * `uninstall` is never gated (removal must always be possible).
 *
 * Priority (see `MutateOptions.flag` docstring):
 *   1. `opts.flag !== undefined` → the CLI's authoritative decision wins.
 *   2. otherwise → legacy `overrideFlag || env` gate.
 *
 * @param {MutateOptions} opts - Caller's options.
 * @param {Record<string,string|undefined>} env - Env dict (already resolved).
 * @param {string} cliDir - Target dir, for the reason string.
 * @returns {SkippedResult | undefined} Skip decision, or undefined to proceed.
 */
function resolveGate(
	opts: MutateOptions,
	env: Record<string, string | undefined>,
	cliDir: string,
): SkippedResult | undefined {
	if (opts.flag === true) {
		return undefined;
	}
	if (opts.flag === false) {
		return {
			skipped: true,
			reason: `install: {flag:false} from CLI; refusing to modify ${cliDir}`,
		};
	}
	if (opts.overrideFlag === true || flagOn(env)) {
		return undefined;
	}
	return {
		skipped: true,
		reason: `install: ${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"; refusing to modify ${cliDir}`,
	};
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
 * Resolve the bundled shim path given the URL of the module doing the
 * resolving. Two call contexts, one function:
 *
 *   - **Bundled** — from `dist/cma.js`, `shim.js` sits alongside as a sibling
 *     in the same `dist/` dir (the build emits both there). Return the sibling.
 *   - **Src / dev / tests** — from `src/cli-shim/installer.ts`, walk up two
 *     levels to the package root and into `dist/shim.js`.
 *
 * The original single-literal form (`new URL("../../dist/shim.js", …)`) worked
 * from src but resolved to `packages/products/dist/shim.js` from `dist/cma.js`
 * (one level too high), silently breaking every prod install. Splitting on
 * the caller's parent-dir basename keeps both contexts honest and makes the
 * rule directly testable with a synthesised URL.
 *
 * @param {string} callerUrl - `import.meta.url` of the caller.
 * @returns {string} Absolute filesystem path to the bundled shim.
 */
export function resolveShimSourcePathFrom(callerUrl: string): string {
	const callerPath = fileURLToPath(callerUrl);
	const callerDir = dirname(callerPath);
	if (basename(callerDir) === "dist") {
		return join(callerDir, "shim.js");
	}
	return fileURLToPath(new URL("../../dist/shim.js", callerUrl));
}

/**
 * Absolute path to the bundled shim (`dist/shim.js`) shipped alongside this
 * package. `install()` falls back to this when the caller omits
 * `shimSourcePath`, so a downstream consumer never needs to know where the
 * built artifact lives. Exported so tests can pin the resolution rule.
 *
 * @returns {string} Absolute filesystem path to `dist/shim.js`.
 */
export function defaultShimSourcePath(): string {
	return resolveShimSourcePathFrom(import.meta.url);
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

/**
 * Set the macOS `uchg` user-immutable flag on `path` so Claude Desktop's
 * launch-time bundle re-materialize cannot overwrite it. See the module
 * docstring for why this is the load-bearing mechanism, not a nicety.
 *
 * @param {(file: string, args: readonly string[]) => Promise<{stdout: string; stderr: string}>} exec - Injected `execFile`.
 * @param {string} path - Absolute path to lock.
 * @returns {Promise<void>} Resolves once `chflags uchg` completes.
 */
async function lockImmutable(
	exec: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
	path: string,
): Promise<void> {
	await exec("chflags", ["uchg", path]);
}

/**
 * Clear the `uchg` flag on `path` if it exists, so a rename/replace can touch
 * it. No-op when the file is absent — a mid-install crash may leave only one of
 * the pair, and clearing a flag we never set is harmless.
 *
 * @param {(file: string, args: readonly string[]) => Promise<{stdout: string; stderr: string}>} exec - Injected `execFile`.
 * @param {string} path - Absolute path to unlock.
 * @returns {Promise<void>} Resolves once `chflags nouchg` completes (or is skipped).
 */
async function unlockImmutable(
	exec: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
	path: string,
): Promise<void> {
	if (await exists(path)) {
		await exec("chflags", ["nouchg", path]);
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

	const gate = resolveGate(opts, env, cliDir);
	if (gate !== undefined) {
		log.warn(gate.reason);
		return gate;
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

	if (alreadyInstalled) {
		// A prior install locked both files `uchg`. Clear the flag before any
		// rename/unlink, or the force reinstall below fails on the immutable
		// bit. (See the module docstring — the lock is deliberate.)
		await unlockImmutable(exec, claudePath);
		await unlockImmutable(exec, realPath);
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
	// Lock both so Claude Desktop's launch-time re-materialize cannot overwrite
	// the shim (claude) or the real binary (claude.real). Real must be locked
	// AFTER codesign so the sign write is not itself blocked.
	await lockImmutable(exec, realPath);
	await lockImmutable(exec, claudePath);
	log.info(`install: shim installed + locked at ${cliDir}; backup=${String(backup)}`);

	return { skipped: false, installed: true, alreadyInstalled, backup };
}

/**
 * Uninstall the shim from `cliDir`. Restores `claude.real` → `claude` and
 * snapshots first.
 *
 * NOT gated on the enable flag: removal must always be possible, or a system
 * with `config.enabled: false` (or the env flag unset) would keep a planted,
 * `uchg`-locked shim it could never take back off. See the module docstring.
 * `opts` is accepted for call-site symmetry with `install` but its `flag` /
 * `overrideFlag` no longer influence whether the removal runs.
 *
 * @param {string} cliDir - Absolute path to `Contents/MacOS/`.
 * @param {MutateOptions} _opts - Accepted for symmetry with `install`; ignored.
 * @param {InstallerDeps} deps - Injected surface (tests).
 * @returns {Promise<UninstallResult>} The uninstall outcome (never skipped).
 */
export async function uninstall(
	cliDir: string,
	_opts: MutateOptions = {},
	deps: InstallerDeps = {},
): Promise<UninstallResult> {
	const { log, exec, backupRoot } = resolveDeps(deps);

	const claudePath = join(cliDir, "claude");
	const realPath = join(cliDir, "claude.real");
	const wasInstalled = await exists(realPath);
	if (!wasInstalled) {
		log.info(`uninstall: nothing to do at ${cliDir}`);
		return { skipped: false, uninstalled: true, wasInstalled: false, backup: undefined };
	}
	// Both files were locked `uchg` at install time; clear the flag before the
	// snapshot copy and the restore rename can touch them.
	await unlockImmutable(exec, claudePath);
	await unlockImmutable(exec, realPath);
	const backup = await snapshot(cliDir, backupRoot);
	if (await exists(claudePath)) {
		await unlink(claudePath);
	}
	await rename(realPath, claudePath);
	log.info(`uninstall: restored ${claudePath}; backup=${String(backup)}`);
	return { skipped: false, uninstalled: true, wasInstalled: true, backup };
}
