/**
 * `@foundation/claude-multiacct` — `cma migrate`.
 *
 * Detects leftover artifacts from the OLD bash-based claude-multiacct tool
 * that this TypeScript rewrite replaces. Two modes:
 *
 *   - default (report-only): scans the four artifact categories below and
 *     prints a table. Read-only, safe on any machine.
 *   - `--apply`: after a `y/N` confirmation (`--yes` skips), snapshots
 *     everything to `~/.claude-multiacct-backups/<ts>/migrate/` FIRST,
 *     then performs the cleanup best-effort (per-item failure is logged
 *     but does not stop the pipeline).
 *
 * # The four artifact categories
 *
 *   (a) `~/.config/claude-multiacct/instances.yaml` — old YAML config.
 *       New tool uses `registry.json` + `config.json` instead.
 *   (b) Old launchd agents at `~/Library/LaunchAgents/com.user.claude-
 *       {clone-refresh,sessions-sync,metadata-symlink,primary-patch-refresh}.plist`.
 *   (c) Old mirror clones: any `~/Applications/Claude Account *.app`.
 *   (d) Any in-place patch to `/Applications/Claude.app`:
 *         - `Contents/Resources/app.asar.multiacct-backup` present, OR
 *         - the asar itself contains one of two marker strings.
 *
 * # Rule 1 decision — `ElectronAsarIntegrity` hash recompute
 *
 * The old tool's in-place patch modified `app.asar`; Electron verifies
 * the asar SHA-256 against `Info.plist → ElectronAsarIntegrity → app.asar.hash`
 * at launch. Getting a hash wrong bricks the primary.
 *
 * We choose the SAFE path here: swap the `.multiacct-backup` files back
 * into place (a byte-identical restore) but DO NOT touch `Info.plist`.
 * If the old tool ALSO patched `Info.plist`, our restore leaves the
 * hash pointing at the pristine asar it now matches again; if the old
 * tool DID patch Info.plist to match its patched asar, the user's app
 * will fail signature verification and we tell them plainly to
 * "reinstall Claude Desktop for a guaranteed pristine signature".
 * Rule 12 (fail loud) — do not silently write a possibly-wrong hash.
 *
 * If the `.multiacct-backup` is missing but a marker is still present,
 * we refuse to touch the asar and instruct reinstall.
 *
 * @module
 */

import { join } from "node:path";

/** One detected artifact, from the report scan. */
export type Finding = {
	category: "instances.yaml" | "launchd-agent" | "mirror-clone" | "asar-patch";
	path: string;
	severity: "info" | "warn" | "error";
	fix: string;
};

/** Report shape returned by `scan()`. */
export type MigrateReport = {
	findings: readonly Finding[];
};

