/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: argv parsing + security invariants. Load-bearing:
 *
 *   - `--token` at parse-time is REJECTED (security invariant). Argv is
 *     visible to `ps`; a token there leaks to every local process.
 *     Adversarial: allow `--token` in the parser → the rejection test
 *     goes red.
 *   - `--help`/`-h`/`--version`/`-V` work at any level.
 *   - Unknown command → `help: true` + `error`; caller prints usage +
 *     exits 1.
 *   - `account <sub>` recognises the subcommand slot; `init` treats every
 *     positional as a positional.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs: happy paths", () => {
	it("empty argv → command undefined, no help", () => {
		const p = parseArgs([]);
		expect(p.command).toBeUndefined();
		expect(p.help).toBe(false);
		expect(p.version).toBe(false);
	});

	it("--help alone → help true", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
	});

	it("--version → version true", () => {
		expect(parseArgs(["--version"]).version).toBe(true);
		expect(parseArgs(["-V"]).version).toBe(true);
	});

	it("init --dry-run → command=init, dry-run flag true", () => {
		const p = parseArgs(["init", "--dry-run"]);
		expect(p.command).toBe("init");
		expect(p.flags["dry-run"]).toBe(true);
	});

	it("account add --label foo → command+subcommand parsed, --label captures value", () => {
		const p = parseArgs(["account", "add", "--label=Work"]);
		expect(p.command).toBe("account");
		expect(p.subcommand).toBe("add");
		expect(p.flags.label).toBe("Work");
	});

	it("account list → command=account, subcommand=list", () => {
		const p = parseArgs(["account", "list"]);
		expect(p.command).toBe("account");
		expect(p.subcommand).toBe("list");
	});

	it("--help works after a command", () => {
		expect(parseArgs(["account", "--help"]).help).toBe(true);
		expect(parseArgs(["account", "add", "--help"]).help).toBe(true);
	});

	it("--flag without = becomes boolean true", () => {
		const p = parseArgs(["status", "--verbose"]);
		expect(p.flags.verbose).toBe(true);
	});

	it("extra positionals collect after subcommand slot", () => {
		const p = parseArgs(["account", "remove", "some-uuid"]);
		expect(p.subcommand).toBe("remove");
		expect(p.positional).toStrictEqual(["some-uuid"]);
	});

	it("non-subcommand top-level command has no subcommand slot: positionals accumulate", () => {
		const p = parseArgs(["init", "extra1", "extra2"]);
		expect(p.command).toBe("init");
		expect(p.subcommand).toBeUndefined();
		expect(p.positional).toStrictEqual(["extra1", "extra2"]);
	});
});

describe("parseArgs: unknown command", () => {
	it("unknown top-level command → help:true + error", () => {
		const p = parseArgs(["frobnicate"]);
		expect(p.command).toBeUndefined();
		expect(p.help).toBe(true);
		expect(p.error).toContain("unknown command");
	});
});

describe("parseArgs: security — reject --token on argv", () => {
	it("--token=<value> is rejected with a security message", () => {
		const p = parseArgs(["account", "add", "--token=SECRET"]);
		expect(p.error).toContain("--token");
		expect(p.error).toContain("security");
		// Adversarial tripwire — allowing --token would let SECRET appear here.
		expect(p.flags.token).toBeUndefined();
	});

	it("bare --token (no value) is also rejected", () => {
		const p = parseArgs(["account", "add", "--token"]);
		expect(p.error).toContain("--token");
	});
});
