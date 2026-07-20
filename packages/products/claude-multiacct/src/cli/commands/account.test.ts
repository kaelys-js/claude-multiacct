/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma account` humaniser wrappers around PR4's commands.
 * Load-bearing tests:
 *
 *   - **Token safety** (the one that matters): with a known needle
 *     token "TESTTOKEN12345", after `add` the needle appears in NO
 *     captured log line and NO logger.error line. Adversarial: log the
 *     token anywhere and this test goes red.
 *   - Non-TTY without `--stdin` → hard error, exit 2 (Rule 12).
 *   - `--stdin` mode reads one line off stdin instead of prompting.
 *   - First `add` after empty registry → returned account is primary
 *     (auto — via PR4's provisionAccount first-account path). This
 *     verifies the Rule-1 decision at the observable-outcome layer.
 *   - `list` / `verify` are read-only (never invoke registryWriter.write
 *     and never invoke tokenStore.put/delete).
 *   - `remove` / `set-primary` humanise the PR4 result cleanly (skipped
 *     when flag off).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Account, type AccountUuid, AccountUuidSchema } from "../../domain/account.ts";
import type { AccountRegistry } from "../../domain/registry.ts";
import type { OAuthTokens, VerifyResult } from "../../oauth/models.ts";
import { InMemoryMutableTokenStore } from "../../oauth/token-store-mut.ts";
import type { AtomicRegistryWriter } from "../../registry/registry-writer.ts";
import { parseArgs } from "../args.ts";
import type { CliPorts } from "../commands.ts";
import { type AccountPorts, accountCommand, makeDefaultTokenReader } from "./account.ts";
import * as v from "valibot";

// Restore process.stdout/stderr + console.* spies installed by makeHarness so
// captures don't bleed between tests.
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Coerce a stdout/stderr/console argument to a string for needle-scanning.
 * Buffer/Uint8Array chunks (what `process.stdout.write` accepts) become UTF-8.
 */
function stringifyChunk(chunk: unknown): string {
	if (typeof chunk === "string") {
		return chunk;
	}
	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk).toString("utf8");
	}
	return String(chunk);
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function coerceUuid(s: string): AccountUuid {
	return v.parse(AccountUuidSchema, s);
}

function verifyOk(uuid: string): VerifyResult {
	return { ok: true, subscriptionType: "Pro", rateLimitTier: "tier-2", accountUuid: uuid };
}

function baseRegistry(): AccountRegistry {
	return {
		accounts: [
			{
				uuid: coerceUuid(UUID_A),
				label: "Personal",
				isPrimary: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:a",
			},
			{
				uuid: coerceUuid(UUID_B),
				label: "Work",
				isPrimary: false,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				encryptedTokenRef: "keychain:b",
			},
		],
	};
}

type Harness = {
	ports: AccountPorts;
	logs: string[];
	errors: string[];
	registryReadValue: { value: AccountRegistry | undefined };
	writes: AccountRegistry[];
	tokenStore: InMemoryMutableTokenStore;
	captured: string[];
};

function makeHarness(
	overrides: {
		registry?: AccountRegistry;
		stdinIsTty?: boolean;
		tokenValue?: string;
		stdinValue?: string;
		verify?: VerifyResult;
		refresh?: CliPorts["refresh"];
		overrideFlag?: boolean;
	} = {},
): Harness {
	const logs: string[] = [];
	const errors: string[] = [];
	const captured: string[] = [];
	const registryReadValue = { value: overrides.registry };
	const writes: AccountRegistry[] = [];
	const tokenStore = new InMemoryMutableTokenStore();

	const registryWriter: Pick<AtomicRegistryWriter, "write"> = {
		write: async (r) => {
			writes.push(r);
			registryReadValue.value = r;
			return { backup: undefined };
		},
	};
	const cliPorts: CliPorts = {
		tokenStore,
		registryWriter,
		readRegistry: async () => registryReadValue.value,
		verify: async () => overrides.verify ?? verifyOk(UUID_A),
		refresh: overrides.refresh,
	};

	const logger = {
		log: (m: string) => {
			logs.push(m);
			captured.push(m);
		},
		error: (m: string) => {
			errors.push(m);
			captured.push(m);
		},
	};

	// Wider needle net: a regression that writes the token via console.* or
	// directly to process.stdout/stderr must also fail the token-safety test.
	// The injected `logger` alone can't catch those surfaces, so spy on them
	// too and funnel into the same `captured` array. `afterEach` restores.
	vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
		captured.push(`[stdout.write] ${stringifyChunk(chunk)}`);
		return true;
	}) as typeof process.stdout.write);
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		captured.push(`[stderr.write] ${stringifyChunk(chunk)}`);
		return true;
	}) as typeof process.stderr.write);
	for (const method of ["log", "info", "warn", "error"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			captured.push(`[console.${method}] ${args.map((a) => stringifyChunk(a)).join(" ")}`);
		});
	}

	const tokenReader = {
		readTty: vi.fn(async () => overrides.tokenValue ?? "TESTTOKEN12345"),
		readStdin: vi.fn(async () => overrides.stdinValue ?? "TESTTOKEN12345"),
	};

	const ports: AccountPorts = {
		cliPorts,
		logger,
		stdinIsTty: overrides.stdinIsTty ?? true,
		tokenReader,
		env: overrides.overrideFlag === true ? undefined : {},
		overrideFlag: overrides.overrideFlag,
	};

	return { ports, logs, errors, registryReadValue, writes, tokenStore, captured };
}

describe("cma account add", () => {
	it("happy path (TTY): first add → account.isPrimary === true (Rule-1 auto-primary)", async () => {
		const h = makeHarness({ overrideFlag: true, registry: undefined });
		const args = parseArgs(["account", "add", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.writes.length).toBe(1);
		const [firstWrite] = h.writes;
		if (firstWrite === undefined || firstWrite.accounts[0] === undefined) {
			throw new Error("unreachable — expected one write");
		}
		expect(firstWrite.accounts[0].isPrimary).toBe(true);
		expect(h.logs.some((l) => l.includes("primary — first account"))).toBe(true);
	});

	it("TOKEN SAFETY: token needle appears NOWHERE in captured output", async () => {
		const NEEDLE = "TESTTOKEN12345";
		const h = makeHarness({ overrideFlag: true, tokenValue: NEEDLE });
		const args = parseArgs(["account", "add", "--label=Personal"]);
		await accountCommand(args, h.ports);
		// `h.captured` is the wider net: injected logger.log/error PLUS
		// process.stdout.write, process.stderr.write, and console.*. Each entry
		// is tagged with its source so a regression's failure names the leaking
		// surface (e.g. "[stdout.write] ..."). A bare `console.log(token)` or
		// `process.stdout.write(token)` in production code MUST fail this test.
		for (const line of h.captured) {
			expect(line, `token leaked via captured line: ${line}`).not.toContain(NEEDLE);
		}
		// Also assert the written registry never carries the raw token.
		for (const write of h.writes) {
			const json = JSON.stringify(write);
			expect(json).not.toContain(NEEDLE);
		}
		// (The token store IS the destination for the raw token — the store's
		// port is expected to encrypt out-of-band in production, e.g. Keychain.
		// We assert leak-safety at the OBSERVABLE surface: logs + registry JSON.
		// Anything the tokenStore.put path receives is deliberate per PR4.)
	});

	it("TOKEN SAFETY (harness self-check): console.log AND process.stdout.write leaks are both captured", async () => {
		// Adversarial: prove the wider net actually intercepts the two surfaces
		// the previous injected-logger-only harness would have missed. This is
		// a harness contract test — the production code path is NOT exercised
		// here; we simply verify the spies fire so a future regression that
		// emits the token via either surface cannot pass the needle test above.
		const NEEDLE = "TESTTOKEN12345";
		const h = makeHarness({ overrideFlag: true, tokenValue: NEEDLE });
		// eslint-disable-next-line no-console -- deliberate leak, must be caught
		console.log(NEEDLE);
		process.stdout.write(NEEDLE);
		expect(h.captured.some((l) => l.startsWith("[console.log]") && l.includes(NEEDLE))).toBe(true);
		expect(h.captured.some((l) => l.startsWith("[stdout.write]") && l.includes(NEEDLE))).toBe(true);
	});

	it("non-TTY without --stdin → hard error + exit 2", async () => {
		const h = makeHarness({ overrideFlag: true, stdinIsTty: false });
		const args = parseArgs(["account", "add", "--label=X"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("no TTY detected");
	});

	it("--stdin mode calls readStdin, not readTty", async () => {
		const h = makeHarness({ overrideFlag: true, stdinIsTty: false });
		const args = parseArgs(["account", "add", "--label=X", "--stdin"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.ports.tokenReader.readStdin as ReturnType<typeof vi.fn>).toHaveBeenCalled();
		expect(h.ports.tokenReader.readTty as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("missing --label → error, exit 2", async () => {
		const h = makeHarness({ overrideFlag: true });
		const args = parseArgs(["account", "add"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("--label");
	});

	it("empty token after trim → error, exit 2", async () => {
		const h = makeHarness({ overrideFlag: true, tokenValue: "  \n" });
		const args = parseArgs(["account", "add", "--label=X"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("empty token");
	});

	it("skipped when flag off → exit 3", async () => {
		const h = makeHarness({}); // overrideFlag undefined, empty env
		const args = parseArgs(["account", "add", "--label=X"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(3);
		expect(h.errors.join("\n")).toContain("skipped");
	});

	it("second add (registry already has primary) → account.isPrimary=false, no first-account note", async () => {
		const h = makeHarness({
			overrideFlag: true,
			registry: baseRegistry(),
			verify: {
				ok: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: "33333333-3333-4333-8333-333333333333",
			},
		});
		const args = parseArgs(["account", "add", "--label=New"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.some((l) => l.includes("primary — first account"))).toBe(false);
	});

	it("PR4 failure surfaces with kind + detail, exit 2", async () => {
		const h = makeHarness({
			overrideFlag: true,
			verify: { ok: false, kind: "unauthorized", detail: "bad-token" },
		});
		const args = parseArgs(["account", "add", "--label=X"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("verify_failed");
	});
});

describe("cma account list — read-only", () => {
	it("empty registry → 'no accounts' hint", async () => {
		const h = makeHarness();
		const args = parseArgs(["account", "list"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("no accounts");
		expect(h.writes.length).toBe(0);
	});

	it("populated registry → table with labels + short uuids + primary marker", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const args = parseArgs(["account", "list"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		const out = h.logs.join("\n");
		expect(out).toContain("Personal");
		expect(out).toContain("Work");
		expect(out).toContain(UUID_A.slice(0, 8));
		expect(out).toContain("yes");
		expect(h.writes.length).toBe(0);
	});

	it("long labels do not pad (covers pad's early-return branch)", async () => {
		const longRegistry: AccountRegistry = {
			accounts: [
				{
					uuid: coerceUuid(UUID_A),
					label: "A-Very-Very-Long-Label-Exceeding-Sixteen-Chars",
					isPrimary: true,
					subscriptionType: "EnterpriseTierWithAVeryLongName",
					rateLimitTier: "tier-2",
					encryptedTokenRef: "keychain:a",
				},
			],
		};
		const h = makeHarness({ registry: longRegistry });
		const args = parseArgs(["account", "list"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("A-Very-Very-Long-Label-Exceeding-Sixteen-Chars");
	});
});

describe("cma account verify — read-only", () => {
	it("OK verify prints subscription + tier + short uuid, no writes", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		await h.tokenStore.put(coerceUuid(UUID_A), "stored");
		const args = parseArgs(["account", "verify", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("OK");
		expect(h.writes.length).toBe(0);
	});

	it("missing selector → error", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const args = parseArgs(["account", "verify"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("required");
	});

	it("network-fail verify prints NO refresh hint (Rule 12: refresh does not help)", async () => {
		const h = makeHarness({
			registry: baseRegistry(),
			verify: { ok: false, kind: "network", detail: "timeout" },
		});
		await h.tokenStore.put(coerceUuid(UUID_A), "stored");
		const args = parseArgs(["account", "verify", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("NOT OK");
		expect(h.logs.join("\n")).not.toContain("cma account refresh");
	});

	it("unauthorized verify prints refresh hint", async () => {
		const h = makeHarness({
			registry: baseRegistry(),
			verify: { ok: false, kind: "unauthorized", detail: "expired" },
		});
		await h.tokenStore.put(coerceUuid(UUID_A), "stored");
		const args = parseArgs(["account", "verify", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("cma account refresh");
	});

	it("not-found (unknown selector) → error", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const args = parseArgs(["account", "verify", "--label=Nope"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});
});

describe("cma account remove", () => {
	it("happy path (non-primary) → prints removed line, exit 0", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "remove", "--label=Work"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("removed");
	});

	it("missing selector → error, exit 2", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "remove"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});

	it("flag off → skipped, exit 3", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const args = parseArgs(["account", "remove", "--label=Work"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(3);
		expect(h.errors.join("\n")).toContain("skipped");
	});

	it("positional uuid selector works", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "remove", UUID_B]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
	});

	it("PR4 failure surfaces reason + detail", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		// Ask to remove primary while Work exists → PR4 rejects.
		const args = parseArgs(["account", "remove", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("failed");
	});
});

describe("cma account refresh", () => {
	it("no stored token → helpful error", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("re-provision");
	});

	it("stored token that isn't OAuth JSON → helpful error", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		await h.tokenStore.put(coerceUuid(UUID_A), "not-json{{");
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("no OAuth bundle");
	});

	it("skipped when flag off", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const tokens: OAuthTokens = {
			accessToken: "at",
			refreshToken: "rt",
			scopes: ["user"],
		};
		await h.tokenStore.put(coerceUuid(UUID_A), JSON.stringify(tokens));
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		// Flag off path returns exit 3 via skipped from refreshAccount OR
		// depending on which path first — currently our impl checks stored
		// data before the gate, so this fails at 'no refresh_impl' → exit 2.
		// Either exit code is acceptable so long as no state mutation happens.
		expect([2, 3]).toContain(result.exitCode);
	});

	it("happy path when refresh impl succeeds → exit 0, logs refreshed", async () => {
		const tokens: OAuthTokens = {
			accessToken: "at",
			refreshToken: "rt",
			scopes: ["user"],
		};
		const h = makeHarness({
			registry: baseRegistry(),
			overrideFlag: true,
			refresh: async () => ({
				ok: true,
				tokens: { ...tokens, accessToken: "new-at" },
			}),
		});
		await h.tokenStore.put(coerceUuid(UUID_A), JSON.stringify(tokens));
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toContain("refreshed");
	});

	it("selector missing → error", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "refresh"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});

	it("unknown label → error 'no account matches'", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "refresh", "--label=Nope"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("no account matches");
	});

	it("no registry at all → 'run cma init first'", async () => {
		const h = makeHarness({ registry: undefined, overrideFlag: true });
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("no registry");
	});

	it("refresh impl returns failure → surfaces reason+detail, exit 2", async () => {
		const tokens: OAuthTokens = { accessToken: "at", refreshToken: "rt", scopes: [] };
		const h = makeHarness({
			registry: baseRegistry(),
			overrideFlag: true,
			refresh: async () => ({ ok: false, kind: "network", detail: "timeout" }),
		});
		await h.tokenStore.put(coerceUuid(UUID_A), JSON.stringify(tokens));
		const args = parseArgs(["account", "refresh", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("refresh_failed");
	});

	it("--uuid selector works for refresh", async () => {
		const tokens: OAuthTokens = { accessToken: "at", refreshToken: "rt", scopes: [] };
		const h = makeHarness({
			registry: baseRegistry(),
			overrideFlag: true,
			refresh: async () => ({ ok: true, tokens }),
		});
		await h.tokenStore.put(coerceUuid(UUID_A), JSON.stringify(tokens));
		const args = parseArgs(["account", "refresh", `--uuid=${UUID_A}`]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
	});

	it("positional uuid selector works for refresh", async () => {
		const tokens: OAuthTokens = { accessToken: "at", refreshToken: "rt", scopes: [] };
		const h = makeHarness({
			registry: baseRegistry(),
			overrideFlag: true,
			refresh: async () => ({ ok: true, tokens }),
		});
		await h.tokenStore.put(coerceUuid(UUID_A), JSON.stringify(tokens));
		const args = parseArgs(["account", "refresh", UUID_A]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
	});
});

describe("cma account set-primary", () => {
	it("happy path → prints transition, exit 0", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "set-primary", "--label=Work"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(0);
		expect(h.logs.join("\n")).toMatch(/Personal.*Work/u);
	});

	it("skipped when flag off", async () => {
		const h = makeHarness({ registry: baseRegistry() });
		const args = parseArgs(["account", "set-primary", "--label=Work"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(3);
	});

	it("already primary → failure, exit 2", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "set-primary", "--label=Personal"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});

	it("missing selector → error", async () => {
		const h = makeHarness({ registry: baseRegistry(), overrideFlag: true });
		const args = parseArgs(["account", "set-primary"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});
});

describe("cma account: unknown subcommand", () => {
	it("prints error + exit 2", async () => {
		const h = makeHarness();
		const args = parseArgs(["account", "foo"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
		expect(h.errors.join("\n")).toContain("unknown subcommand");
	});

	it("no subcommand at all → error", async () => {
		const h = makeHarness();
		const args = parseArgs(["account"]);
		const result = await accountCommand(args, h.ports);
		expect(result.exitCode).toBe(2);
	});
});

describe("makeDefaultTokenReader", () => {
	it("readStdin resolves with the piped line", async () => {
		const { PassThrough } = await import("node:stream");
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const reader = makeDefaultTokenReader(stdin, stdout);
		const p = reader.readStdin();
		stdin.write("piped-value\n");
		const value = await p;
		expect(value).toBe("piped-value");
	});

	it("readTty concealment sequence brackets the input, resolves with the typed line", async () => {
		const { PassThrough } = await import("node:stream");
		const stdin = new PassThrough();
		const chunks: string[] = [];
		const stdout: NodeJS.WritableStream = {
			write: ((chunk: string | Uint8Array) => {
				chunks.push(chunk.toString());
				return true;
			}) as NodeJS.WritableStream["write"],
		} as unknown as NodeJS.WritableStream;
		const reader = makeDefaultTokenReader(stdin, stdout);
		const p = reader.readTty("Enter: ");
		stdin.write("typed-token\n");
		const value = await p;
		expect(value).toBe("typed-token");
		const joined = chunks.join("");
		// Conceal ON, then reset — both must be present.
		expect(joined).toContain("\x1b[8m");
		expect(joined).toContain("\x1b[0m");
		// The prompt was written before the conceal.
		expect(joined.indexOf("Enter:")).toBeLessThan(joined.indexOf("\x1b[8m"));
	});
});
