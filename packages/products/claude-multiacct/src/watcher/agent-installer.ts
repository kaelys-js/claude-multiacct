/**
 * `@foundation/claude-multiacct` — install / uninstall / status for the
 * launchd `WatchPaths` agent that re-applies the CLI shim after Claude
 * Desktop drops a new claude-code sibling on version bump.
 *
 * Shape mirrors PR2's `installer.ts` deliberately: a `LaunchctlPort` + narrow
 * `AgentFsPort` are injected, `installAgent` / `uninstallAgent` are BOTH
 * gated on `CLAUDE_MULTIACCT_ENABLE_SHIM=1` (or `{overrideFlag:true}` for
 * tests), and `statusAgent` is a read-only inspection that ignores the flag.
 * Every mutating op snapshots the existing plist to
 * `~/.claude-multiacct-backups/<ts>/` before writing.
 *
 * Idempotence contract: a second `installAgent` with a byte-identical body is
 * a no-op; a changed body triggers snapshot + rewrite + reload (`bootout`
 * then `bootstrap`). This matches launchd's requirement that a plist change
 * be reloaded to take effect.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FLAG_ENABLED_VALUE, FLAG_ENV_VAR } from "../cli-shim/installer.ts";
import { WATCHER_LABEL } from "./launchd-plist.ts";

const defaultExecFile = promisify(execFile) as unknown as (
	file: string,
	args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Narrow interface over `launchctl`. Real impl spawns the binary; tests stub. */
export type LaunchctlPort = {
	bootstrap: (uid: number, plistPath: string) => Promise<void>;
	bootout: (uid: number, label: string) => Promise<void>;
	print: (uid: number, label: string) => Promise<{ loaded: boolean }>;
};

/**
 * Real `LaunchctlPort` binding. The `execFile` shell surface is injectable so
 * tests can exercise the bootstrap / bootout / print wiring without spawning
 * the real `launchctl` and mutating the caller's launchd state.
 *
 * @param {object} [deps] - Optional dep injection.
 * @param {Function} [deps.execFile] - Promisified execFile stand-in.
 * @returns {LaunchctlPort} A port that shells out to `/bin/launchctl`.
 */
export function nodeLaunchctlPort(
	deps: {
		execFile?: (
			file: string,
			args: readonly string[],
		) => Promise<{ stdout: string; stderr: string }>;
	} = {},
): LaunchctlPort {
	const exec = deps.execFile ?? defaultExecFile;
	return {
		bootstrap: async (uid, plistPath) => {
			await exec("launchctl", ["bootstrap", `gui/${String(uid)}`, plistPath]);
		},
		bootout: async (uid, label) => {
			await exec("launchctl", ["bootout", `gui/${String(uid)}/${label}`]);
		},
		print: async (uid, label) => {
			try {
				await exec("launchctl", ["print", `gui/${String(uid)}/${label}`]);
				return { loaded: true };
			} catch {
				return { loaded: false };
			}
		},
	};
}

/** Narrow async fs surface used by the agent installer. */
export type AgentFsPort = {
	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, data: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: true }) => Promise<void>;
	rm: (path: string) => Promise<void>;
	copyFile: (src: string, dest: string) => Promise<void>;
	exists: (path: string) => Promise<boolean>;
};

/**
 * Real `AgentFsPort` binding.
 *
 * @returns {AgentFsPort} A port that hits real `node:fs/promises`.
 */
export function nodeAgentFsPort(): AgentFsPort {
	return {
		readFile: (p) => readFile(p, "utf8"),
		writeFile: (p, d) => writeFile(p, d, "utf8"),
		mkdir: async (p, o) => {
			await mkdir(p, o);
		},
		rm: (p) => unlink(p),
		copyFile: (src, dest) => copyFile(src, dest),
		exists: async (p) => {
			try {
				await stat(p);
				return true;
			} catch {
				return false;
			}
		},
	};
}

