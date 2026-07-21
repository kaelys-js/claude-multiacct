/* oxlint-disable import/max-dependencies -- this module is the single
   wiring seam that binds PR2 shim + PR3 watcher + PR5a daemon + PR5b
   extension real ports for the bundled bin/cma; consolidating imports
   further would just push the coupling into a re-export shim. */
/**
 * `@foundation/claude-multiacct` — real port factories for PR6b commands.
 *
 * Sits between `dispatch.ts` (which consumes pure ports) and the real
 * installers/fs/launchctl surfaces. Kept in its own module so tests for
 * install/uninstall/launch/migrate never import it — they pass fakes
 * directly. The bundled `bin/cma` entry (see `scripts/build-cli.mjs`)
 * is the sole real caller.
 *
 * Each factory constructs a step list / port bundle by binding the
 * pre-existing PR2/PR3/PR5a/PR5b installers. `install`/`uninstall`
 * step names line up with the module docstrings so log lines carry
 * the same shorthand across commands.
 *
 * Coverage-excluded — see `vitest.config.ts` for the rationale.
 *
 * @module
 */

import { execFile, spawn } from "node:child_process";
import {
	access,
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
	install as installShim,
	status as shimStatus,
	uninstall as uninstallShim,
} from "../cli-shim/installer.ts";
import {
	defaultClaudeCacheCrxPath,
	defaultClaudeCacheDir,
	install as installExtension,
	type InstallerFs as ExtensionFs,
	status as extensionStatus,
	uninstall as uninstallExtension,
} from "../extension/installer.ts";
import {
	installAgent as installDaemon,
	nodeAgentFsPort as daemonFsPort,
	nodeLaunchctlPort as daemonLaunchctlPort,
	statusAgent as daemonStatusAgent,
	uninstallAgent as uninstallDaemon,
} from "../launch/agent-installer.ts";
import { DAEMON_LABEL, renderDaemonPlist } from "../launch/launchd-plist.ts";
import { launchClaude } from "../launch/wrapper.ts";
import {
	installAgent as installWatcher,
	nodeAgentFsPort as watcherFsPort,
	nodeLaunchctlPort as watcherLaunchctlPort,
	statusAgent as watcherStatusAgent,
	uninstallAgent as uninstallWatcher,
} from "../watcher/agent-installer.ts";
import { renderWatcherPlist, WATCHER_LABEL } from "../watcher/launchd-plist.ts";
import type { InstallPorts, OrchestrationStep } from "./commands/install.ts";
import type { InstallerStatusFn } from "./commands/status.ts";
import type { LaunchPorts } from "./commands/launch.ts";
import type { MigrateFs, MigratePorts } from "./commands/migrate.ts";
import type { UninstallPorts } from "./commands/uninstall.ts";
import {
	type CmaConfig,
	defaultConfig,
	defaultConfigPath,
	read as readConfig,
	write as writeConfig,
} from "./config-store.ts";
import type { ParsedArgs } from "./args.ts";
import type { LegacyArtifacts, LegacyCleanupPorts } from "./legacy-cleanup.ts";
import { makeLegacyCleanupStep } from "./legacy-cleanup-step.ts";
import {
	type DeployFs,
	deployAgentScripts,
	type DeployPair,
	undeployAgentScripts,
} from "./deploy-scripts.ts";
import {
	resolveDaemonScriptPath,
	resolveExtensionDistDir,
	resolveWatcherScriptPath,
} from "./dist-paths.ts";

const execFileAsync = promisify(execFile);

type WiringDeps = {
	logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
	env?: Record<string, string | undefined>;
};

/**
 * Absolute path to Claude Desktop's per-user `claude-code/` parent.
 *
 * @returns {string} `~/Library/Application Support/Claude/claude-code`.
 */
function claudeCodeDir(): string {
	return join(homedir(), "Library", "Application Support", "Claude", "claude-code");
}

/**
 * Scan `claude-code/` for `<version>/claude.app/Contents/MacOS` dirs where
 * the shim needs to be installed. Returns absolute paths; a missing parent
 * is treated as an empty scan (the CLI has not launched yet).
 *
 * @returns {Promise<string[]>} List of `Contents/MacOS/` dirs.
 */
