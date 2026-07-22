/**
 * `@foundation/claude-multiacct` — `cma account {add,remove,list,verify,refresh}`.
 *
 * Thin humaniser wrappers around PR4's library commands (`../commands.ts`).
 * Each subcommand:
 *
 *   1. Parses the flags it needs off the pre-parsed `ParsedArgs`;
 *   2. Invokes the corresponding PR4 command via the injected `CliPorts`;
 *   3. Prints a human-friendly summary via `logger.log` / `logger.error`;
 *   4. Returns an exit code (0 success, 2 error, 3 skipped).
 *
 * # Security — token handling
 *
 * `add` reads the OAuth token INTERACTIVELY. Two modes:
 *
 *   - TTY (default): a hidden-echo prompt via ANSI conceal (`\x1b[8m`).
 *     Not perfect (a screen recorder replaying the terminal buffer could
 *     recover concealed chars), but avoids a shell-out to `stty` and
 *     works everywhere Node runs. The token is echoed back only as
 *     `<hidden>` and never appears in any log line.
 *   - Non-TTY: refused unless `--stdin` is passed; with `--stdin` we
 *     read one line off stdin (piped in). Rule 12: silently reading
 *     from a non-TTY where the user MEANT to type is worse than a hard
 *     error.
 *
 * The token flows straight into `provisionAccount` (PR4). It never
 * appears on argv (blocked at the parser — see `../args.ts`), never in
 * `config.json` (unrelated file), never in any log line, never in a
 * return value. `commands/account.test.ts` runs an adversarial token-in-
 * captured-output test with a known needle string.
 *
 * # No stored primary
 *
 * Accounts carry no "primary" flag. Which account is active is derived at
 * runtime from Claude.app's current OAuth token, so `add` neither sets nor
 * reports a primary marker, and there is no `set-primary` subcommand.
 *
 * @module
 */

import readline from "node:readline";
import type { Account } from "../../domain/account.ts";
import {
	addAccount,
	type CliPorts,
	listAccounts,
	refreshAccount,
	removeAccount,
	type SkippedResult,
	verifyAccount,
} from "../commands.ts";
import type { OAuthTokens } from "../../oauth/models.ts";
import type { ParsedArgs } from "../args.ts";

/**
 * Type guard for the shared `SkippedResult` shape across PR4 commands.
 *
 * @param {object} result - The union result to narrow.
 * @returns {boolean} True iff `result` is the flag-off skip.
 */
function isSkipped(result: { ok: boolean }): result is SkippedResult {
	return result.ok === false && "skipped" in result && (result as SkippedResult).skipped === true;
}

/** Logger surface the humaniser writes to. */
export type AccountLogger = {
	log: (message: string) => void;
	error: (message: string) => void;
};

/** Injectable stdin token reader — pluggable for testability. */
export type TokenReader = {
	/** Read from a TTY with hidden echo. Called only when `stdinIsTty` is true. */
	readTty: (prompt: string) => Promise<string>;
	/** Read one line off stdin (piped). Called only in --stdin mode. */
	readStdin: () => Promise<string>;
};

/** Ports the humaniser needs. `stdinIsTty` mirrors `process.stdin.isTTY`. */
export type AccountPorts = {
	cliPorts: CliPorts;
	logger: AccountLogger;
	stdinIsTty: boolean;
	tokenReader: TokenReader;
	env?: Record<string, string | undefined>;
	overrideFlag?: boolean;
};

/** Human-readable exit-code shape. */
export type AccountExit = { exitCode: 0 | 2 | 3 };

/**
 * Dispatch table for `cma account <sub>`.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit code for the caller to `process.exit(...)`.
 */
export async function accountCommand(args: ParsedArgs, ports: AccountPorts): Promise<AccountExit> {
	switch (args.subcommand) {
		case "add": {
			return await accountAdd(args, ports);
		}
		case "list": {
			return await accountList(ports);
		}
		case "remove": {
			return await accountRemove(args, ports);
		}
		case "verify": {
			return await accountVerify(args, ports);
		}
		case "refresh": {
			return await accountRefresh(args, ports);
		}
		default: {
			ports.logger.error(
				`cma account: unknown subcommand '${String(args.subcommand ?? "<none>")}' (expected: add|list|remove|verify|refresh)`,
			);
			return { exitCode: 2 };
		}
	}
}

/**
 * `cma account add` handler.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit code result.
 */
