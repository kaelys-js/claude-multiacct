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
import { PACKAGE_VERSION } from "../index.ts";

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
	distDir: string;
	bridgeJsonPath: string;
	fs: InstallerFs;
	/** Flag value. When false, install/uninstall no-op. */
	flag: boolean;
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
	if (!opts.flag) {
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

	return { installed: true, upgraded: upgrading };
}

async function ensureBridgeSymlink(
	fs: InstallerFs,
	linkPath: string,
	target: string,
): Promise<void> {
	if (await exists(fs, linkPath)) {
		await fs.rm(linkPath, { force: true });
	}
	await fs.symlink(target, linkPath);
}

export type UninstallOptions = {
	installDir?: string;
	fs: InstallerFs;
	flag: boolean;
};

export type UninstallResult =
	| { skipped: true; reason: string }
	| { removed: true; files: string[] };

/**
 * Uninstall (flag-gated). Removes only the files we created — leaves the
 * install dir if a third party dropped other content in.
 *
 * @param {UninstallOptions} opts - Uninstall inputs.
 * @returns {Promise<UninstallResult>} Skipped or removed.
 */
export async function uninstall(opts: UninstallOptions): Promise<UninstallResult> {
	if (!opts.flag) {
		return { skipped: true, reason: "flag-off" };
	}
	const installDir = opts.installDir ?? defaultInstallDir();
	const removed: string[] = [];
	for (const name of ["manifest.json", "content.js", "bridge.json"]) {
		const path = join(installDir, name);
		// eslint-disable-next-line no-await-in-loop -- sequential removal avoids racing concurrent fs ops on the same install dir
		if (await exists(opts.fs, path)) {
			// eslint-disable-next-line no-await-in-loop -- sequential removal avoids racing concurrent fs ops on the same install dir
			await opts.fs.rm(path, { force: true });
			removed.push(path);
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
