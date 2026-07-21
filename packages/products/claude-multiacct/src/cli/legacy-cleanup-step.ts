/**
 * `@foundation/claude-multiacct` — install-pipeline step for legacy-bash-tool
 * cleanup.
 *
 * Wraps `runLegacyCleanup` (see `./legacy-cleanup.ts`) as an
 * `OrchestrationStep` so it slots into the same install pipeline as the shim,
 * watcher, daemon, and extension.
 *
 * # Safety default
 *
 * A previous version of this step ran during every `cma install` and, when
 * `CMA_YES=1` was set, silently deleted the user's `~/Applications/Claude
 * Account *.app` bundles, mirror stores under `~/Library/Application
 * Support/Claude-*`, and per-user launchd plists. That was the wrong default:
 * the mere presence of those files is not consent to remove them.
 *
 * The step now skips unless the caller explicitly opts in with
 * `purgeLegacy: true` (wired from `--purge-legacy` on the CLI or
 * `CMA_PURGE_LEGACY=1` in the environment). Even under `purgeLegacy: true`,
 * the wrapped run still gates on `promptConfirm` unless `assumeYes: true` is
 * also passed (wired from `--yes-i-really-mean-it` /
 * `CMA_YES_I_REALLY_MEAN_IT=1`). The old `CMA_YES=1` shortcut is not honored
 * here — it was too easy to set for unrelated reasons.
 *
 * Install semantics:
 *   - `flag !== true` → skip (no detection, no removal).
 *   - `purgeLegacy !== true` → skip with an explanatory detail so the user sees
 *     that legacy artifacts (if any) are being left in place by design.
 *   - Otherwise run `runLegacyCleanup(ports, { assumeYes })`. Partial removal
 *     failures are logged and reported in the outcome; the step still returns
 *     `ok:true` so a stray plist unload permission error does not roll back
 *     the entire install. Total detection failure (`ports.detect` throws) is
 *     also caught + logged; cleanup is best-effort.
 *
 * Uninstall semantics: no-op. Legacy cleanup is one-shot install-time
 * housekeeping — there is nothing to reverse on `cma uninstall`.
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
	/**
	 * Opt in to running the destructive cleanup path. Default `false` so a
	 * plain `cma install` never touches legacy artifacts. Wired from
	 * `--purge-legacy` on argv or `CMA_PURGE_LEGACY=1` in the env.
	 */
	purgeLegacy: boolean;
	/**
	 * Skip the interactive confirm prompt inside `runLegacyCleanup`. Only
	 * respected when `purgeLegacy: true`. Wired from `--yes-i-really-mean-it`
	 * on argv or `CMA_YES_I_REALLY_MEAN_IT=1` in the env.
	 */
	assumeYes: boolean;
};

/**
 * Build the `legacy-cleanup` orchestration step.
 *
 * @param {LegacyCleanupPorts} ports - Injected side-effects for detection and removal.
 * @param {LegacyCleanupStepOptions} opts - Behaviour flags.
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
			if (opts.purgeLegacy !== true) {
				return {
					ok: true,
					detail:
						"skipped (pass --purge-legacy to remove old bash-tool artifacts; default install leaves them in place)",
				};
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
