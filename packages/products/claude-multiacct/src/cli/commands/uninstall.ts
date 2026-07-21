/**
 * `@foundation/claude-multiacct` — `cma uninstall`.
 *
 * Reverses `cma install`. Runs each step's `uninstall(flag: true)` in
 * REVERSE order (extension → daemon → watcher → shim), then flips
 * `config.enabled = false`.
 *
 * Semantics diverge from install:
 *   - Best-effort. A mid-step failure does NOT abort subsequent
 *     uninstalls. This is Rule 12 in reverse: on the way OUT, we want
 *     the machine as clean as we can leave it, not consistent with a
 *     half-finished uninstall.
 *   - Exit code is non-zero if ANY step reported failure, but every
 *     step still ran.
 *   - `flag: true` is passed to every uninstall so PR5b's `flag`-gated
 *     `install: {skipped:true}` path DOES NOT short-circuit the removal.
 *
 * @module
 */

import type { CmaConfig } from "../config-store.ts";
import type { OrchestrationStep } from "./install.ts";

/** Ports for `uninstallCommand`. Shape mirrors `InstallPorts` closely. */
export type UninstallPorts = {
	steps: readonly OrchestrationStep[];
	readConfig: () => Promise<CmaConfig | undefined>;
	writeConfig: (config: CmaConfig) => Promise<void>;
	logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

/** Result of the reverse pipeline. */
export type UninstallResult = {
	exitCode: number;
	perStep: ReadonlyArray<{ name: string; ok: boolean; detail?: string }>;
};

/**
 * `cma uninstall`. See module docstring.
 *
 * @param {UninstallPorts} ports - Ports + steps in install-order.
 * @returns {Promise<UninstallResult>} Per-step outcomes; exit 0 iff all ok.
 */
export async function uninstallCommand(ports: UninstallPorts): Promise<UninstallResult> {
	const perStep: Array<{ name: string; ok: boolean; detail?: string }> = [];
	const reversed = [...ports.steps].toReversed();
	for (const step of reversed) {
		try {
			// eslint-disable-next-line no-await-in-loop -- teardown ordering is intentional
			const outcome = await step.uninstall(true);
			perStep.push({ name: step.name, ok: outcome.ok, detail: outcome.detail });
			ports.logger.log(
				`cma uninstall: ${step.name} ${outcome.ok ? "ok" : `FAILED${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`}`,
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			perStep.push({ name: step.name, ok: false, detail });
			ports.logger.error(`cma uninstall: ${step.name} threw: ${detail}`);
		}
	}

	// Flip config.enabled=false unconditionally (best-effort).
	try {
		const current = await ports.readConfig();
		if (current !== undefined) {
			await ports.writeConfig({ ...current, enabled: false });
			ports.logger.log("cma uninstall: config.enabled=false");
		}
	} catch (error) {
		ports.logger.warn(
			`cma uninstall: could not clear config.enabled: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const failures = perStep.filter((s) => !s.ok);
	if (failures.length > 0) {
		ports.logger.error(
			`cma uninstall: ${String(failures.length)} step(s) failed: ${failures.map((f) => f.name).join(", ")}`,
		);
	}
	return { exitCode: failures.length === 0 ? 0 : 2, perStep };
}
