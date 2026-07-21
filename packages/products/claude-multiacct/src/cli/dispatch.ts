/**
 * `@foundation/claude-multiacct` — top-level CLI dispatcher.
 *
 * `dispatchCli` is the sole entry the build-cli.mjs bundle wraps. Splitting
 * it out of the `#!/usr/bin/env node` shim (which lives inline in
 * `scripts/build-cli.mjs`) keeps this file under vitest's `src/**` coverage
 * glob without demanding a test for a two-line shebang wrapper — same
 * pattern as PR2's `shim` bundle vs. `cli-shim/shim.ts` split.
 *
 * PR6a wires: `init`, `account`, `status`, `doctor` (read-only + user-config
 * only). PR6b will add: `install`, `uninstall`, `launch`, `migrate` — same
 * dispatch table, extra cases.
 *
 * @module
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { PACKAGE_VERSION } from "../index.ts";
import { AccountRegistrySchema } from "../domain/registry.ts";
import type { CliPorts } from "./commands.ts";
import { parseArgs, type ParsedArgs } from "./args.ts";
import { defaultConfigPath, read as readConfig } from "./config-store.ts";
import { initCommand } from "./commands/init.ts";
import { type AccountPorts, accountCommand, makeDefaultTokenReader } from "./commands/account.ts";
import {
	collectStatus,
	type ExecFileFn,
	type InstallerStatusFn,
	type InstallerStatusReport,
	nodeExecFilePort,
	renderStatus,
} from "./commands/status.ts";
import { collectDoctor, renderDoctor } from "./commands/doctor.ts";
import { installCommand, type InstallPorts } from "./commands/install.ts";
import { uninstallCommand, type UninstallPorts } from "./commands/uninstall.ts";
import { launchCommand, type LaunchPorts } from "./commands/launch.ts";
import {
	apply as migrateApply,
	scan as migrateScan,
	renderReport,
	type MigratePorts,
} from "./commands/migrate.ts";

/** Injectable IO surface — tests supply mocks; the bundle wires real IO. */
export type DispatchIO = {
	logger: {
		log: (m: string) => void;
		warn: (m: string) => void;
		error: (m: string) => void;
	};
	env: Record<string, string | undefined>;
	stdinIsTty: boolean;
	makeCliPorts: () => Promise<CliPorts>;
	tokenReader?: {
		readTty: (prompt: string) => Promise<string>;
		readStdin: () => Promise<string>;
	};
	/**
	 * PR6b command port factories. When omitted, dispatch builds real
	 * ports lazily on the first invocation of the corresponding command.
	 * Tests inject fakes so they never touch the real machine.
	 */
	makeInstallPorts?: () => Promise<InstallPorts>;
	makeUninstallPorts?: () => Promise<UninstallPorts>;
	makeLaunchPorts?: () => Promise<LaunchPorts>;
	makeMigratePorts?: () => Promise<MigratePorts>;
	/**
	 * PR6b live-retry Bug 7: `cma status`/`cma doctor` invoke this port to
	 * pull real installer status for shim + watcher + daemon + extension.
	 * Bundled `bin/cma` wires the real port from `wiring.ts`; tests inject
	 * a fake. When undefined we fall back to `emptyInstallerStatusPort` —
	 * the "not-installed anywhere" shape — so `cma status` never crashes on
	 * a machine where the CLI is invoked directly with `node --import ...`
	 * (i.e. outside the bundled entry).
	 */
	makeInstallerStatusPort?: () => InstallerStatusFn;
	/**
	 * `cma status`/`cma doctor` shell out to `codesign` + `spctl` on
	 * `/Applications/Claude.app` to read notarization state. Bundled bin/cma
	 * wires the real port; tests inject a fake so the suite never spawns a
	 * real subprocess. When undefined the real port is used lazily.
	 */
	makeStatusExecFile?: () => ExecFileFn;
};

/**
 * "Not installed anywhere" default. Used when `DispatchIO.makeInstallerStatusPort`
 * is undefined. Keeps the tree self-consistent: every field is present so
 * the renderer / doctor classifier don't hit undefined.
 *
 * @returns {InstallerStatusFn} Port returning an empty report.
 */
export function emptyInstallerStatusPort(): InstallerStatusFn {
	// eslint-disable-next-line eslint/require-await -- port signature is async by contract
	return async (): Promise<InstallerStatusReport> => ({
		shim: { perCliDir: [] },
		watcher: { plistPath: "(unknown)", plistExists: false, loaded: false },
		daemon: {
			plistPath: "(unknown)",
			plistExists: false,
			loaded: false,
			bridgeJsonExists: false,
			bridgeJsonPidAlive: undefined,
		},
		extension: { installed: false, files: [], symlinkValid: false },
	});
}

