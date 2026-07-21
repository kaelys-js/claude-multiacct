/* oxlint-disable vitest/expect-expect, vitest/no-conditional-in-test, vitest/require-to-throw-message, vitest/require-mock-type-parameters, eslint/prefer-promise-reject-errors, eslint/require-await, eslint/no-unused-vars, eslint/no-throw-literal, unicorn/numeric-separators-style, unicorn/no-useless-undefined, typescript/explicit-function-return-type, jsdoc/require-jsdoc, jsdoc/require-param, jsdoc/require-returns, no-await-in-loop, no-continue */
/**
 * Intent: `cma uninstall` reverses `cma install` in mirror order and is
 * best-effort — a mid-step failure keeps the pipeline running so the
 * machine ends up as clean as possible.
 *
 *   - REVERSE order (adversarial: forget `.reverse()` and this trips);
 *   - flag: true propagated to every uninstall (adversarial: pass false
 *     and PR5b's flag-off skip would leave files behind);
 *   - failure at step N does not stop step N+1;
 *   - config.enabled=false is written at the end regardless;
 *   - exit code non-zero iff any step failed.
 */

import { describe, expect, it } from "vitest";
import { type CmaConfig, defaultConfig } from "../config-store.ts";
import type { OrchestrationStep } from "./install.ts";
import { uninstallCommand } from "./uninstall.ts";

function makeStep(
	name: string,
	overrides: Partial<OrchestrationStep> = {},
	trace?: string[],
	flags?: Map<string, boolean>,
): OrchestrationStep {
	return {
		name,
		install: overrides.install ?? (async () => ({ ok: true })),
		uninstall:
			overrides.uninstall ??
			(async (flag) => {
				trace?.push(`uninstall:${name}`);
				flags?.set(name, flag);
				return { ok: true };
			}),
	};
}

type Harness = {
	config: CmaConfig;
	writes: CmaConfig[];
	log: string[];
	warn: string[];
	err: string[];
	ports: Parameters<typeof uninstallCommand>[0];
};

function makeHarness(steps: readonly OrchestrationStep[]): Harness {
	const state = {
		config: { ...defaultConfig(), enabled: true },
		writes: [] as CmaConfig[],
		log: [] as string[],
		warn: [] as string[],
		err: [] as string[],
	};
	// Return `state` directly (not a spread copy) so post-run field assertions
	// see the mutations made by ports.writeConfig.
	(state as Harness).ports = {
		steps,
		readConfig: async () => state.config,
		writeConfig: async (c: CmaConfig) => {
			state.writes.push(c);
			state.config = c;
		},
		logger: {
			log: (m: string) => state.log.push(m),
			warn: (m: string) => state.warn.push(m),
			error: (m: string) => state.err.push(m),
		},
	};
	return state as Harness;
}

const ORDER = ["shim", "watcher", "daemon", "extension"] as const;

describe("uninstallCommand — happy path", () => {
	it("calls uninstall in REVERSE order with flag=true; ends with enabled=false", async () => {
		const trace: string[] = [];
		const flags = new Map<string, boolean>();
		const steps = ORDER.map((n) => makeStep(n, {}, trace, flags));
		const h = makeHarness(steps);
		const r = await uninstallCommand(h.ports);
		expect(r.exitCode).toBe(0);
		expect(trace).toStrictEqual([
			"uninstall:extension",
			"uninstall:daemon",
			"uninstall:watcher",
			"uninstall:shim",
		]);
		for (const n of ORDER) {
			expect(flags.get(n)).toBe(true);
		}
		expect(h.config.enabled).toBe(false);
	});
});

describe("uninstallCommand — best-effort semantics", () => {
	it("failure at daemon still runs watcher + shim uninstall; exit 2", async () => {
		const trace: string[] = [];
		const steps: OrchestrationStep[] = [
			makeStep("shim", {}, trace),
			makeStep("watcher", {}, trace),
			makeStep(
				"daemon",
				{
					uninstall: async () => {
						trace.push("uninstall:daemon(FAIL)");
						return { ok: false, detail: "launchctl bootout: not loaded" };
					},
				},
				trace,
			),
			makeStep("extension", {}, trace),
		];
		const h = makeHarness(steps);
		const r = await uninstallCommand(h.ports);
		expect(r.exitCode).toBe(2);
		// Reverse order still, daemon fails but watcher + shim STILL uninstall.
		expect(trace).toStrictEqual([
			"uninstall:extension",
			"uninstall:daemon(FAIL)",
			"uninstall:watcher",
			"uninstall:shim",
		]);
		expect(h.config.enabled).toBe(false);
		expect(r.perStep.find((s) => s.name === "daemon")?.ok).toBe(false);
	});

	it("thrown uninstall does not abort subsequent steps", async () => {
		const trace: string[] = [];
		const steps: OrchestrationStep[] = [
			makeStep("shim", {}, trace),
			makeStep(
				"watcher",
				{
					uninstall: async () => {
						throw new Error("boom");
					},
				},
				trace,
			),
		];
		const h = makeHarness(steps);
		const r = await uninstallCommand(h.ports);
		expect(r.exitCode).toBe(2);
		// watcher is index 1 → reverse runs watcher first (throws), then shim still runs.
		expect(trace).toContain("uninstall:shim");
		expect(h.err.some((m) => m.includes("watcher threw"))).toBe(true);
	});

	it("readConfig undefined → no writeConfig call, no crash", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		h.ports = { ...h.ports, readConfig: async () => undefined };
		const r = await uninstallCommand(h.ports);
		expect(r.exitCode).toBe(0);
	});

	it("writeConfig throw at the end is warned but not fatal", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		h.ports = {
			...h.ports,
			writeConfig: async () => {
				throw new Error("disk full");
			},
		};
		const r = await uninstallCommand(h.ports);
		expect(r.exitCode).toBe(0);
		expect(h.warn.some((m) => m.includes("could not clear config.enabled"))).toBe(true);
	});

	it("step returning ok:false with no detail still logs a clean FAILED line", async () => {
		const trace: string[] = [];
		const steps: OrchestrationStep[] = [
			makeStep("shim", { uninstall: async () => ({ ok: false }) }, trace),
		];
		const h = makeHarness(steps);
		await uninstallCommand(h.ports);
		expect(h.log.some((m) => m === "cma uninstall: shim FAILED")).toBe(true);
	});

	it("thrown non-Error inside uninstall is stringified", async () => {
		const steps: OrchestrationStep[] = [
			makeStep("shim", {
				uninstall: () => {
					// eslint-disable-next-line no-throw-literal
					throw "raw string";
				},
			}),
		];
		const h = makeHarness(steps);
		await uninstallCommand(h.ports);
		expect(h.err.some((m) => m.includes("raw string"))).toBe(true);
	});

	it("writeConfig throw with non-Error is stringified in the warn line", async () => {
		const steps = ORDER.map((n) => makeStep(n));
		const h = makeHarness(steps);
		h.ports = {
			...h.ports,
			writeConfig: () => {
				// eslint-disable-next-line no-throw-literal
				throw "disk error string";
			},
		};
		await uninstallCommand(h.ports);
		expect(h.warn.some((m) => m.includes("disk error string"))).toBe(true);
	});
});