async function scanCliDirs(): Promise<string[]> {
	const parent = claudeCodeDir();
	let entries: string[];
	try {
		entries = await readdir(parent);
	} catch {
		return [];
	}
	const dirs: string[] = [];
	for (const entry of entries) {
		const candidate = join(parent, entry, "claude.app", "Contents", "MacOS");
		// eslint-disable-next-line no-await-in-loop -- small fixed set (per-user CLI versions)
		const found = await stat(candidate).catch(() => null);
		if (found !== null && found.isDirectory()) {
			dirs.push(candidate);
		}
	}
	return dirs;
}

type LegacyFlags = {
	purgeLegacy: boolean;
	assumeYes: boolean;
};

/**
 * Derive the legacy-cleanup flags from parsed argv and the env. Both surfaces
 * feed the same booleans so tests can drive either.
 *
 * @param {ParsedArgs | undefined} parsed - Parsed argv from `dispatch`.
 * @param {Record<string, string | undefined> | undefined} env - Environment.
 * @returns {LegacyFlags} Resolved flags.
 */
function resolveLegacyFlags(
	parsed: ParsedArgs | undefined,
	env: Record<string, string | undefined> | undefined,
): LegacyFlags {
	const flags = parsed?.flags ?? {};
	const e = env ?? process.env;
	const purgeLegacy = flags["purge-legacy"] === true || e.CMA_PURGE_LEGACY === "1";
	const assumeYes = flags["yes-i-really-mean-it"] === true || e.CMA_YES_I_REALLY_MEAN_IT === "1";
	return { purgeLegacy, assumeYes };
}

/**
 * Build the five-step orchestration list bound to real installers.
 *
 * @param {WiringDeps} deps - Logger + env.
 * @param {LegacyFlags} legacyFlags - Opt-in flags for the destructive legacy-cleanup step.
 * @returns {readonly OrchestrationStep[]} Steps in canonical order.
 */
function buildSteps(deps: WiringDeps, legacyFlags: LegacyFlags): readonly OrchestrationStep[] {
	const uid = process.getuid?.() ?? 0;
	const stepLegacyCleanup = makeLegacyCleanupStep(realLegacyCleanupPorts(deps), legacyFlags);
	const stepShim: OrchestrationStep = {
		name: "shim",
		install: async (flag) => {
			const dirs = await scanCliDirs();
			if (dirs.length === 0) {
				return {
					ok: true,
					detail: "no claude-code CLI dirs discovered (launch Claude Desktop first)",
				};
			}
			const results = await Promise.all(dirs.map((d) => installShim(d, { flag }, {})));
			const failed = results.some((r) => "skipped" in r && r.skipped);
			return { ok: !failed, detail: `${String(dirs.length)} CLI dir(s)` };
		},
		uninstall: async (flag) => {
			const dirs = await scanCliDirs();
			await Promise.all(dirs.map((d) => uninstallShim(d, { flag }, {})));
			return { ok: true };
		},
	};

	const watcherTarget = join(homedir(), ".claude-multiacct", "watcher.js");
	const daemonTarget = join(homedir(), ".claude-multiacct", "daemon.js");
	const backupsRoot = join(homedir(), ".claude-multiacct-backups");
	const deployPairs = (): readonly DeployPair[] => [
		{
			name: "watcher.js",
			target: watcherTarget,
			source: resolveWatcherScriptPath(import.meta.url),
		},
		{ name: "daemon.js", target: daemonTarget, source: resolveDaemonScriptPath(import.meta.url) },
	];

	const stepWatcher: OrchestrationStep = {
		name: "watcher",
		install: async (flag) => {
			await deployAgentScripts(realDeployFs(), [deployPairs()[0] as DeployPair], {
				backupsRoot,
				now: () => new Date(),
			});
			const body = renderWatcherPlist({
				label: WATCHER_LABEL,
				watchedPath: claudeCodeDir(),
				programArgs: [process.execPath, watcherTarget],
				stdoutPath: join(homedir(), ".claude-multiacct", "logs", "watcher.out.log"),
				stderrPath: join(homedir(), ".claude-multiacct", "logs", "watcher.err.log"),
			});
			const result = await installWatcher({
				launchctl: watcherLaunchctlPort(),
				fs: watcherFsPort(),
				uid,
				plistBody: body,
				flag,
			});
			return { ok: !("skipped" in result && result.skipped) };
		},
		uninstall: async (flag) => {
			await uninstallWatcher({
				launchctl: watcherLaunchctlPort(),
				fs: watcherFsPort(),
				uid,
				flag,
			});
			await undeployAgentScripts(realDeployFs(), [deployPairs()[0] as DeployPair]);
			return { ok: true };
		},
	};

	const stepDaemon: OrchestrationStep = {
		name: "daemon",
		install: async (flag) => {
			await deployAgentScripts(realDeployFs(), [deployPairs()[1] as DeployPair], {
				backupsRoot,
				now: () => new Date(),
			});
			const body = renderDaemonPlist({
				label: DAEMON_LABEL,
				programArgs: [process.execPath, daemonTarget],
				stdoutPath: join(homedir(), ".claude-multiacct", "logs", "daemon.out.log"),
				stderrPath: join(homedir(), ".claude-multiacct", "logs", "daemon.err.log"),
			});
			const result = await installDaemon({
				launchctl: daemonLaunchctlPort(),
				fs: daemonFsPort(),
				uid,
				plistBody: body,
				flag,
			});
			return { ok: !("skipped" in result && result.skipped) };
		},
		uninstall: async (flag) => {
			await uninstallDaemon({
				launchctl: daemonLaunchctlPort(),
				fs: daemonFsPort(),
				uid,
				flag,
			});
			await undeployAgentScripts(realDeployFs(), [deployPairs()[1] as DeployPair]);
			return { ok: true };
		},
	};

	const stepExtension: OrchestrationStep = {
		name: "extension",
		install: async (flag) => {
			const cfg = (await readConfig(defaultConfigPath())) ?? defaultConfig();
			const distDir = resolveExtensionDistDir(import.meta.url);
			const result = await installExtension({
				distDir,
				bridgeJsonPath: cfg.bridgeJsonPath,
				fs: realExtensionFs(),
				flag,
				env: deps.env,
				claudeCacheDir: defaultClaudeCacheDir(),
				claudeCacheCrxPath: defaultClaudeCacheCrxPath(),
			});
			return { ok: !("skipped" in result && result.skipped) };
		},
		uninstall: async (flag) => {
			await uninstallExtension({
				fs: realExtensionFs(),
				flag,
				claudeCacheDir: defaultClaudeCacheDir(),
			});
			return { ok: true };
		},
	};

	return [stepLegacyCleanup, stepShim, stepWatcher, stepDaemon, stepExtension];
}