/** Minimal fs surface used by scan + apply. Injected for tests. */
export type MigrateFs = {
	exists: (path: string) => Promise<boolean>;
	readDir: (path: string) => Promise<readonly string[]>;
	readFileBytes: (path: string) => Promise<Buffer>;
	rm: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>;
	rename: (src: string, dest: string) => Promise<void>;
	copyFile: (src: string, dest: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
};

/** launchctl wrapper. */
export type LaunchctlPort = {
	bootout: (uid: number, label: string) => Promise<void>;
};

/** Ports for scan + apply. */
export type MigratePorts = {
	fs: MigrateFs;
	launchctl: LaunchctlPort;
	uid: number;
	homedir: string;
	appPath: string;
	backupsRoot: string;
	/**
	 * Interactive confirmation. Real dispatch wires a readline prompt;
	 * tests inject a stub. Only invoked in --apply mode without --yes.
	 */
	confirm: (prompt: string) => Promise<boolean>;
	/** Wall clock for snapshot dir timestamp. */
	now: () => Date;
	logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

/** The four legacy launchd labels the old bash tool installed. */
export const LEGACY_LABELS = [
	"com.user.claude-clone-refresh",
	"com.user.claude-sessions-sync",
	"com.user.claude-metadata-symlink",
	"com.user.claude-primary-patch-refresh",
] as const;

/** Marker strings the old tool injected into `app.asar`. */
export const ASAR_MARKERS = [
	"claude-multiacct-session-propagation",
	"claude-multiacct-rc-enforcer",
] as const;

/**
 * Report-only pass: walk the four categories and enumerate findings.
 *
 * @param {MigratePorts} ports - Injected surface.
 * @returns {Promise<MigrateReport>} Findings (may be empty).
 */
export async function scan(ports: MigratePorts): Promise<MigrateReport> {
	const findings: Finding[] = [];

	// (a) instances.yaml
	const yamlPath = join(ports.homedir, ".config", "claude-multiacct", "instances.yaml");
	if (await ports.fs.exists(yamlPath)) {
		findings.push({
			category: "instances.yaml",
			path: yamlPath,
			severity: "warn",
			fix: "remove — new tool uses registry.json + config.json",
		});
	}

	// (b) legacy launchd agents
	const laDir = join(ports.homedir, "Library", "LaunchAgents");
	for (const label of LEGACY_LABELS) {
		const plistPath = join(laDir, `${label}.plist`);
		// eslint-disable-next-line no-await-in-loop -- small fixed set, sequential is clearest
		if (await ports.fs.exists(plistPath)) {
			findings.push({
				category: "launchd-agent",
				path: plistPath,
				severity: "warn",
				fix: `launchctl bootout gui/$UID/${label} && rm ${plistPath}`,
			});
		}
	}

	// (c) mirror clones under ~/Applications
	const appsDir = join(ports.homedir, "Applications");
	if (await ports.fs.exists(appsDir)) {
		const entries = await ports.fs.readDir(appsDir);
		for (const name of entries) {
			if (name.startsWith("Claude Account ") && name.endsWith(".app")) {
				findings.push({
					category: "mirror-clone",
					path: join(appsDir, name),
					severity: "warn",
					fix: "remove — new tool uses a single unmodified /Applications/Claude.app",
				});
			}
		}
	}

	// (d) asar patch
	const asarPath = join(ports.appPath, "Contents", "Resources", "app.asar");
	const asarBackup = `${asarPath}.multiacct-backup`;
	const hasBackup = await ports.fs.exists(asarBackup);
	let markerHit = false;
	if (await ports.fs.exists(asarPath)) {
		try {
			// Read asar to check for markers. Cap the check at whatever the fs
			// gives us; markers are inline strings so a full-file scan is fine
			// for the O(100MB) asar and this command is rare.
			const buf = await ports.fs.readFileBytes(asarPath);
			for (const marker of ASAR_MARKERS) {
				if (buf.includes(marker)) {
					markerHit = true;
					break;
				}
			}
		} catch {
			// Unreadable asar → skip; user probably doesn't have Claude installed.
		}
	}
	if (hasBackup || markerHit) {
		findings.push({
			category: "asar-patch",
			path: asarPath,
			severity: hasBackup ? "warn" : "error",
			fix: hasBackup
				? "restore app.asar.multiacct-backup → app.asar; verify `codesign -v /Applications/Claude.app` afterwards, reinstall Claude Desktop if it fails"
				: "no pristine backup found — reinstall Claude Desktop to restore Apple signature",
		});
	}

	return { findings };
}

/**
 * Format a `MigrateReport` for the terminal.
 *
 * @param {MigrateReport} report - Scan output.
 * @returns {string} Table-ish text ready for `console.log`.
 */
export function renderReport(report: MigrateReport): string {
	if (report.findings.length === 0) {
		return "cma migrate: no legacy artifacts detected.";
	}
	const lines = ["cma migrate: legacy artifacts detected:"];
	for (const f of report.findings) {
		lines.push(`  [${f.severity}] (${f.category}) ${f.path}`, `      fix: ${f.fix}`);
	}
	return lines.join("\n");
}

/** Options for `apply`. */
export type ApplyOptions = {
	yes: boolean;
};

/** Result of `apply`. */
export type ApplyResult = {
	exitCode: number;
	perItem: ReadonlyArray<{ path: string; ok: boolean; detail?: string }>;
	snapshotDir: string;
};

/**
 * `--apply` cleanup pass. Snapshot everything first, then attempt each
 * removal best-effort.
 *
 * @param {MigratePorts} ports - Injected surface.
 * @param {ApplyOptions} opts - `{yes}` skips the confirmation prompt.
 * @returns {Promise<ApplyResult>} Per-item outcomes + snapshot dir.
 */
export async function apply(ports: MigratePorts, opts: ApplyOptions): Promise<ApplyResult> {
	const { findings } = await scan(ports);
	const perItem: Array<{ path: string; ok: boolean; detail?: string }> = [];
	const snapshotDir = join(
		ports.backupsRoot,
		ports.now().toISOString().replaceAll(/[:.]/gu, "-"),
		"migrate",
	);

	if (findings.length === 0) {
		ports.logger.log(renderReport({ findings }));
		return { exitCode: 0, perItem, snapshotDir };
	}

	ports.logger.log(renderReport({ findings }));
	if (!opts.yes) {
		const ok = await ports.confirm("proceed with --apply? [y/N] ");
		if (!ok) {
			ports.logger.log("cma migrate: aborted");
			return { exitCode: 1, perItem, snapshotDir };
		}
	}

	await ports.fs.mkdir(snapshotDir, { recursive: true });

	for (const f of findings) {
		try {
			// eslint-disable-next-line no-await-in-loop -- sequential apply keeps snapshot ordering predictable
			await applyOne(ports, f, snapshotDir);
			perItem.push({ path: f.path, ok: true });
			// Rule 12 — succeed loud. Print each removal so operators can eyeball
			// what actually happened rather than reading between the lines of the
			// summary. The summary count below still fires (success or failure).
			ports.logger.log(`cma migrate: removed ${f.category} ${f.path}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			perItem.push({ path: f.path, ok: false, detail });
			ports.logger.warn(`cma migrate: ${f.path} failed: ${detail}`);
		}
	}

	const failures = perItem.filter((i) => !i.ok);
	const successes = perItem.length - failures.length;
	ports.logger.log(`cma migrate: ${String(successes)} of ${String(perItem.length)} items removed`);
	if (failures.length > 0) {
		ports.logger.error(
			`cma migrate: ${String(failures.length)} of ${String(perItem.length)} items failed`,
		);
	}
	return {
		exitCode: failures.length === 0 ? 0 : 2,
		perItem,
		snapshotDir,
	};
}

/**
 * Apply the removal for a single finding. Snapshots the target FIRST
 * (mkdir + copy) so `--apply` is reversible from the backup dir.
 *
 * @param {MigratePorts} ports - Injected surface.
 * @param {Finding} f - The finding to act on.
 * @param {string} snapshotDir - Root of this run's snapshot.
 * @returns {Promise<void>} Resolves on completion.
 */
async function applyOne(ports: MigratePorts, f: Finding, snapshotDir: string): Promise<void> {
	if (f.category === "instances.yaml") {
		await snapshotFile(ports, f.path, snapshotDir, "instances.yaml");
		await ports.fs.rm(f.path);
		return;
	}
	if (f.category === "launchd-agent") {
		const label = extractLabel(f.path);
		await snapshotFile(ports, f.path, snapshotDir, `${label}.plist`);
		try {
			await ports.launchctl.bootout(ports.uid, label);
		} catch {
			// Not loaded → fall through and still remove the plist.
		}
		await ports.fs.rm(f.path);
		return;
	}
	if (f.category === "mirror-clone") {
		// Do not snapshot mirror bundles (potentially many GB). Snapshot the
		// bundle's Info.plist as a breadcrumb so the backup dir names each
		// removed clone, then rm the tree.
		const infoPlist = join(f.path, "Contents", "Info.plist");
		if (await ports.fs.exists(infoPlist)) {
			await snapshotFile(ports, infoPlist, snapshotDir, `${sanitize(f.path)}.Info.plist`);
		}
		await ports.fs.rm(f.path, { recursive: true, force: true });
		ports.logger.log(`cma migrate: removed mirror clone ${f.path}`);
		return;
	}
	if (f.category === "asar-patch") {
		await applyAsarRestore(ports, f, snapshotDir);
	}
}

/**
 * Restore the asar from `.multiacct-backup` if present, otherwise refuse
 * loudly and instruct the user to reinstall Claude Desktop. See module
 * docstring for the Rule-1 decision behind not touching Info.plist.
 *
 * @param {MigratePorts} ports - Injected surface.
 * @param {Finding} f - The asar-patch finding.
 * @param {string} snapshotDir - Snapshot dir root.
 * @returns {Promise<void>} Resolves on completion.
 */
async function applyAsarRestore(
	ports: MigratePorts,
	f: Finding,
	snapshotDir: string,
): Promise<void> {
	const asarPath = f.path;
	const asarBackup = `${asarPath}.multiacct-backup`;
	const unpacked = `${asarPath}.unpacked`;
	const unpackedBackup = `${unpacked}.multiacct-backup`;

	if (!(await ports.fs.exists(asarBackup))) {
		throw new Error(
			"asar-patch present but no .multiacct-backup found — reinstall Claude Desktop to restore Apple signature",
		);
	}

	// Snapshot the CURRENT (patched) files first so restore is reversible.
	await snapshotFile(ports, asarPath, snapshotDir, "app.asar.patched");
	await snapshotFile(ports, asarBackup, snapshotDir, "app.asar.multiacct-backup");
	// Move backup back into place.
	await ports.fs.rm(asarPath);
	await ports.fs.rename(asarBackup, asarPath);
	if (await ports.fs.exists(unpackedBackup)) {
		if (await ports.fs.exists(unpacked)) {
			await ports.fs.rm(unpacked, { recursive: true, force: true });
		}
		await ports.fs.rename(unpackedBackup, unpacked);
	}
	ports.logger.log(
		"cma migrate: asar restored from backup. Verify signature with `codesign -v /Applications/Claude.app`; if it fails, reinstall Claude Desktop.",
	);
}

/**
 * Snapshot a single file into `<snapshotDir>/<destName>`.
 *
 * @param {MigratePorts} ports - Injected surface.
 * @param {string} src - Absolute source path.
 * @param {string} snapshotDir - Snapshot root.
 * @param {string} destName - Basename under the snapshot dir.
 * @returns {Promise<void>} Resolves on completion.
 */
async function snapshotFile(
	ports: MigratePorts,
	src: string,
	snapshotDir: string,
	destName: string,
): Promise<void> {
	await ports.fs.mkdir(snapshotDir, { recursive: true });
	await ports.fs.copyFile(src, join(snapshotDir, destName));
}

/**
 * Extract the plist label from a `.../Label.plist` path.
 *
 * @param {string} plistPath - Absolute path.
 * @returns {string} The basename minus `.plist`.
 */
function extractLabel(plistPath: string): string {
	const base = plistPath.split("/").pop() ?? "";
	return base.replace(/\.plist$/u, "");
}

/**
 * Turn a path into a filesystem-safe basename.
 *
 * @param {string} path - Any path.
 * @returns {string} Safe basename.
 */
function sanitize(path: string): string {
	return path.replaceAll(/[^a-zA-Z0-9_.-]/gu, "_");
}