async function accountAdd(args: ParsedArgs, ports: AccountPorts): Promise<AccountExit> {
	const { label } = args.flags;
	if (typeof label !== "string" || label.length === 0) {
		ports.logger.error("cma account add: --label=<name> is required");
		return { exitCode: 2 };
	}
	const stdinFlag = args.flags.stdin === true;
	let token: string;
	if (stdinFlag) {
		const raw = await ports.tokenReader.readStdin();
		token = raw.trim();
	} else if (ports.stdinIsTty) {
		const raw = await ports.tokenReader.readTty("Paste OAuth token (input hidden): ");
		token = raw.trim();
	} else {
		ports.logger.error(
			"cma account add: no TTY detected; use --stdin to read the token from stdin",
		);
		return { exitCode: 2 };
	}
	if (token.length === 0) {
		ports.logger.error("cma account add: empty token — aborting");
		return { exitCode: 2 };
	}

	const result = await addAccount({
		label,
		token,
		ports: ports.cliPorts,
		env: ports.env,
		overrideFlag: ports.overrideFlag,
	});
	if (isSkipped(result)) {
		ports.logger.error(`cma account add: skipped (${result.reason})`);
		return { exitCode: 3 };
	}
	if (!result.ok) {
		ports.logger.error(`cma account add: failed (${result.kind}): ${result.detail}`);
		return { exitCode: 2 };
	}
	ports.logger.log(
		`cma account add: added '${result.account.label}' [${shortUuid(result.account.uuid)}]`,
	);
	return { exitCode: 0 };
}

/**
 * `cma account list` handler — read-only.
 *
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit 0 always (read-only).
 */
async function accountList(ports: AccountPorts): Promise<AccountExit> {
	const accounts = await listAccounts({ ports: ports.cliPorts });
	if (accounts.length === 0) {
		ports.logger.log("cma account list: no accounts (run `cma account add` to create one)");
		return { exitCode: 0 };
	}
	ports.logger.log(formatAccountTable(accounts));
	return { exitCode: 0 };
}

/**
 * `cma account remove` handler.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit code result.
 */
async function accountRemove(args: ParsedArgs, ports: AccountPorts): Promise<AccountExit> {
	const selector = parseSelector(args);
	if (selector === undefined) {
		ports.logger.error("cma account remove: --uuid=<uuid> or --label=<label> required");
		return { exitCode: 2 };
	}
	const result = await removeAccount({
		selector,
		ports: ports.cliPorts,
		env: ports.env,
		overrideFlag: ports.overrideFlag,
	});
	if (isSkipped(result)) {
		ports.logger.error(`cma account remove: skipped (${result.reason})`);
		return { exitCode: 3 };
	}
	if (!result.ok) {
		ports.logger.error(`cma account remove: failed (${result.reason}): ${result.detail}`);
		return { exitCode: 2 };
	}
	ports.logger.log(
		`cma account remove: removed '${result.removed.label}' [${shortUuid(result.removed.uuid)}]`,
	);
	return { exitCode: 0 };
}

/**
 * `cma account verify` handler — read-only.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit code result.
 */
async function accountVerify(args: ParsedArgs, ports: AccountPorts): Promise<AccountExit> {
	const selector = parseSelector(args);
	if (selector === undefined) {
		ports.logger.error("cma account verify: --uuid=<uuid> or --label=<label> required");
		return { exitCode: 2 };
	}
	const result = await verifyAccount({ selector, ports: ports.cliPorts });
	if (!result.ok) {
		ports.logger.error(`cma account verify: ${result.reason}: ${result.detail}`);
		return { exitCode: 2 };
	}
	const v = result.verify;
	if (v.ok) {
		ports.logger.log(
			`cma account verify: OK — ${v.subscriptionType} / ${v.rateLimitTier} [${shortUuid(
				v.accountUuid,
			)}]`,
		);
	} else {
		const hint = result.needsRefresh ? " — run `cma account refresh`" : "";
		ports.logger.log(`cma account verify: NOT OK (${v.kind}): ${v.detail}${hint}`);
	}
	return { exitCode: 0 };
}

/**
 * `cma account refresh` handler.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @param {AccountPorts} ports - Injected ports.
 * @returns {Promise<AccountExit>} Exit code result.
 */