/**
 * Real fs / launchctl / stdin ports for the legacy-cleanup step.
 *
 * Detection scans:
 *   - `~/Applications/Claude Account *.app`
 *   - `~/Library/LaunchAgents/com.user.claude-*.plist`
 *   - `~/.local/bin/claude-multiacct` (the bash tool's install path)
 *   - `~/Library/Application Support/Claude-*` (mirror stores; excludes our
 *     own `Claude/` dir, which is the primary CLI's home)
 *   - `~/.claude-multiacct/` (only when it lacks the TS system's `daemon.js`
 *     marker — the current TS layout writes daemon.js/watcher.js there, so
 *     we only nuke the dir when it looks pre-TS)
 *
 * Removal: `launchctl unload -w` before `rm` for plists; `rm -rf` elsewhere.
 * `promptConfirm` reads y/n from stdin after writing the summary to stderr.
 *
 * @param {WiringDeps} deps - Logger.
 * @returns {LegacyCleanupPorts} Real port bundle.
 */
function realLegacyCleanupPorts(deps: WiringDeps): LegacyCleanupPorts {
	const home = homedir();
	const appsDir = join(home, "Applications");
	const launchAgentsDir = join(home, "Library", "LaunchAgents");
	const appSupportDir = join(home, "Library", "Application Support");
	const legacyDataDir = join(home, ".claude-multiacct");
	const legacyCliCandidates = [
		join(home, ".local", "bin", "claude-multiacct"),
		"/usr/local/bin/claude-multiacct",
	];
	const knownLaunchdLabels = new Set([
		"com.user.claude-sessions-sync.plist",
		"com.user.claude-clone-refresh.plist",
		"com.user.claude-primary-patch-refresh.plist",
		"com.user.claude-metadata-symlink.plist",
	]);

	return {
		detect: async (): Promise<LegacyArtifacts> => {
			const cloneApps: string[] = [];
			try {
				const entries = await readdir(appsDir);
				for (const e of entries) {
					if (/^Claude Account .+\.app$/u.test(e)) {
						cloneApps.push(join(appsDir, e));
					}
				}
			} catch {
				// no ~/Applications/ or unreadable → nothing to clean
			}
			const launchdPlists: string[] = [];
			try {
				const entries = await readdir(launchAgentsDir);
				for (const e of entries) {
					if (knownLaunchdLabels.has(e)) {
						launchdPlists.push(join(launchAgentsDir, e));
					}
				}
			} catch {
				// no ~/Library/LaunchAgents → nothing to clean
			}
			let legacyCli: string | undefined;
			for (const p of legacyCliCandidates) {
				// eslint-disable-next-line no-await-in-loop -- fixed 2-entry list, sequential probe
				const found = await stat(p).catch(() => null);
				if (found !== null && found.isFile()) {
					legacyCli = p;
					break;
				}
			}
			const mirrorStores: string[] = [];
			try {
				const entries = await readdir(appSupportDir);
				for (const e of entries) {
					// The bash tool creates `Claude-<label>/` dirs; our primary CLI's
					// dir is exactly `Claude/`. Match the hyphenated form only.
					if (/^Claude-.+/u.test(e)) {
						mirrorStores.push(join(appSupportDir, e));
					}
				}
			} catch {
				// no ~/Library/Application Support → nothing to clean
			}
			let legacyDataDirDetected: string | undefined;
			const legacyDataDirStat = await stat(legacyDataDir).catch(() => null);
			if (legacyDataDirStat !== null && legacyDataDirStat.isDirectory()) {
				// Only nuke `~/.claude-multiacct/` when it lacks `daemon.js` — the
				// TS system deploys daemon.js/watcher.js there, so the marker's
				// presence means the dir is the CURRENT TS-system data dir, not
				// a pre-TS bash-tool remnant.
				const marker = await stat(join(legacyDataDir, "daemon.js")).catch(() => null);
				if (marker === null) {
					legacyDataDirDetected = legacyDataDir;
				}
			}
			return {
				cloneApps,
				launchdPlists,
				legacyCli,
				mirrorStores,
				legacyDataDir: legacyDataDirDetected,
			};
		},
		promptConfirm: (summary) => {
			process.stderr.write(`${summary}\n`);
			return new Promise<boolean>((resolve) => {
				const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
				rl.question("", (answer) => {
					rl.close();
					// Case-sensitive PURGE. The word "yes" (or a stray "y") must not
					// count — the previous permissive check enabled the destructive
					// default that motivated this whole gate.
					resolve(answer.trim() === "PURGE");
				});
			});
		},
		removeCloneApp: async (path) => {
			await moveToTrash(path, deps.logger);
		},
		removeLaunchdPlist: async (path) => {
			// launchctl unload is best-effort: an already-unloaded plist yields a
			// non-zero exit that we swallow so the move still runs.
			await execFileAsync("launchctl", ["unload", "-w", path]).catch((error: unknown) => {
				deps.logger.warn(
					`legacy-cleanup: launchctl unload ${path} failed (already unloaded?): ${error instanceof Error ? error.message : String(error)}`,
				);
			});
			await moveToTrash(path, deps.logger);
		},
		removeLegacyCli: async (path) => {
			await moveToTrash(path, deps.logger);
		},
		removeMirrorStore: async (path) => {
			await moveToTrash(path, deps.logger);
		},
		removeLegacyDataDir: async (path) => {
			await moveToTrash(path, deps.logger);
		},
		logger: deps.logger,
	};
}

