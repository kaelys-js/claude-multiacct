/**
 * `@foundation/claude-multiacct` — extension installer (flag-gated).
 *
 * Copies the bundled extension into the React-DevTools-anchor location
 * (`~/Library/Application Support/Google/Chrome/Default/Extensions/
 * fmkadmapgofadopljbjfkapdkoienihi/<version>/`), then symlinks the
 * daemon's `bridge.json` into it so the content script can read the shared
 * secret through `chrome.runtime.getURL`. The RDT anchor is the ID
 * `electron-devtools-installer`'s local fallback probes when the Chrome
 * Web Store is unreachable — the launch wrapper (PR5a) blackholes the CWS
 * hosts so that fallback path is deterministic.
 *
 * The whole install is gated behind `CLAUDE_MULTIACCT_ENABLE_SHIM=1`
 * (same env var as the shim gate) — flag off → zero writes. Idempotent:
 * a re-run on identical inputs returns `{alreadyInstalled: true}` without
 * touching files. Any content change first snapshots the prior contents
 * into `~/.claude-multiacct-backups/<ts>/extension/`.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { FLAG_ENABLED_VALUE, FLAG_ENV_VAR } from "../cli-shim/installer.ts";
import { PACKAGE_VERSION } from "../index.ts";

/**
 * Resolve the effective enable flag. Mirrors the precedence in
 * `cli-shim/installer.ts` resolveGate: an explicit `flag` argument
 * (true or false) always wins; otherwise fall back to the env var.
 *
 * @param {boolean | undefined} explicit - Caller-provided flag.
 * @param {Record<string,string|undefined>} [env] - Env dict override for tests.
 * @returns {boolean} Effective flag.
 */
function resolveFlag(
	explicit: boolean | undefined,
	env?: Record<string, string | undefined>,
): boolean {
	if (explicit !== undefined) {
		return explicit;
	}
	const source = env ?? (process.env as Record<string, string | undefined>);
	return source[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;
}

/** RDT-anchor extension id — matches electron-devtools-installer's fallback. */
export const RDT_ANCHOR_ID = "fmkadmapgofadopljbjfkapdkoienihi";

/**
 * Default install path — the versioned subdir of the RDT anchor under
 * Chrome's Default profile. Versioning by PACKAGE_VERSION so a CLI bump
 * writes to a new subdir instead of clobbering the old one.
 *
 * @returns {string} Absolute path.
 */
export function defaultInstallDir(): string {
	return join(
		homedir(),
		"Library",
		"Application Support",
		"Google",
		"Chrome",
		"Default",
		"Extensions",
		RDT_ANCHOR_ID,
		PACKAGE_VERSION,
	);
}

/**
 * `electron-devtools-installer`'s cache path. Claude bundles that installer;
 * on first launch it fetches the real React DevTools CRX from the Chrome
 * Web Store and unpacks it here (flat, no version subdir). On subsequent
 * launches it prefers this cached unpacked dir over anything else — so if
 * we don't also plant here, our extension is never loaded once the cache
 * is seeded. Live-reproduced 2026-07-21: cached CRX shadowed the Chrome-
 * Default fallback and every relaunch loaded the real RDT instead.
 *
 * We also delete the sibling `.crx` at install time (see `installClaudeCache`)
 * so the installer doesn't re-extract over our plant on next boot. The
 * launch wrapper's `--host-resolver-rules` blackhole prevents a fresh
 * download from ever re-seeding it.
 *
 * @returns {string} Absolute path to the flat cache dir.
 */
export function defaultClaudeCacheDir(): string {
	return join(homedir(), "Library", "Application Support", "Claude", "Extensions", RDT_ANCHOR_ID);
}

/**
 * Absolute path of the sibling `.crx` the installer would re-extract from.
 *
 * @returns {string} Absolute path.
 */
export function defaultClaudeCacheCrxPath(): string {
	return join(
		homedir(),
		"Library",
		"Application Support",
		"Claude",
		"Extensions",
		`${RDT_ANCHOR_ID}.crx`,
	);
}

/** Filesystem subset the installer consumes. Injected for tests. */
export type InstallerFs = {
	mkdir(path: string, opts: { recursive: true }): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: Buffer): Promise<void>;
	rm(path: string, opts?: { force?: boolean; recursive?: boolean }): Promise<void>;
	symlink(target: string, path: string): Promise<void>;
	readlink(path: string): Promise<string>;
	lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean }>;
	access(path: string): Promise<void>;
	cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void>;
};