/** Top-level exit codes. */
export const EXIT_OK = 0;
export const EXIT_HELP_OR_UNKNOWN = 1;
export const EXIT_COMMAND_ERROR = 2;

/**
 * Dispatch a parsed argv to a command handler.
 *
 * @param {readonly string[]} argv - argv excluding node + script.
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code.
 */
export async function dispatchCli(argv: readonly string[], io: DispatchIO): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.error !== undefined) {
		io.logger.error(parsed.error);
		return EXIT_HELP_OR_UNKNOWN;
	}
	if (parsed.version) {
		io.logger.log(PACKAGE_VERSION);
		return EXIT_OK;
	}
	if (parsed.command === undefined || parsed.help) {
		io.logger.log(topLevelHelp());
		return parsed.command === undefined ? EXIT_HELP_OR_UNKNOWN : EXIT_OK;
	}
	switch (parsed.command) {
		case "init": {
			return await runInit(parsed, io);
		}
		case "account": {
			return await runAccount(parsed, io);
		}
		case "status": {
			return await runStatus(io);
		}
		case "doctor": {
			return await runDoctor(io);
		}
		case "install": {
			return await runInstall(io);
		}
		case "uninstall": {
			return await runUninstall(io);
		}
		case "launch": {
			return await runLaunch(io);
		}
		case "migrate": {
			return await runMigrate(parsed, io);
		}
		default: {
			// KNOWN_COMMANDS is exhaustive; a fall-through here means a new
			// command was added to args.ts without a dispatch branch — Rule 12
			// makes that loud instead of silently returning "unknown".
			io.logger.error(`cma: '${parsed.command}' has no dispatcher branch (internal bug)`);
			return EXIT_COMMAND_ERROR;
		}
	}
}

/**
 * `cma init` dispatch wrapper.
 *
 * @param {ParsedArgs} parsed - Parsed argv.
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code.
 */
async function runInit(parsed: ParsedArgs, io: DispatchIO): Promise<number> {
	const result = await initCommand({
		dryRun: parsed.flags["dry-run"] === true,
		logger: io.logger,
	});
	if (result.ok) {
		return EXIT_OK;
	}
	return EXIT_COMMAND_ERROR;
}

/**
 * `cma account <sub>` dispatch wrapper.
 *
 * @param {ParsedArgs} parsed - Parsed argv.
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code from the account humaniser.
 */
async function runAccount(parsed: ParsedArgs, io: DispatchIO): Promise<number> {
	const cliPorts = await io.makeCliPorts();
	const tokenReader = io.tokenReader ?? makeDefaultTokenReader();
	const ports: AccountPorts = {
		cliPorts,
		logger: io.logger,
		stdinIsTty: io.stdinIsTty,
		tokenReader,
		env: io.env,
	};
	const result = await accountCommand(parsed, ports);
	return result.exitCode;
}

/**
 * `cma status` dispatch wrapper — read-only.
 *
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} `EXIT_OK` always.
 */
async function runStatus(io: DispatchIO): Promise<number> {
	const report = await collectStatus(await buildStatusPorts(io));
	io.logger.log(renderStatus(report));
	return EXIT_OK;
}

/**
 * `cma doctor` dispatch wrapper — read-only.
 *
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} `EXIT_OK` when no error-tier findings, else `EXIT_COMMAND_ERROR`.
 */
async function runDoctor(io: DispatchIO): Promise<number> {
	const { findings } = await collectDoctor(await buildStatusPorts(io));
	io.logger.log(renderDoctor(findings));
	if (findings.some((f) => f.tier === "error")) {
		return EXIT_COMMAND_ERROR;
	}
	return EXIT_OK;
}

/**
 * Assemble the status/doctor read-only port bundle.
 *
 * @param {DispatchIO} io - Injected IO ports (used only for warnings).
 * @returns {Promise<Parameters<typeof collectStatus>[0]>} Port bundle for `collectStatus`.
 */
async function buildStatusPorts(io: DispatchIO): Promise<Parameters<typeof collectStatus>[0]> {
	const configPath = defaultConfigPath();
	const config = await readConfig(configPath, {
		warn: (m) => {
			io.logger.warn(m);
		},
	});
	const registryPath = join(homedir(), ".config", "claude-multiacct", "registry.json");
	let registry: Awaited<Parameters<typeof collectStatus>[0]["registry"]> = undefined;
	try {
		const raw = await readFile(registryPath, "utf8");
		const parsedJson: unknown = JSON.parse(raw);
		const parsed = v.safeParse(AccountRegistrySchema, parsedJson);
		if (parsed.success) {
			registry = parsed.output;
		} else {
			io.logger.warn(`registry.json: schema-invalid: ${parsed.issues[0].message}`);
		}
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") {
			io.logger.warn(`registry.json: ${String(error)}`);
		}
	}
	// Bug 7 (PR6b live retry): wire real installer status (shim + watcher
	// + daemon + extension) when the caller supplied a factory; fall back
	// to the empty-shape port so a direct `node --import` invocation doesn't
	// crash on undefined.
	const installerStatus = (io.makeInstallerStatusPort ?? emptyInstallerStatusPort)();
	return {
		configPath,
		config,
		registryPath,
		registry,
		appPath: "/Applications/Claude.app",
		execFile: (io.makeStatusExecFile ?? nodeExecFilePort)(),
		installerStatus,
	};
}

