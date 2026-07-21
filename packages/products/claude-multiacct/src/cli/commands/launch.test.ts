/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns */
/**
 * Intent: `cma launch` refuses to spawn Claude if any precondition
 * (app present, config exists, daemon alive & bridge.json structurally
 * valid) is not satisfied. Adversarial: bypass any check and its
 * corresponding test flips red.
 *
 * Bug 9 regression cover: launch MUST NOT gate on bridge.json mtime.
 * The daemon writes bridge.json once at boot and never rewrites it, so
 * a freshness window (Bug 9's original 5s heuristic) would refuse a
 * healthy long-running daemon. Adversarial: reintroduce an mtime gate
 * with any finite window → the "60s old but pid alive → PROCEEDS" test
 * flips red.
 */

import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config-store.ts";
import { launchCommand, type LaunchPorts } from "./launch.ts";

function makePorts(overrides: Partial<LaunchPorts> = {}): LaunchPorts {
	return {
		readConfig: async () => defaultConfig(),
		fs: {
			stat: vi.fn<LaunchPorts["fs"]["stat"]>(async () => ({ mtimeMs: 1_000_000 })),
			readFile: vi.fn<LaunchPorts["fs"]["readFile"]>(async () => JSON.stringify({ pid: 42 })),
		},
		pidIsAlive: vi.fn<LaunchPorts["pidIsAlive"]>(() => true),
		launchClaude: vi.fn<LaunchPorts["launchClaude"]>(async () => {
			// no-op stub
		}),
		appPath: "/fake/Claude.app",
		logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
		...overrides,
	};
}

describe("launchCommand — happy path", () => {
	it("invokes launchClaude with bridgeJsonPath from config, exit 0", async () => {
		const p = makePorts();
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(0);
		expect(p.launchClaude).toHaveBeenCalledWith({ bridgeJsonPath: defaultConfig().bridgeJsonPath });
	});
});

describe("launchCommand — preconditions (adversarial: bypass any → red)", () => {
	it("refuses when /Applications/Claude.app missing (fail loud)", async () => {
		const p = makePorts({
			fs: {
				stat: vi.fn(async (path: string) => {
					if (path === "/fake/Claude.app") {
						throw new Error("ENOENT");
					}
					return { mtimeMs: 1_000_000 };
				}),
				readFile: vi.fn(async () => JSON.stringify({ pid: 42 })),
			},
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/not found/u);
		expect(p.launchClaude).not.toHaveBeenCalled();
	});

	it("refuses when config missing (asks user to run `cma init`)", async () => {
		// eslint-disable-next-line unicorn/no-useless-undefined -- explicit undefined-return contract for readConfig
		const p = makePorts({ readConfig: async () => undefined });
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/config\.json missing/u);
	});

	it("refuses when bridge.json missing (prints bootstrap hint)", async () => {
		const errors: string[] = [];
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: 1_000_000 })),
				readFile: vi.fn(async () => {
					throw new Error("ENOENT");
				}),
			},
			logger: { log: vi.fn(), warn: vi.fn(), error: (m) => errors.push(m) },
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/missing or unreadable/u);
		expect(errors.join("\n")).toContain("launchctl bootstrap");
		expect(errors.join("\n")).toContain("cma install");
	});

	it("refuses when bridge.json is not valid JSON", async () => {
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: 1_000_000 })),
				readFile: vi.fn(async () => "not json at all {{{"),
			},
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/not valid JSON/u);
		expect(p.launchClaude).not.toHaveBeenCalled();
	});

	it("refuses when bridge.json is structurally invalid (fails valibot: pid missing). Adversarial: drop the valibot check → red", async () => {
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: 1_000_000 })),
				readFile: vi.fn(async () => JSON.stringify({ version: "0.0.0" })),
			},
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/structural validation/u);
		expect(p.launchClaude).not.toHaveBeenCalled();
	});

	it("refuses when bridge.json pid is not a positive integer (valibot rejects pid:0)", async () => {
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: 1_000_000 })),
				readFile: vi.fn(async () => JSON.stringify({ pid: 0 })),
			},
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/structural validation/u);
	});

	it("refuses when the daemon pid is not alive", async () => {
		const p = makePorts({ pidIsAlive: vi.fn(() => false) });
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/not alive/u);
	});

	it("PROCEEDS when bridge.json is 60s old but pid is alive (Bug 9 regression: no mtime gate). Adversarial: reintroduce a 5s mtime window → red", async () => {
		// Daemon writes bridge.json exactly once at boot; a freshness window
		// would refuse a healthy long-running daemon.
		const NOW = 1_000_000;
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: NOW - 60_000 })),
				readFile: vi.fn(async () => JSON.stringify({ pid: 42 })),
			},
			pidIsAlive: vi.fn(() => true),
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(0);
		expect(p.launchClaude).toHaveBeenCalledTimes(1);
	});

	it("refuses when pid is not alive regardless of bridge.json mtime (freshness is irrelevant)", async () => {
		const NOW = 1_000_000;
		const p = makePorts({
			fs: {
				stat: vi.fn(async () => ({ mtimeMs: NOW })),
				readFile: vi.fn(async () => JSON.stringify({ pid: 42 })),
			},
			pidIsAlive: vi.fn(() => false),
		});
		const r = await launchCommand(p);
		expect(r.exitCode).toBe(2);
		expect(r.reason).toMatch(/not alive/u);
	});
});
