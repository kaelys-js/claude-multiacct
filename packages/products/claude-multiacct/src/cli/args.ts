/**
 * `@foundation/claude-multiacct` — handmade CLI argv parser.
 *
 * A ~50-line long-form flag parser rather than a `commander` / `yargs`
 * dependency — Rule 2 (simplicity). The CLI's arg surface is small:
 * one command, sometimes a subcommand, positionals, long-form flags,
 * plus `--help` / `--version` at any level.
 *
 * # Security invariant: `--token` is rejected AT the parser
 *
 * OAuth tokens must NEVER appear on `process.argv`: on macOS `ps` renders
 * argv to any local user, so a passed `--token=<value>` would leak a
 * bearer secret to every process on the machine. This parser rejects
 * `--token` (with or without a value) with a helpful error pointing at
 * the interactive prompt / `--stdin` alternative. Rule 12 (fail loud);
 * adversarial test in `args.test.ts` — allow `--token` at the parser
 * and that test goes red.
 *
 * @module
 */

/** The parsed shape every command consumes. */
export type ParsedArgs = {
	command?: string;
	subcommand?: string;
	positional: string[];
	flags: Record<string, string | boolean>;
	help: boolean;
	version: boolean;
	/** Set on parse failure — caller prints to stderr and exits non-zero. */
	error?: string;
};

/**
 * Every command name the CLI recognises. Unknown top-level commands are
 * rejected with `help: true`. PR6a implements a subset; PR6b flips the
 * remaining ones on. Listing them ALL here means the "unknown command"
 * path is the same in either PR.
 */
const KNOWN_COMMANDS = new Set([
	"init",
	"account",
	"status",
	"doctor",
	"install",
	"uninstall",
	"launch",
	"migrate",
]);

/** Commands that take a subcommand as their second positional. */
const SUBCOMMAND_COMMANDS = new Set(["account"]);

/**
 * Parse `argv` (without the `node`/`script` prefix). See module docstring
 * for the security invariant around `--token`.
 *
 * @param {readonly string[]} argv - Args to parse, e.g. `process.argv.slice(2)`.
 * @returns {ParsedArgs} Parsed shape, or an `error` on rejection.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	let help = false;
	let version = false;
	let command: string | undefined;
	let subcommand: string | undefined;

	for (const arg of argv) {
		// SECURITY: reject `--token` on argv. Enforced at parse-time so no
		// downstream command can silently accept it.
		if (arg === "--token" || arg.startsWith("--token=")) {
			return {
				positional: [],
				flags: {},
				help: false,
				version: false,
				error:
					"cma: --token is not accepted on the command line for security reasons (it would leak to `ps`). Use the interactive prompt or pipe via --stdin.",
			};
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--version" || arg === "-V") {
			version = true;
		} else if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq >= 0) {
				flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else {
				flags[arg.slice(2)] = true;
			}
		} else if (command === undefined) {
			command = arg;
		} else if (SUBCOMMAND_COMMANDS.has(command) && subcommand === undefined) {
			subcommand = arg;
		} else {
			positional.push(arg);
		}
	}

	if (command !== undefined && !KNOWN_COMMANDS.has(command)) {
		return {
			positional: [],
			flags: {},
			help: true,
			version,
			error: `cma: unknown command '${command}'`,
		};
	}

	return { command, subcommand, positional, flags, help, version };
}