type BaseOpts = {
	launchctl: LaunchctlPort;
	fs: AgentFsPort;
	uid: number;
	plistDir?: string;
	backups?: string;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
	/**
	 * Authoritative CLI enable flag (`isEnabled({env, config})`).
	 * `true` → proceed; `false` → skip (like flag-off env); `undefined` →
	 * fall back to `overrideFlag` / env-var. See `cli-shim/installer.ts`
	 * MutateOptions for the shared contract.
	 */
	flag?: boolean;
	log?: (m: string) => void;
};

/** Options for `installAgent`. `plistBody` is the caller-rendered XML. */
export type InstallAgentOpts = BaseOpts & { plistBody: string };

/** Options for `uninstallAgent`. */
export type UninstallAgentOpts = BaseOpts;

/** Options for `statusAgent`. Never gated. */
export type StatusAgentOpts = {
	launchctl: LaunchctlPort;
	fs: AgentFsPort;
	uid: number;
	plistDir?: string;
};

/** Result shape for `installAgent`. */
export type InstallAgentResult =
	| { skipped: true; reason: string }
	| {
			skipped: false;
			wrote: boolean;
			reloaded: boolean;
			backup: string | undefined;
	  };

/** Result shape for `uninstallAgent`. */
export type UninstallAgentResult =
	| { skipped: true; reason: string }
	| { skipped: false; removed: boolean; backup: string | undefined };

/** Result shape for `statusAgent`. */
export type StatusAgentResult = {
	plistExists: boolean;
	loaded: boolean;
	plistPath: string;
};

const silentLog: (m: string) => void = (_m: string) => {
	// intentional no-op — the default when no logger is passed
};

/**
 * Default plist directory. Exported so tests can pin the path convention.
 *
 * @returns {string} Absolute path to `~/Library/LaunchAgents`.
 */
export function defaultPlistDir(): string {
	return join(homedir(), "Library", "LaunchAgents");
}

/**
 * Default snapshot root. Exported so tests can pin the path convention.
 *
 * @returns {string} Absolute path to `~/.claude-multiacct-backups`.
 */
export function defaultBackupsRoot(): string {
	return join(homedir(), ".claude-multiacct-backups");
}

function flagOn(env: Record<string, string | undefined>): boolean {
	return env[FLAG_ENV_VAR] === FLAG_ENABLED_VALUE;
}

/**
 * Shared gate resolver. See `cli-shim/installer.ts` resolveGate for the
 * precedence (`opts.flag` beats overrideFlag+env). Returns `undefined` to
 * proceed, or a `{skipped:true, reason}` shape to short-circuit.
 *
 * @param {"installAgent" | "uninstallAgent"} verb - Verb for reason string.
 * @param {BaseOpts} opts - Caller opts.
 * @param {Record<string,string|undefined>} env - Env dict.
 * @returns {{skipped:true, reason:string} | undefined} Skip decision.
 */
function resolveAgentGate(
	verb: "installAgent" | "uninstallAgent",
	opts: BaseOpts,
	env: Record<string, string | undefined>,
): { skipped: true; reason: string } | undefined {
	if (opts.flag === true) {
		return undefined;
	}
	if (opts.flag === false) {
		return {
			skipped: true,
			reason: `${verb}: {flag:false} from CLI; refusing to modify LaunchAgents`,
		};
	}
	if (opts.overrideFlag === true || flagOn(env)) {
		return undefined;
	}
	return {
		skipped: true,
		reason: `${verb}: ${FLAG_ENV_VAR} is not "${FLAG_ENABLED_VALUE}"; refusing to modify LaunchAgents`,
	};
}

function isoStamp(): string {
	return new Date().toISOString().replaceAll(/[:.]/gu, "-");
}

/**
 * Absolute path of the plist file inside `plistDir`.
 *
 * @param {string} plistDir - LaunchAgents directory.
 * @returns {string} Absolute plist path.
 */
function plistPathFor(plistDir: string): string {
	return join(plistDir, `${WATCHER_LABEL}.plist`);
}

/**
 * Install (or reload) the watcher launchd agent. See module docstring for the
 * idempotency + snapshot rules.
 *
 * @param {InstallAgentOpts} opts - Fully-explicit deps + `plistBody`.
 * @returns {Promise<InstallAgentResult>} Skipped when flag off, else write outcome.
 */