export type InstallOptions = {
	installDir?: string;
	/**
	 * Second install target — Claude's electron-devtools-installer cache dir.
	 * Populating this is what actually makes the extension load in prod: the
	 * loader prefers its own cache over the Chrome-Default fallback once
	 * seeded. Defaults to `defaultClaudeCacheDir()`; tests override with a
	 * tmp path. Pass `null` to skip (tests that only exercise the Chrome-
	 * Default path).
	 */
	claudeCacheDir?: string | null;
	/**
	 * Path of the sibling `.crx` to delete so the loader doesn't re-extract
	 * over our plant. Defaults to `defaultClaudeCacheCrxPath()`. Pass `null`
	 * to skip (tests).
	 */
	claudeCacheCrxPath?: string | null;
	distDir: string;
	bridgeJsonPath: string;
	fs: InstallerFs;
	/**
	 * Authoritative CLI enable flag. When omitted, falls back to
	 * `process.env.CLAUDE_MULTIACCT_ENABLE_SHIM === "1"` so existing
	 * callers keep their behavior. When passed explicitly (true or false)
	 * it wins over the env-var. Same contract as PR2/PR3/PR5a installers.
	 */
	flag?: boolean;
	/** Env dict override for the `flag` fallback path (tests only). */
	env?: Record<string, string | undefined>;
	/** Backup root (defaults to `~/.claude-multiacct-backups/<ts>/extension`). */
	backupDir?: string;
	log?: (msg: string) => void;
};

export type InstallResult =
	| { skipped: true; reason: string }
	| { installed: true; upgraded: boolean; alreadyInstalled?: false }
	| { installed: false; alreadyInstalled: true };

async function sha256File(fs: InstallerFs, path: string): Promise<string | undefined> {
	try {
		const buf = await fs.readFile(path);
		return createHash("sha256").update(buf).digest("hex");
	} catch {
		return undefined;
	}
}

