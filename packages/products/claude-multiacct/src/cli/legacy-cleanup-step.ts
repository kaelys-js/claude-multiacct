/**
 * `@foundation/claude-multiacct` — install-pipeline step for legacy-bash-tool
 * cleanup.
 *
 * Wraps `runLegacyCleanup` (see `./legacy-cleanup.ts`) as an
 * `OrchestrationStep` so it slots into the same install pipeline as the shim,
 * watcher, daemon, and extension. The step runs FIRST (before shim) so a
 * machine coming off the old bash tool is quiesced before we lay down new
 * artifacts on top.
 *
 * Install semantics:
 *   - `flag !== true` → skip (returns `ok:true`). The pipeline calls with
 *     `flag: true` during a real `cma install`; other callers pass `false`.
 *   - Otherwise run `runLegacyCleanup(ports, { assumeYes })`. Partial removal
 *     failures are logged and reported in the outcome — the step still returns
 *     `ok:true` so a stray plist unload permission error does not roll back
 *     the entire install. Total detection failure (`ports.detect` throws) is
 *     also caught + logged; cleanup is best-effort.
 *
 * Uninstall semantics: no-op. Legacy cleanup is one-shot install-time
 * housekeeping — there is nothing to reverse on `cma uninstall`.
 *
 * The step-builder is coverage-tested here; the real port bindings live in
 * `./wiring.ts` (coverage-excluded — they shell out to `launchctl`, `rm -rf`,
 * stdin/stderr, and readdir).
 *
 * @module
 */

import type { OrchestrationStep } from "./commands/install.ts";
import {
	type CleanupOutcome,
	type LegacyCleanupPorts,
	runLegacyCleanup,
} from "./legacy-cleanup.ts";

/** Options for the legacy-cleanup step. */
export type LegacyCleanupStepOptions = {
	/** Skip the interactive confirm prompt. Wired from `env.CMA_YES === "1"`. */
	assumeYes: boolean;
};

/**
 * Build the `legacy-cleanup` orchestration step.
 *
 * @param {LegacyCleanupPorts} ports - Injected side-effects for detection and removal.
 * @param {LegacyCleanupStepOptions} opts - Behaviour flags (assumeYes).
 * @returns {OrchestrationStep} Step for the install pipeline's front.
 */
export function makeLegacyCleanupStep(
	ports: LegacyCleanupPorts,
	opts: LegacyCleanupStepOptions,
): OrchestrationStep {
	return {
		name: "legacy-cleanup",
		install: async (flag) => {
			if (flag !== true) {
				return { ok: true, detail: "skipped (flag=false)" };
			}
			let outcome: CleanupOutcome;
			try {
				outcome = await runLegacyCleanup(ports, { assumeYes: opts.assumeYes });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ports.logger.warn(`legacy-cleanup: detection/removal threw: ${msg}; continuing install`);
				return { ok: true, detail: `cleanup errored: ${msg}` };
			}
			if (outcome.skipped) {
				return { ok: true, detail: "user declined" };
			}
			const removedCount =
				outcome.removed.cloneApps.length +
				outcome.removed.launchdPlists.length +
				(outcome.removed.legacyCli === undefined ? 0 : 1) +
				outcome.removed.mirrorStores.length +
				(outcome.removed.legacyDataDir === undefined ? 0 : 1);
			const failedCount = outcome.failed.length;
			return {
				ok: true,
				detail: `removed ${String(removedCount)} artifact(s), ${String(failedCount)} failed`,
			};
		},
		uninstall: () => Promise.resolve({ ok: true, detail: "no-op (install-time only)" }),
	};
}