/**
 * Move a filesystem entry into `~/.Trash/` with an epoch suffix so the user
 * can recover it. Never `rm -rf`. If the source is missing the call is a
 * no-op. If the rename fails (permissions, cross-device — Trash lives on the
 * user's home volume so this is unusual on macOS), the error is thrown so
 * the caller reports it via the outcome's `failed` list.
 *
 * @param {string} src - Absolute path to remove.
 * @param {{ warn: (m: string) => void }} logger - Warning sink.
 * @returns {Promise<void>} Resolves once the move (or no-op) completes.
 */
async function moveToTrash(src: string, logger: { warn: (m: string) => void }): Promise<void> {
	const exists = await stat(src).catch(() => null);
	if (exists === null) {
		return;
	}
	const trashDir = join(homedir(), ".Trash");
	await mkdir(trashDir, { recursive: true });
	const base = src.slice(src.lastIndexOf("/") + 1);
	const dest = join(trashDir, `${base}.${String(Date.now())}`);
	try {
		await rename(src, dest);
	} catch (error) {
		logger.warn(
			`legacy-cleanup: rename ${src} -> ${dest} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		throw error;
	}
}

/**
 * Real fs port for the script deployer, bound to `node:fs/promises`.
 *
 * @returns {DeployFs} Real port.
 */
function realDeployFs(): DeployFs {
	return {
		mkdir: async (path, opts) => {
			await mkdir(path, opts?.recursive === true ? { recursive: true } : undefined);
		},
		lstat: (path) => lstat(path),
		readlink: (path) => readlink(path),
		symlink: (target, path) => symlink(target, path),
		rm: async (path, opts) => {
			await rm(path, opts ?? {});
		},
		copyFile: (src, dest) => copyFile(src, dest),
	};
}

/**
 * Real fs port for the extension installer, bound to `node:fs/promises`.
 *
 * @returns {ExtensionFs} Real port.
 */
function realExtensionFs(): ExtensionFs {
	return {
		mkdir: async (path) => {
			await mkdir(path, { recursive: true });
		},
		readFile: (path) => readFile(path),
		writeFile: async (path, data) => {
			await writeFile(path, data);
		},
		rm: async (path, opts) => {
			await rm(path, opts ?? {});
		},
		symlink: async (target, path) => {
			await symlink(target, path);
		},
		readlink: (path) => readlink(path),
		lstat: (path) => lstat(path),
		access: (path) => access(path),
		cp: (src, dest) => copyFile(src, dest),
	};
}

/**
 * Build the real `InstallPorts` bundle for `cma install`.
 *
 * @param {WiringDeps} deps - Logger + env.
 * @param {ParsedArgs | undefined} parsed - Parsed argv; source of `--purge-legacy` and `--yes-i-really-mean-it`.
 * @returns {Promise<InstallPorts>} Fully wired.
 */
export function makeRealInstallPorts(deps: WiringDeps, parsed?: ParsedArgs): Promise<InstallPorts> {
	return Promise.resolve({
		steps: buildSteps(deps, resolveLegacyFlags(parsed, deps.env)),
		readConfig: () => readConfig(defaultConfigPath()),
		writeConfig: (c: CmaConfig) => writeConfig(defaultConfigPath(), c),
		ensureInit: async () => {
			const existing = await readConfig(defaultConfigPath());
			if (existing === undefined) {
				await mkdir(join(homedir(), ".config", "claude-multiacct"), { recursive: true });
				await writeConfig(defaultConfigPath(), defaultConfig());
			}
		},
		logger: deps.logger,
	});
}

/**
 * Build the real `UninstallPorts` bundle for `cma uninstall`.
 *
 * @param {WiringDeps} deps - Logger + env.
 * @returns {Promise<UninstallPorts>} Fully wired.
 */
export function makeRealUninstallPorts(deps: WiringDeps): Promise<UninstallPorts> {
	// Uninstall never runs the legacy-cleanup step (its `uninstall` handler is a
	// no-op); the flags are irrelevant here — pass the safe default.
	return Promise.resolve({
		steps: buildSteps(deps, { purgeLegacy: false, assumeYes: false }),
		readConfig: () => readConfig(defaultConfigPath()),
		writeConfig: (c: CmaConfig) => writeConfig(defaultConfigPath(), c),
		logger: deps.logger,
	});
}

/**
 * Build the real `LaunchPorts` bundle for `cma launch`.
 *
 * @param {WiringDeps} deps - Logger.
 * @returns {Promise<LaunchPorts>} Fully wired.
 */
export function makeRealLaunchPorts(deps: WiringDeps): Promise<LaunchPorts> {
	return Promise.resolve({
		readConfig: () => readConfig(defaultConfigPath()),
		fs: {
			stat: async (path) => {
				const info = await stat(path);
				return { mtimeMs: info.mtimeMs };
			},
			readFile: (path) => readFile(path, "utf8"),
		},
		pidIsAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		launchClaude: async () => {
			await launchClaude({
				spawnFn: (file, args, options) => {
					spawn(file, [...args], { ...options, detached: true, stdio: "ignore" }).unref();
				},
				env: process.env,
			});
		},
		appPath: "/Applications/Claude.app",
		logger: deps.logger,
	});
}

/**
 * Build the real `MigratePorts` bundle for `cma migrate`.
 *
 * @param {WiringDeps} deps - Logger.
 * @returns {Promise<MigratePorts>} Fully wired.
 */
export function makeRealMigratePorts(deps: WiringDeps): Promise<MigratePorts> {
	const fs: MigrateFs = {
		exists: async (path) => {
			try {
				await stat(path);
				return true;
			} catch {
				return false;
			}
		},
		readDir: (path) => readdir(path),
		readFileBytes: (path) => readFile(path),
		rm: async (path, opts) => {
			await rm(path, opts ?? {});
		},
		rename: (src, dest) => rename(src, dest),
		copyFile: (src, dest) => copyFile(src, dest),
		mkdir: async (path, opts) => {
			await mkdir(path, opts);
		},
	};
	return Promise.resolve({
		fs,
		launchctl: {
			bootout: async (uid, label) => {
				await execFileAsync("launchctl", ["bootout", `gui/${String(uid)}/${label}`]);
			},
		},
		uid: process.getuid?.() ?? 0,
		homedir: homedir(),
		appPath: "/Applications/Claude.app",
		backupsRoot: join(homedir(), ".claude-multiacct-backups"),
		confirm: (prompt) =>
			new Promise<boolean>((resolve) => {
				const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
				rl.question(prompt, (answer) => {
					rl.close();
					resolve(/^y(es)?$/iu.test(answer.trim()));
				});
			}),
		now: () => new Date(),
		logger: deps.logger,
	});
}

/**
 * Bug 7 (PR6b live retry): real installer status port for `cma status` /
 * `cma doctor`. Invokes each subsystem's own `status()` fn — no fresh
 * probing. Composed with the same fs/launchctl ports the install pipeline
 * uses so a running system's live state and the CLI's inspection agree.
 *
 * @returns {import("./commands/status.ts").InstallerStatusFn} Port factory.
 */
export function makeRealInstallerStatusPort(): InstallerStatusFn {
	const uid = process.getuid?.() ?? 0;
	const bridgeJsonPath = join(homedir(), ".config", "claude-multiacct", "bridge.json");
	return async () => {
		// shim: one status per discovered CLI dir.
		const cliDirs = await scanCliDirs();
		const perCliDir = await Promise.all(
			cliDirs.map(async (d) => {
				const s = await shimStatus(d);
				return {
					cliDir: d,
					installed: s.installed,
					hasShim: s.hasShim,
					hasReal: s.hasReal,
				};
			}),
		);
		// watcher agent.
		const w = await watcherStatusAgent({
			launchctl: watcherLaunchctlPort(),
			fs: watcherFsPort(),
			uid,
		});
		// daemon agent + bridge.json sanity.
		const d = await daemonStatusAgent({
			launchctl: daemonLaunchctlPort(),
			fs: daemonFsPort(),
			uid,
		});
		let bridgeJsonExists = false;
		let bridgeJsonPidAlive: boolean | undefined;
		try {
			const raw = await readFile(bridgeJsonPath, "utf8");
			bridgeJsonExists = true;
			try {
				const parsed = JSON.parse(raw) as { pid?: number };
				if (typeof parsed.pid === "number") {
					try {
						process.kill(parsed.pid, 0);
						bridgeJsonPidAlive = true;
					} catch (error) {
						bridgeJsonPidAlive = (error as NodeJS.ErrnoException).code === "EPERM";
					}
				}
			} catch {
				bridgeJsonPidAlive = undefined;
			}
		} catch {
			bridgeJsonExists = false;
		}
		// extension.
		const e = await extensionStatus({ fs: realExtensionFs() });
		return {
			shim: { perCliDir },
			watcher: { plistPath: w.plistPath, plistExists: w.plistExists, loaded: w.loaded },
			daemon: {
				plistPath: d.plistPath,
				plistExists: d.plistExists,
				loaded: d.loaded,
				bridgeJsonExists,
				bridgeJsonPidAlive,
			},
			extension: { installed: e.installed, files: e.files, symlinkValid: e.symlinkValid },
		};
	};
}