/**
 * `cma install` dispatch wrapper.
 *
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code from the install pipeline.
 */
async function runInstall(io: DispatchIO): Promise<number> {
	if (io.makeInstallPorts === undefined) {
		io.logger.error(
			"cma install: no port factory wired; the bundled CLI supplies this — under `node --import ...` you must inject makeInstallPorts",
		);
		return EXIT_COMMAND_ERROR;
	}
	const ports = await io.makeInstallPorts();
	const result = await installCommand(ports);
	return result.exitCode;
}

/**
 * `cma uninstall` dispatch wrapper.
 *
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code.
 */
async function runUninstall(io: DispatchIO): Promise<number> {
	if (io.makeUninstallPorts === undefined) {
		io.logger.error("cma uninstall: no port factory wired");
		return EXIT_COMMAND_ERROR;
	}
	const ports = await io.makeUninstallPorts();
	const result = await uninstallCommand(ports);
	return result.exitCode;
}

/**
 * `cma launch` dispatch wrapper.
 *
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code.
 */
async function runLaunch(io: DispatchIO): Promise<number> {
	if (io.makeLaunchPorts === undefined) {
		io.logger.error("cma launch: no port factory wired");
		return EXIT_COMMAND_ERROR;
	}
	const ports = await io.makeLaunchPorts();
	const result = await launchCommand(ports);
	return result.exitCode;
}

/**
 * `cma migrate` dispatch wrapper. `--apply` opts into the cleanup pass;
 * without `--apply` it is a report-only scan.
 *
 * @param {ParsedArgs} parsed - Parsed argv (for --apply / --yes flags).
 * @param {DispatchIO} io - Injected IO ports.
 * @returns {Promise<number>} Exit code.
 */
async function runMigrate(parsed: ParsedArgs, io: DispatchIO): Promise<number> {
	if (io.makeMigratePorts === undefined) {
		io.logger.error("cma migrate: no port factory wired");
		return EXIT_COMMAND_ERROR;
	}
	const ports = await io.makeMigratePorts();
	const applyMode = parsed.flags.apply === true;
	if (!applyMode) {
		const report = await migrateScan(ports);
		io.logger.log(renderReport(report));
		return EXIT_OK;
	}
	const result = await migrateApply(ports, { yes: parsed.flags.yes === true });
	return result.exitCode;
}

/**
 * Top-level `--help` text. Kept short so tests can pin every command name.
 *
 * @returns {string} Newline-joined help block, printed to stdout.
 */
export function topLevelHelp(): string {
	return [
		`cma v${PACKAGE_VERSION} — claude-multiacct CLI`,
		"",
		"Usage: cma <command> [flags]",
		"",
		"Commands:",
		"  init              create ~/.config/claude-multiacct/ and write default config.json",
		"  account add       add a pooled OAuth account (interactive token prompt)",
		"  account list      list pooled accounts",
		"  account verify    re-verify a pooled account against its stored token",
		"  account remove    remove a pooled account",
		"  account refresh   refresh the OAuth tokens for a pooled account",
		"  account set-primary   promote a pooled account to primary",
		"  install           flip config.enabled=true and install shim + agents + extension",
		"  uninstall         reverse `cma install` (best-effort, per-step)",
		"  launch            spawn Claude.app after verifying daemon is alive",
		"  migrate           detect + optionally clean up leftover OLD bash-tool artifacts",
		"  status            print current pool + Claude.app status (read-only)",
		"  doctor            classify status fields with fix suggestions (read-only)",
		"",
		"Flags:",
		"  --help, -h        show this help",
		"  --version, -V     print version and exit",
		"  --dry-run         report intent without touching disk (init only in PR6a)",
		"  --apply           for `cma migrate`: perform the cleanup (default is report-only)",
		"  --yes             for `cma migrate --apply`: skip the y/N confirmation",
		"",
		"Security: --token is NOT accepted on the command line. Tokens are read",
		"interactively (TTY, hidden echo) or via `--stdin` when piping.",
	].join("\n");
}