async function exists(fs: InstallerFs, path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Install (flag-gated). Flag off → `{skipped:true, reason:"flag-off"}`
 * with zero filesystem writes (adversarially tested — mocks fail on any
 * write when the flag is off).
 *
 * @param {InstallOptions} opts - Install inputs.
 * @returns {Promise<InstallResult>} Skipped, freshly installed, upgraded,
 *   or already-installed.
 */
export async function install(opts: InstallOptions): Promise<InstallResult> {
	if (!resolveFlag(opts.flag, opts.env)) {
		return { skipped: true, reason: "flag-off" };
	}
	const installDir = opts.installDir ?? defaultInstallDir();
	// eslint-disable-next-line no-empty-function -- no-op default when the caller doesn't pass a logger
	const log = opts.log ?? ((): void => {});

	const srcManifest = join(opts.distDir, "manifest.json");
	const srcContent = join(opts.distDir, "content.js");
	const dstManifest = join(installDir, "manifest.json");
	const dstContent = join(installDir, "content.js");
	const dstBridge = join(installDir, "bridge.json");

	const [srcManifestHash, srcContentHash, dstManifestHash, dstContentHash] = await Promise.all([
		sha256File(opts.fs, srcManifest),
		sha256File(opts.fs, srcContent),
		sha256File(opts.fs, dstManifest),
		sha256File(opts.fs, dstContent),
	]);

	if (
		srcManifestHash !== undefined &&
		srcManifestHash === dstManifestHash &&
		srcContentHash !== undefined &&
		srcContentHash === dstContentHash
	) {
		// Ensure the symlink is present even on a byte-identical rerun so a
		// user who removed the bridge.json manually can heal by re-running.
		await ensureBridgeSymlink(opts.fs, dstBridge, opts.bridgeJsonPath);
		const { claudeCacheDir, claudeCacheCrxPath } = opts;
		if (claudeCacheDir !== undefined && claudeCacheDir !== null) {
			// Same heal-on-rerun: if the loader cache was wiped or reseeded by
			// an upstream update, re-plant. Reads from disk (not the byte-
			// identical hash cache we already computed) because a plant may
			// have been separately clobbered.
			const manifestBuf = await opts.fs.readFile(srcManifest);
			const contentBuf = await opts.fs.readFile(srcContent);
			await installClaudeCache(
				opts.fs,
				claudeCacheDir,
				claudeCacheCrxPath ?? null,
				manifestBuf,
				contentBuf,
				opts.bridgeJsonPath,
				log,
			);
		}
		return { installed: false, alreadyInstalled: true };
	}

	const upgrading = dstManifestHash !== undefined || dstContentHash !== undefined;

	if (upgrading) {
		const backupRoot =
			opts.backupDir ??
			join(
				homedir(),
				".claude-multiacct-backups",
				new Date().toISOString().replaceAll(/[:.]/gu, "-"),
				"extension",
			);
		await opts.fs.mkdir(backupRoot, { recursive: true });
		if (dstManifestHash !== undefined) {
			await opts.fs.cp(dstManifest, join(backupRoot, "manifest.json"));
		}
		if (dstContentHash !== undefined) {
			await opts.fs.cp(dstContent, join(backupRoot, "content.js"));
		}
		log(`snapshot: ${backupRoot}`);
	}

	await opts.fs.mkdir(installDir, { recursive: true });
	const manifestBuf = await opts.fs.readFile(srcManifest);
	await opts.fs.writeFile(dstManifest, manifestBuf);
	const contentBuf = await opts.fs.readFile(srcContent);
	await opts.fs.writeFile(dstContent, contentBuf);
	await ensureBridgeSymlink(opts.fs, dstBridge, opts.bridgeJsonPath);

	const { claudeCacheDir, claudeCacheCrxPath } = opts;
	if (claudeCacheDir !== undefined && claudeCacheDir !== null) {
		await installClaudeCache(
			opts.fs,
			claudeCacheDir,
			claudeCacheCrxPath ?? null,
			manifestBuf,
			contentBuf,
			opts.bridgeJsonPath,
			log,
		);
	}

	return { installed: true, upgraded: upgrading };
}

/**
 * Plant the extension at Claude's electron-devtools-installer cache path
 * AND remove the sibling `.crx` that would otherwise re-extract over the
 * plant on next Claude launch. This is the load-bearing step for the
 * extension to actually reach the renderer — see `defaultClaudeCacheDir`.
 *
 * Idempotent: writes are unconditional per install call (a bytewise-
 * identical rerun replaces file bytes with the same bytes), but the crx
 * removal is guarded with an existence check so a missing `.crx` is not
 * treated as an error.
 *
 * @param {InstallerFs} fs - Filesystem shim.
 * @param {string} cacheDir - Target dir path.
 * @param {string | null} crxPath - Sibling `.crx` to remove, or null to skip.
 * @param {Buffer} manifestBuf - Manifest bytes to plant.
 * @param {Buffer} contentBuf - Content-script bytes to plant.
 * @param {string} bridgeTarget - Symlink target for `bridge.json`.
 * @param {(msg: string) => void} log - Logger for operator visibility.
 * @returns {Promise<void>}
 */
async function installClaudeCache(
	fs: InstallerFs,
	cacheDir: string,
	crxPath: string | null,
	manifestBuf: Buffer,
	contentBuf: Buffer,
	bridgeTarget: string,
	log: (msg: string) => void,
): Promise<void> {
	await fs.mkdir(cacheDir, { recursive: true });
	await fs.writeFile(join(cacheDir, "manifest.json"), manifestBuf);
	await fs.writeFile(join(cacheDir, "content.js"), contentBuf);
	await ensureBridgeSymlink(fs, join(cacheDir, "bridge.json"), bridgeTarget);
	if (crxPath !== null && (await exists(fs, crxPath))) {
		await fs.rm(crxPath, { force: true });
		log(`removed stale crx: ${crxPath}`);
	}
	log(`planted at claude-cache: ${cacheDir}`);
}

async function ensureBridgeSymlink(
	fs: InstallerFs,
	linkPath: string,
	target: string,
): Promise<void> {
	// Probe with lstat, not access/stat: `access` follows symlinks, so a
	// BROKEN symlink at linkPath (e.g. left by a prior rollback whose daemon
	// bridge.json is now gone) reports ENOENT, the rm is skipped, and the
	// subsequent `fs.symlink` fails EEXIST because a symlink entry still
	// occupies the path. lstat sees the entry regardless of target validity.
	try {
		await fs.lstat(linkPath);
		await fs.rm(linkPath, { force: true });
	} catch {
		// ENOENT (or any other lstat failure) → nothing to remove.
	}
	await fs.symlink(target, linkPath);
}

export type UninstallOptions = {
	installDir?: string;
	claudeCacheDir?: string | null;
	fs: InstallerFs;
	/** See `InstallOptions.flag`. Optional; env-var fallback when omitted. */
	flag?: boolean;
	env?: Record<string, string | undefined>;
};

export type UninstallResult =
	| { skipped: true; reason: string }
	| { removed: true; files: string[] };

/**
 * Uninstall (flag-gated). Removes only the files we created — leaves the
 * install dir if a third party dropped other content in. Cleans up both
 * install targets (Chrome Default anchor + Claude loader-cache anchor)
 * so a subsequent Claude launch reverts to whatever the loader fetches
 * from the network — no orphaned CMA files masquerading as RDT.
 *
 * @param {UninstallOptions} opts - Uninstall inputs.
 * @returns {Promise<UninstallResult>} Skipped or removed.
 */
export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
	if (!resolveFlag(opts.flag, opts.env)) {
		return { skipped: true, reason: "flag-off" };
	}
	const removed: string[] = [];
	const targets: string[] = [opts.installDir ?? defaultInstallDir()];
	if (opts.claudeCacheDir !== undefined && opts.claudeCacheDir !== null) {
		targets.push(opts.claudeCacheDir);
	}
	for (const dir of targets) {
		for (const name of ["manifest.json", "content.js", "bridge.json"]) {
			const path = join(dir, name);
			// eslint-disable-next-line no-await-in-loop -- sequential removal avoids racing concurrent fs ops on the same install dir
			if (await exists(opts.fs, path)) {
				// eslint-disable-next-line no-await-in-loop -- sequential removal avoids racing concurrent fs ops on the same install dir
				await opts.fs.rm(path, { force: true });
				removed.push(path);
			}
		}
	}
	return { removed: true, files: removed };
}

