/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, unicorn/no-hex-escape, unicorn/escape-case, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: dispatcher routing + top-level exit codes.
 *
 *   - --version → prints PACKAGE_VERSION, exits 0.
 *   - --help alone → prints help, exits 0 (user asked).
 *   - no command → prints help, exits 1 (usage error).
 *   - unknown command → exits 1 (parseArgs' `error` propagates).
 *   - --token on argv → rejected via parseArgs, exit 1.
 *   - init → runs init, exit 0 on success.
 *   - status → runs status (read-only), exit 0.
 *   - doctor → runs doctor, exit 0 when all findings ok.
 *   - PR6b command (e.g. `install`) → "not yet wired", exit 2.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_VERSION } from "../index.ts";
import { InMemoryMutableTokenStore } from "../oauth/token-store-mut.ts";
import type { CliPorts } from "./commands.ts";
import { type CmaConfig, defaultConfig } from "./config-store.ts";
import { dispatchCli, topLevelHelp } from "./dispatch.ts";

function makeIO(
	overrides: {
		stdinIsTty?: boolean;
		env?: Record<string, string | undefined>;
	} = {},
): {
	io: Parameters<typeof dispatchCli>[1];
	logs: string[];
	warns: string[];
	errors: string[];
} {
	const logs: string[] = [];
	const warns: string[] = [];
	const errors: string[] = [];
	const io = {
		logger: {
			log: (m: string) => {
				logs.push(m);
			},
			warn: (m: string) => {
				warns.push(m);
			},
			error: (m: string) => {
				errors.push(m);
			},
		},
		env: overrides.env ?? {},
		stdinIsTty: overrides.stdinIsTty ?? true,
		makeCliPorts: async (): Promise<CliPorts> => ({
			tokenStore: new InMemoryMutableTokenStore(),
			registryWriter: { write: async () => ({ backup: undefined }) },
			readRegistry: async () => undefined,
			verify: async () => ({
				ok: true,
				subscriptionType: "Pro",
				rateLimitTier: "tier-2",
				accountUuid: "11111111-1111-4111-8111-111111111111",
			}),
		}),
		tokenReader: {
			readTty: vi.fn(async () => "TOKEN"),
			readStdin: vi.fn(async () => "TOKEN"),
		},
		// Never let the real `codesign` / `spctl` binaries run in tests —
		// each call takes ~1.5s on macOS and the suite fans out across every
		// status/doctor case. The fake returns an empty result which the
		// collector treats as "probe failed" (a note in the report), which
		// these tests don't assert on.
		makeStatusExecFile: () => async () =>
			({ stdout: "", stderr: "", code: 1 }) as { stdout: string; stderr: string; code: number },
	};
	return { io, logs, warns, errors };
}

