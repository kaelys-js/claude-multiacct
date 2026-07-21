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

/**
 * Build the four-step orchestration list bound to real installers.
 *
 * @param {WiringDeps} deps - Logger + env.
 * @returns {readonly OrchestrationStep[]} Steps in canonical order.
 */
function buildSteps(deps: WiringDeps): readonly OrchestrationStep[] {
	const uid = process.getuid?.() ?? 0;
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

	return [stepShim, stepWatcher, stepDaemon, stepExtension];
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
 * @returns {Promise<InstallPorts>} Fully wired.
 */
export function makeRealInstallPorts(deps: WiringDeps): Promise<InstallPorts> {
	return Promise.resolve({
		steps: buildSteps(deps),
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
	return Promise.resolve({
		steps: buildSteps(deps),
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