export type StatusOptions = {
	installDir?: string;
	fs: InstallerFs;
};

export type StatusResult = {
	installed: boolean;
	files: string[];
	symlinkValid: boolean;
};

/**
 * Report on the current install. Always allowed — status is a read-only op.
 *
 * @param {StatusOptions} opts - Status inputs.
 * @returns {Promise<StatusResult>} Presence flags + list of present files.
 */
export async function status(opts: StatusOptions): Promise<StatusResult> {
	const installDir = opts.installDir ?? defaultInstallDir();
	const files: string[] = [];
	let symlinkValid = false;
	for (const name of ["manifest.json", "content.js", "bridge.json"]) {
		const path = join(installDir, name);
		// eslint-disable-next-line no-await-in-loop -- sequential status checks avoid racing concurrent fs ops on the same install dir
		if (await exists(opts.fs, path)) {
			files.push(path);
			if (name === "bridge.json") {
				try {
					// eslint-disable-next-line no-await-in-loop -- sequential status checks avoid racing concurrent fs ops on the same install dir
					const st = await opts.fs.lstat(path);
					if (st.isSymbolicLink()) {
						// eslint-disable-next-line no-await-in-loop -- sequential status checks avoid racing concurrent fs ops on the same install dir
						const target = await opts.fs.readlink(path);
						if (target !== "") {
							symlinkValid = true;
						}
					}
				} catch {
					symlinkValid = false;
				}
			}
		}
	}
	return { installed: files.length >= 2, files, symlinkValid };
}