export async function installAgent(opts: InstallAgentOpts): Promise<InstallAgentResult> {
	const env = opts.env ?? (process.env as Record<string, string | undefined>);
	const log = opts.log ?? silentLog;
	const gate = resolveAgentGate("installAgent", opts, env);
	if (gate !== undefined) {
		log(gate.reason);
		return gate;
	}
	const plistDir = opts.plistDir ?? defaultPlistDir();
	const backupsRoot = opts.backups ?? defaultBackupsRoot();
	const plistPath = plistPathFor(plistDir);

	await opts.fs.mkdir(plistDir, { recursive: true });

	const alreadyPresent = await opts.fs.exists(plistPath);
	if (alreadyPresent) {
		const existing = await opts.fs.readFile(plistPath);
		if (existing === opts.plistBody) {
			log(`installAgent: unchanged (${plistPath})`);
			return { skipped: false, wrote: false, reloaded: false, backup: undefined };
		}
		const backupDir = join(backupsRoot, isoStamp());
		await opts.fs.mkdir(backupDir, { recursive: true });
		await opts.fs.copyFile(plistPath, join(backupDir, `${WATCHER_LABEL}.plist`));
		await opts.fs.writeFile(plistPath, opts.plistBody);
		try {
			await opts.launchctl.bootout(opts.uid, WATCHER_LABEL);
		} catch {
			// Not currently loaded — that's fine, we still bootstrap below.
		}
		await opts.launchctl.bootstrap(opts.uid, plistPath);
		log(`installAgent: rewrote + reloaded (${plistPath})`);
		return { skipped: false, wrote: true, reloaded: true, backup: backupDir };
	}

	await opts.fs.writeFile(plistPath, opts.plistBody);
	await opts.launchctl.bootstrap(opts.uid, plistPath);
	log(`installAgent: installed (${plistPath})`);
	return { skipped: false, wrote: true, reloaded: false, backup: undefined };
}

/**
 * Uninstall the watcher launchd agent. Snapshots first, then bootout + rm.
 *
 * @param {UninstallAgentOpts} opts - Deps.
 * @returns {Promise<UninstallAgentResult>} Skipped when flag off.
 */
export async function uninstallAgent(opts: UninstallAgentOpts): Promise<UninstallAgentResult> {
	const env = opts.env ?? (process.env as Record<string, string | undefined>);
	const log = opts.log ?? silentLog;
	const gate = resolveAgentGate("uninstallAgent", opts, env);
	if (gate !== undefined) {
		log(gate.reason);
		return gate;
	}
	const plistDir = opts.plistDir ?? defaultPlistDir();
	const backupsRoot = opts.backups ?? defaultBackupsRoot();
	const plistPath = plistPathFor(plistDir);

	if (!(await opts.fs.exists(plistPath))) {
		log(`uninstallAgent: nothing to do (${plistPath})`);
		return { skipped: false, removed: false, backup: undefined };
	}
	const backupDir = join(backupsRoot, isoStamp());
	await opts.fs.mkdir(backupDir, { recursive: true });
	await opts.fs.copyFile(plistPath, join(backupDir, `${WATCHER_LABEL}.plist`));
	try {
		await opts.launchctl.bootout(opts.uid, WATCHER_LABEL);
	} catch {
		// Not currently loaded — file removal is still the right thing to do.
	}
	await opts.fs.rm(plistPath);
	log(`uninstallAgent: removed (${plistPath})`);
	return { skipped: false, removed: true, backup: backupDir };
}

/**
 * Report whether the plist file exists and whether launchd currently holds
 * the agent. Read-only — ignores the feature flag.
 *
 * @param {StatusAgentOpts} opts - Deps.
 * @returns {Promise<StatusAgentResult>} Composite state.
 */
export async function statusAgent(opts: StatusAgentOpts): Promise<StatusAgentResult> {
	const plistDir = opts.plistDir ?? defaultPlistDir();
	const plistPath = plistPathFor(plistDir);
	const plistExists = await opts.fs.exists(plistPath);
	const { loaded } = await opts.launchctl.print(opts.uid, WATCHER_LABEL);
	return { plistExists, loaded, plistPath };
}