async function accountRefresh(args: ParsedArgs, ports: AccountPorts): Promise<AccountExit> {
	const selector = parseSelector(args);
	if (selector === undefined) {
		ports.logger.error("cma account refresh: --uuid=<uuid> or --label=<label> required");
		return { exitCode: 2 };
	}
	// Resolve the account against the registry directly — verifyAccount
	// would attempt a real-network probe which is not what refresh needs.
	const registry = await ports.cliPorts.readRegistry();
	if (registry === undefined) {
		ports.logger.error("cma account refresh: no registry — run `cma init` first");
		return { exitCode: 2 };
	}
	const account = registry.accounts.find(
		(a) =>
			(selector.uuid !== undefined && a.uuid === selector.uuid) ||
			(selector.label !== undefined && a.label === selector.label),
	);
	if (account === undefined) {
		ports.logger.error(
			`cma account refresh: no account matches ${selector.uuid ?? selector.label}`,
		);
		return { exitCode: 2 };
	}
	const stored = await ports.cliPorts.tokenStore.get(account.uuid);
	if (stored === undefined || stored.length === 0) {
		ports.logger.error(
			"cma account refresh: no stored token — re-provision with `cma account add`",
		);
		return { exitCode: 2 };
	}
	let tokens: OAuthTokens;
	try {
		tokens = JSON.parse(stored) as OAuthTokens;
	} catch {
		ports.logger.error(
			"cma account refresh: stored token has no OAuth bundle — re-provision with `cma account add`",
		);
		return { exitCode: 2 };
	}
	const result = await refreshAccount({
		selector,
		currentTokens: tokens,
		ports: ports.cliPorts,
		env: ports.env,
		overrideFlag: ports.overrideFlag,
	});
	if (isSkipped(result)) {
		ports.logger.error(`cma account refresh: skipped (${result.reason})`);
		return { exitCode: 3 };
	}
	if (!result.ok) {
		ports.logger.error(`cma account refresh: failed (${result.reason}): ${result.detail}`);
		return { exitCode: 2 };
	}
	ports.logger.log(
		`cma account refresh: refreshed '${result.account.label}' [${shortUuid(result.account.uuid)}]`,
	);
	return { exitCode: 0 };
}

/**
 * Convert `--uuid`/`--label` flags to an `AccountSelector`.
 *
 * @param {ParsedArgs} args - Parsed argv.
 * @returns {object | undefined} The selector or `undefined` when neither field is set.
 */
function parseSelector(args: ParsedArgs): { uuid?: string; label?: string } | undefined {
	const { uuid, label } = args.flags;
	if (typeof uuid === "string" && uuid.length > 0) {
		return { uuid };
	}
	if (typeof label === "string" && label.length > 0) {
		return { label };
	}
	// Positional fallback: `remove <uuid>` treats first positional as uuid.
	if (args.positional[0] !== undefined) {
		return { uuid: args.positional[0] };
	}
	return undefined;
}

/**
 * First 8 chars of the uuid — the human-facing short-id.
 *
 * @param {string} uuid - Full account uuid.
 * @returns {string} The leading 8 characters.
 */
function shortUuid(uuid: string): string {
	return uuid.slice(0, 8);
}

/**
 * Format a compact single-column-per-field account table.
 *
 * @param {readonly Account[]} accounts - Accounts to render.
 * @returns {string} Newline-joined table with header row.
 */
function formatAccountTable(accounts: readonly Account[]): string {
	const header = "label            uuid       subscription    tier";
	const rows = accounts.map((a) => {
		const label = pad(a.label, 16);
		const uuid = pad(shortUuid(a.uuid), 10);
		const sub = pad(a.subscriptionType, 15);
		const tier = a.rateLimitTier;
		return `${label} ${uuid} ${sub} ${tier}`;
	});
	return [header, ...rows].join("\n");
}

/**
 * Right-pad `s` to `width` with spaces; leaves it alone if already wider.
 *
 * @param {string} s - Input string.
 * @param {number} width - Target column width.
 * @returns {string} `s` padded to at least `width` chars.
 */
function pad(s: string, width: number): string {
	if (s.length >= width) {
		return s;
	}
	return s + " ".repeat(width - s.length);
}

/**
 * Default TTY token reader — ANSI conceal (`\x1b[8m`) around the input.
 * See module docstring for the tradeoff.
 *
 * @param {NodeJS.ReadableStream} stdin - Input stream (defaults to `process.stdin`).
 * @param {NodeJS.WritableStream} stdout - Output stream (defaults to `process.stdout`).
 * @returns {TokenReader} `{readTty, readStdin}` bound to the passed streams.
 */
export function makeDefaultTokenReader(
	stdin: NodeJS.ReadableStream = process.stdin,
	stdout: NodeJS.WritableStream = process.stdout,
): TokenReader {
	return {
		readTty: (prompt: string) =>
			new Promise((resolve) => {
				stdout.write(prompt);
				stdout.write("\u001B[8m");
				const rl = readline.createInterface({ input: stdin, terminal: false });
				rl.once("line", (line) => {
					stdout.write("\u001B[0m\n");
					rl.close();
					resolve(line);
				});
			}),
		readStdin: () =>
			new Promise((resolve) => {
				const rl = readline.createInterface({ input: stdin, terminal: false });
				rl.once("line", (line) => {
					rl.close();
					resolve(line);
				});
			}),
	};
}