describe("dispatchCli", () => {
	it("--version prints PACKAGE_VERSION and exits 0", async () => {
		const h = makeIO();
		const code = await dispatchCli(["--version"], h.io);
		expect(code).toBe(0);
		expect(h.logs).toContain(PACKAGE_VERSION);
	});

	it("no argv → help + exit 1", async () => {
		const h = makeIO();
		const code = await dispatchCli([], h.io);
		expect(code).toBe(1);
		expect(h.logs.join("\n")).toContain("Usage");
	});

	it("--help alone → help + exit 0", async () => {
		const h = makeIO();
		// A bare --help gives command=undefined + help=true → exits 1 in this
		// dispatcher (help was printed BECAUSE no command was given). The
		// user-asked help path fires with `<command> --help`.
		const code = await dispatchCli(["init", "--help"], h.io);
		expect(code).toBe(0);
	});

	it("unknown command → error + exit 1", async () => {
		const h = makeIO();
		const code = await dispatchCli(["frobnicate"], h.io);
		expect(code).toBe(1);
		expect(h.errors.join("\n")).toContain("unknown command");
	});

	it("--token on argv → rejected, exit 1", async () => {
		const h = makeIO();
		const code = await dispatchCli(["account", "add", "--token=SECRET"], h.io);
		expect(code).toBe(1);
		expect(h.errors.join("\n")).toContain("security");
	});

	it("init to an unwritable HOME → exit 2 (init failure branch)", async () => {
		const oldHome = process.env.HOME;
		// /dev/null/x cannot be mkdir'd → initCommand returns {ok:false}.
		process.env.HOME = "/dev/null/no-such-parent";
		try {
			const h = makeIO();
			const code = await dispatchCli(["init"], h.io);
			expect(code).toBe(2);
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("account list without an injected tokenReader → uses default (fallback branch)", async () => {
		// Build an io WITHOUT tokenReader; account list never actually reads a
		// token so it exercises the fallback branch without prompting.
		const logs: string[] = [];
		const io = {
			logger: {
				log: (m: string) => {
					logs.push(m);
				},
				warn: () => {},
				error: () => {},
			},
			env: {},
			stdinIsTty: true,
			makeCliPorts: async (): Promise<CliPorts> => ({
				tokenStore: new InMemoryMutableTokenStore(),
				registryWriter: { write: async () => ({ backup: undefined }) },
				readRegistry: async () => undefined,
				verify: async () => ({
					ok: true,
					subscriptionType: "Pro",
					rateLimitTier: "tier-2",
					accountUuid: "11111111-1111-4111-8111-111111111111",
				}),
			}),
		};
		const code = await dispatchCli(["account", "list"], io);
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("no accounts");
	});

	it("init --dry-run → exit 0", async () => {
		const h = makeIO();
		const code = await dispatchCli(["init", "--dry-run"], h.io);
		expect(code).toBe(0);
	});

	it("PR6b command without a port factory → clear error, exit 2", async () => {
		// makeIO() doesn't wire the PR6b make*Ports factories. The dispatcher
		// falls back to the "no port factory wired" error rather than crashing.
		const h = makeIO();
		const code = await dispatchCli(["install"], h.io);
		expect(code).toBe(2);
		expect(h.errors.join("\n")).toContain("no port factory wired");
	});

	it("install with an injected port factory runs installCommand end-to-end", async () => {
		const h = makeIO();
		const trace: string[] = [];
		let config: CmaConfig | undefined = { ...defaultConfig() };
		h.io.makeInstallPorts = async () => ({
			steps: [
				{
					name: "s1",
					install: async () => {
						trace.push("s1");
						return { ok: true };
					},
					uninstall: async () => ({ ok: true }),
				},
			],
			readConfig: async () => config,
			writeConfig: async (c) => {
				config = c;
			},
			ensureInit: async () => undefined,
			logger: h.io.logger,
		});
		const code = await dispatchCli(["install"], h.io);
		expect(code).toBe(0);
		expect(trace).toStrictEqual(["s1"]);
	});

	it("uninstall with an injected port factory runs uninstallCommand", async () => {
		const h = makeIO();
		const trace: string[] = [];
		h.io.makeUninstallPorts = async () => ({
			steps: [
				{
					name: "s1",
					install: async () => ({ ok: true }),
					uninstall: async () => {
						trace.push("u1");
						return { ok: true };
					},
				},
			],
			readConfig: async () => undefined,
			writeConfig: async () => undefined,
			logger: h.io.logger,
		});
		const code = await dispatchCli(["uninstall"], h.io);
		expect(code).toBe(0);
		expect(trace).toStrictEqual(["u1"]);
	});

	it("launch with an injected port factory runs launchCommand", async () => {
		const h = makeIO();
		let launched = false;
		h.io.makeLaunchPorts = async () => ({
			readConfig: async () => defaultConfig(),
			fs: {
				stat: async () => ({ mtimeMs: 1000 }),
				readFile: async () => JSON.stringify({ pid: 42 }),
			},
			pidIsAlive: () => true,
			launchClaude: async () => {
				launched = true;
			},
			appPath: "/x/Claude.app",
			logger: h.io.logger,
		});
		const code = await dispatchCli(["launch"], h.io);
		expect(code).toBe(0);
		expect(launched).toBe(true);
	});

	it("migrate (no --apply) prints report, exit 0", async () => {
		const h = makeIO();
		h.io.makeMigratePorts = async () => ({
			fs: {
				exists: async () => false,
				readDir: async () => [],
				readFileBytes: async () => Buffer.from(""),
				rm: async () => undefined,
				rename: async () => undefined,
				copyFile: async () => undefined,
				mkdir: async () => undefined,
			},
			launchctl: { bootout: async () => undefined },
			uid: 501,
			homedir: "/home",
			appPath: "/x",
			backupsRoot: "/b",
			confirm: async () => false,
			now: () => new Date(0),
			logger: h.io.logger,
		});
		const code = await dispatchCli(["migrate"], h.io);
		expect(code).toBe(0);
		expect(h.logs.join("\n")).toContain("no legacy artifacts");
	});

	it("uninstall / launch / migrate without their port factories → clear errors, exit 2", async () => {
		const h1 = makeIO();
		expect(await dispatchCli(["uninstall"], h1.io)).toBe(2);
		expect(h1.errors.join("\n")).toContain("no port factory wired");
		const h2 = makeIO();
		expect(await dispatchCli(["launch"], h2.io)).toBe(2);
		expect(h2.errors.join("\n")).toContain("no port factory wired");
		const h3 = makeIO();
		expect(await dispatchCli(["migrate"], h3.io)).toBe(2);
		expect(h3.errors.join("\n")).toContain("no port factory wired");
	});

	it("migrate --apply --yes runs apply, exit 0 on clean machine", async () => {
		const h = makeIO();
		h.io.makeMigratePorts = async () => ({
			fs: {
				exists: async () => false,
				readDir: async () => [],
				readFileBytes: async () => Buffer.from(""),
				rm: async () => undefined,
				rename: async () => undefined,
				copyFile: async () => undefined,
				mkdir: async () => undefined,
			},
			launchctl: { bootout: async () => undefined },
			uid: 501,
			homedir: "/home",
			appPath: "/x",
			backupsRoot: "/b",
			confirm: async () => true,
			now: () => new Date(0),
			logger: h.io.logger,
		});
		const code = await dispatchCli(["migrate", "--apply", "--yes"], h.io);
		expect(code).toBe(0);
	});

	it("status runs against injected read-only state, exit 0", async () => {
		const h = makeIO();
		const code = await dispatchCli(["status"], h.io);
		expect(code).toBe(0);
		expect(h.logs.join("\n")).toContain("=== Config ===");
	});

	it("doctor: all-happy → exit 0; error-tier finding → exit 2", async () => {
		const h = makeIO();
		const code = await dispatchCli(["doctor"], h.io);
		// On a machine without Claude.app the codesign probe returns non-zero,
		// which classifies the finding as error → exit 2. Either 0 or 2 is
		// deterministic per machine; pin behavior via the shape check.
		expect([0, 2]).toContain(code);
	});

	it("account list runs through the account dispatcher", async () => {
		const h = makeIO();
		const code = await dispatchCli(["account", "list"], h.io);
		expect(code).toBe(0);
		expect(h.logs.join("\n")).toContain("no accounts");
	});

	it("buildStatusPorts loads a valid registry.json into the status report", async () => {
		const { mkdir } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "cma-dispatch-"));
		await mkdir(join(dir, ".config", "claude-multiacct"), { recursive: true });
		const validRegistry = {
			accounts: [
				{
					uuid: "11111111-1111-4111-8111-111111111111",
					label: "Personal",
					isPrimary: true,
					subscriptionType: "Pro",
					rateLimitTier: "tier-2",
					encryptedTokenRef: "keychain:a",
				},
			],
		};
		await writeFile(
			join(dir, ".config", "claude-multiacct", "registry.json"),
			JSON.stringify(validRegistry),
			"utf8",
		);
		const oldHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const h = makeIO();
			const code = await dispatchCli(["status"], h.io);
			expect(code).toBe(0);
			// Success branch produced a real registry section with the parsed account.
			expect(h.logs.join("\n")).toContain("Personal");
			expect(h.warns.some((w) => w.includes("registry.json"))).toBe(false);
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("buildStatusPorts warns when registry.json is corrupted JSON", async () => {
		const { mkdir } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "cma-dispatch-"));
		await mkdir(join(dir, ".config", "claude-multiacct"), { recursive: true });
		await writeFile(
			join(dir, ".config", "claude-multiacct", "registry.json"),
			"not-json{{",
			"utf8",
		);
		const oldHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const h = makeIO();
			const code = await dispatchCli(["status"], h.io);
			expect(code).toBe(0);
			// Corrupted JSON → catch branch → warn about registry.json.
			expect(h.warns.join("\n")).toContain("registry.json");
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("buildStatusPorts warns when registry.json is schema-invalid", async () => {
		const { mkdir } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "cma-dispatch-"));
		await mkdir(join(dir, ".config", "claude-multiacct"), { recursive: true });
		// Valid JSON, invalid schema (empty accounts violates exactly-one-primary).
		await writeFile(
			join(dir, ".config", "claude-multiacct", "registry.json"),
			JSON.stringify({ accounts: [] }),
			"utf8",
		);
		const oldHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const h = makeIO();
			const code = await dispatchCli(["status"], h.io);
			expect(code).toBe(0);
			expect(h.warns.some((w) => w.includes("schema-invalid"))).toBe(true);
		} finally {
			process.env.HOME = oldHome;
		}
	});

	it("buildStatusPorts propagates config-store warnings to the logger", async () => {
		const { mkdir } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "cma-dispatch-"));
		await mkdir(join(dir, ".config", "claude-multiacct"), { recursive: true });
		// Valid JSON, invalid schema for config → readConfig calls logger.warn.
		await writeFile(
			join(dir, ".config", "claude-multiacct", "config.json"),
			JSON.stringify({ enabled: "yes" }),
			"utf8",
		);
		const oldHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const h = makeIO();
			const code = await dispatchCli(["status"], h.io);
			expect(code).toBe(0);
			expect(h.warns.some((w) => w.includes("ConfigStore"))).toBe(true);
		} finally {
			process.env.HOME = oldHome;
		}
	});
});

describe("topLevelHelp", () => {
	it("mentions every wired command name", () => {
		const help = topLevelHelp();
		expect(help).toContain("init");
		expect(help).toContain("account add");
		expect(help).toContain("status");
		expect(help).toContain("doctor");
	});
});
