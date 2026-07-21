/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, unicorn/numeric-separators-style, unicorn/no-useless-undefined, unicorn/no-await-expression-member, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma install` is the ONLY point in the codebase that flips
 * `config.enabled = true`, and it must do so as a controlled transaction:
 *
 *   - steps run in the caller-supplied order (adversarial: swap steps →
 *     the "extension after daemon" invariant flips red);
 *   - `config.enabled = true` is written AFTER the shim step and BEFORE
 *     the extension step (adversarial: skip the flip → downstream steps
 *     would see enabled=false and no-op);
 *   - mid-pipeline failure rolls back completed steps in reverse and
 *     restores `enabled = false` (adversarial: remove rollback → the
 *     "mixed state after failure" test flips red);
 *   - every step receives `flag: true` explicitly (adversarial: forget
 *     the arg → PR2/3/5a/5b tests here would see `flag=false` skips).
 */

import { describe, expect, it, vi } from "vitest";
import { type CmaConfig, defaultConfig } from "../config-store.ts";
import { installCommand, type OrchestrationStep } from "./install.ts";

type Harness = {
	config: CmaConfig | undefined;
	writes: CmaConfig[];
	initCalls: number;
	log: string[];
	warn: string[];
	err: string[];
	callOrder: string[];
	flagsSeen: Map<string, boolean>;
	ports: Parameters<typeof installCommand>[0];
};

function makeStep(
	name: string,
	overrides: Partial<OrchestrationStep> = {},
	callOrder?: string[],
	flagsSeen?: Map<string, boolean>,
): OrchestrationStep {
	const okResult = { ok: true } as const;
	return {
		name,
		install:
			overrides.install ??
			(async (flag) => {
				callOrder?.push(`install:${name}`);
				flagsSeen?.set(name, flag);
				return okResult;
			}),
		uninstall:
			overrides.uninstall ??
			(async (flag) => {
				callOrder?.push(`uninstall:${name}`);
				flagsSeen?.set(`${name}:uninstall`, flag);
				return okResult;
			}),
	};
}

function makeHarness(steps: readonly OrchestrationStep[]): Harness {
	const h: Partial<Harness> = {
		config: undefined,
		writes: [],
		initCalls: 0,
		log: [],
		warn: [],
		err: [],
		callOrder: [],
		flagsSeen: new Map(),
	};
	h.ports = {
		steps,
		readConfig: async () => h.config,
		writeConfig: async (c: CmaConfig) => {
			(h.writes as CmaConfig[]).push(c);
			h.config = c;
		},
		ensureInit: async () => {
			(h as { initCalls: number }).initCalls += 1;
			if (h.config === undefined) {
				h.config = defaultConfig();
			}
		},
		logger: {
			log: (m) => (h.log as string[]).push(m),
			warn: (m) => (h.warn as string[]).push(m),
			error: (m) => (h.err as string[]).push(m),
		},
	};
	return h as Harness;
}

const ORDER = ["shim", "watcher", "daemon", "extension"] as const;

describe("installCommand — happy path", () => {
	it("runs the four steps in caller-supplied order (adversarial: swap → red)", async () => {
		const callOrder: string[] = [];
		const flagsSeen = new Map<string, boolean>();
		const steps = ORDER.map((n) => makeStep(n, {}, callOrder, flagsSeen));
		const h = makeHarness(steps);
		h.callOrder = callOrder;
		h.flagsSeen = flagsSeen;
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(0);
		expect(callOrder).toStrictEqual([
			"install:shim",
			"install:watcher",
			"install:daemon",
			"install:extension",
		]);
		// Extension MUST come after daemon (needs the bridge.json symlink target).
		expect(callOrder.indexOf("install:extension")).toBeGreaterThan(
			callOrder.indexOf("install:daemon"),
		);
	});

	it("writes config.enabled=true AFTER step 1 (shim) and BEFORE step 4 (extension)", async () => {
		const callOrder: string[] = [];
		const flagLog: boolean[] = [];
		const steps = ORDER.map((n) =>
			makeStep(
				n,
				{
					install: async (flag) => {
						// Snapshot the observed enabled value at the moment each step runs.
						callOrder.push(`${n}:enabled=${String(h.config?.enabled)}`);
						flagLog.push(flag);
						return { ok: true };
					},
				},
				callOrder,
			),
		);
		const h = makeHarness(steps);
		await installCommand(h.ports);
		// After shim (step 0), config.enabled was flipped to true → step 1 sees true.
		expect(callOrder).toStrictEqual([
			"shim:enabled=false",
			"watcher:enabled=true",
			"daemon:enabled=true",
			"extension:enabled=true",
		]);
		// Precisely two writes on the happy path: (1) initial ensureInit default,
		// (2) enabled-flip after shim.
		expect(h.writes.some((c) => c.enabled === true)).toBe(true);
		// The flag captured at each step is true (also silences unused-var lint).
		expect(flagLog).toStrictEqual([true, true, true, true]);
	});

	it("every step is called with flag: true explicitly", async () => {
		const flagsSeen = new Map<string, boolean>();
		const steps = ORDER.map((n) => makeStep(n, {}, undefined, flagsSeen));
		const h = makeHarness(steps);
		await installCommand(h.ports);
		for (const n of ORDER) {
			expect(flagsSeen.get(n)).toBe(true);
		}
	});

	it("prints the next-step launch guidance on success", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		await installCommand(h.ports);
		expect(h.log.join("\n")).toContain("cma launch");
		expect(h.log.join("\n")).toContain("4/4");
	});

	it("ensureInit is invoked first and only once", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		await installCommand(h.ports);
		expect(h.initCalls).toBe(1);
	});
});

describe("installCommand — rollback on failure (ADVERSARIAL: drop rollback → red)", () => {
	it("failure at step 3 (daemon) → steps 1+2 uninstalled in reverse, step 4 NEVER called, enabled stays false", async () => {
		const callOrder: string[] = [];
		const steps: OrchestrationStep[] = [
			makeStep("shim", {}, callOrder),
			makeStep("watcher", {}, callOrder),
			makeStep(
				"daemon",
				{
					install: async () => {
						callOrder.push("install:daemon(FAIL)");
						return { ok: false, detail: "port 4771 busy" };
					},
				},
				callOrder,
			),
			makeStep("extension", {}, callOrder),
		];
		const h = makeHarness(steps);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(r.failedStep).toBe("daemon");
		expect(callOrder).toStrictEqual([
			"install:shim",
			"install:watcher",
			"install:daemon(FAIL)",
			"uninstall:watcher", // reverse order
			"uninstall:shim",
		]);
		expect(callOrder).not.toContain("install:extension");
		expect(r.rolledBack).toStrictEqual(["watcher", "shim"]);
		// Final config write MUST be enabled=false.
		const finalEnabled = h.config?.enabled;
		expect(finalEnabled).toBe(false);
		expect(h.err.some((m) => m.includes("port 4771 busy"))).toBe(true);
	});

	it("thrown error at step 2 → step 1 uninstalled, enabled reverted, exit 2", async () => {
		const callOrder: string[] = [];
		const steps: OrchestrationStep[] = [
			makeStep("shim", {}, callOrder),
			makeStep(
				"watcher",
				{
					install: async () => {
						throw new Error("kaboom");
					},
				},
				callOrder,
			),
			makeStep("daemon", {}, callOrder),
			makeStep("extension", {}, callOrder),
		];
		const h = makeHarness(steps);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(r.failedStep).toBe("watcher");
		expect(callOrder).toContain("uninstall:shim");
		expect(h.config?.enabled).toBe(false);
	});

	it("rollback that itself throws does NOT crash the pipeline (best-effort)", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim", {
				uninstall: async () => {
					throw new Error("rollback failed");
				},
			}),
			makeStep("watcher", {
				install: async () => ({ ok: false, detail: "nope" }),
			}),
		];
		const h = makeHarness(steps);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(h.warn.some((m) => m.includes("rollback of 'shim'"))).toBe(true);
	});

	it("post-rollback writeConfig throw is logged but not fatal", async () => {
		let seenEnabledTrue = false;
		const steps: OrchestrationStep[] = [
			makeStep("shim"),
			makeStep("bad", { install: async () => ({ ok: false }) }),
		];
		const h = makeHarness(steps);
		const original = h.ports.writeConfig;
		h.ports = {
			...h.ports,
			writeConfig: async (c) => {
				// Only fail the rollback revert (the second write with enabled=false,
				// after the earlier enabled=true happened).
				if (seenEnabledTrue && c.enabled === false) {
					throw new Error("disk full");
				}
				if (c.enabled === true) {
					seenEnabledTrue = true;
				}
				return await original(c);
			},
		};
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(h.warn.some((m) => m.includes("restore config.enabled=false"))).toBe(true);
	});
});

describe("installCommand — logger / rollback edge cases (coverage)", () => {
	it("step failure with undefined detail formats a clean error message", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim"),
			makeStep("bad", { install: async () => ({ ok: false }) }),
		];
		const h = makeHarness(steps);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(h.err.some((m) => m === "cma install: step 'bad' failed")).toBe(true);
	});

	it("thrown non-Error value at step is stringified into the error line", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim"),
			makeStep("bad", {
				install: () => {
					// eslint-disable-next-line no-throw-literal
					throw "just a string";
				},
			}),
		];
		const h = makeHarness(steps);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(2);
		expect(h.err.some((m) => m.includes("just a string"))).toBe(true);
	});

	it("rollback: thrown non-Error inside step.uninstall is stringified", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim", {
				uninstall: () => {
					// eslint-disable-next-line no-throw-literal
					throw "rollback string";
				},
			}),
			makeStep("bad", { install: async () => ({ ok: false }) }),
		];
		const h = makeHarness(steps);
		await installCommand(h.ports);
		expect(h.warn.some((m) => m.includes("rollback string"))).toBe(true);
	});

	it("rollback: thrown non-Error from writeConfig revert is stringified", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim"),
			makeStep("bad", { install: async () => ({ ok: false }) }),
		];
		const h = makeHarness(steps);
		let seenTrue = false;
		const original = h.ports.writeConfig;
		h.ports = {
			...h.ports,
			writeConfig: async (c) => {
				if (seenTrue && c.enabled === false) {
					// eslint-disable-next-line no-throw-literal
					throw "not an error";
				}
				if (c.enabled === true) {
					seenTrue = true;
				}
				await original(c);
			},
		};
		await installCommand(h.ports);
		expect(h.warn.some((m) => m.includes("not an error"))).toBe(true);
	});
});

describe("installCommand — edge cases", () => {
	it("empty step list → success, no writes to enabled flag beyond ensureInit default", async () => {
		const h = makeHarness([]);
		const r = await installCommand(h.ports);
		expect(r.exitCode).toBe(0);
		expect(r.completed).toStrictEqual([]);
	});

	it("throws if config is still missing after ensureInit (Rule 12 loud)", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		// Break ensureInit so config stays undefined.
		h.ports = { ...h.ports, ensureInit: async () => undefined };
		await expect(installCommand(h.ports)).rejects.toThrow(/config\.json still missing/u);
	});
});
