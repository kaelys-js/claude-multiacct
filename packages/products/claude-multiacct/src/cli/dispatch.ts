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
import { collectStatus, nodeExecFilePort, renderStatus } from "./commands/status.ts";
import { collectDoctor, renderDoctor } from "./commands/doctor.ts";

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
};

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
		default: {
			// PR6b commands aren't wired here in PR6a; parseArgs recognises the
			// names so they don't hit the "unknown command" branch, but the
			// dispatcher rejects them with a "not yet wired" message.
			io.logger.error(`cma: '${parsed.command}' lands in PR6b — not available yet`);
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
	return {
		configPath,
		config,
		registryPath,
		registry,
		appPath: "/Applications/Claude.app",
		execFile: nodeExecFilePort(),
	};
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
		"  status            print current pool + Claude.app status (read-only)",
		"  doctor            classify status fields with fix suggestions (read-only)",
		"",
		"Flags:",
		"  --help, -h        show this help",
		"  --version, -V     print version and exit",
		"  --dry-run         report intent without touching disk (init only in PR6a)",
		"",
		"Security: --token is NOT accepted on the command line. Tokens are read",
		"interactively (TTY, hidden echo) or via `--stdin` when piping.",
	].join("\n");
}
