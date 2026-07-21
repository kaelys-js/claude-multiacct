/**
 * `@foundation/claude-multiacct` — `cma install`.
 *
 * The single opt-in that flips the shim on and installs every mutating
 * subsystem in one atomic step. Runs installers in a fixed order and
 * ROLLS BACK any earlier successes if a later step fails, then reverts
 * `config.enabled` to false. The whole thing is safe to re-run.
 *
 * Step order (`OrchestrationStep[]`, top-down):
 *   1. `shim`       — PR2 CLI-shim installer, per detected `claude-code/<version>` dir
 *   2. `watcher`    — PR3 launchd `WatchPaths` agent
 *   3. `daemon`     — PR5a bridge-daemon launchd agent
 *   4. `extension`  — PR5b Chrome-anchor extension (needs the daemon's
 *                     `bridge.json` symlink target — hence AFTER `daemon`)
 *
 * `config.enabled = true` is written AFTER step 1 (`shim`) but BEFORE
 * step 4 (`extension`) so `isEnabled({env, config})` inside downstream
 * steps sees the truth even if the caller never set the env var. On any
 * rollback, `enabled` is set back to `false` so a later `cma status`
 * accurately reports the machine's state.
 *
 * Every installer receives `flag: true` explicitly, which OVERRIDES the
 * env-var gate on PR2/PR3/PR5a/PR5b installers (see their MutateOptions
 * docstrings). This is the whole point of PR6b: config.enabled → flag:true
 * → mutations run without requiring `CLAUDE_MULTIACCT_ENABLE_SHIM=1` in
 * every shell.
 *
 * # Testability
 *
 * The command consumes `OrchestrationStep[]` (plus a tiny fs/config port
 * bundle). Real dispatch wires four steps that bind to the actual PR2/3/5a/5b
 * installers; tests inject fakes that record call-order and can force a
 * failure at any step. Adversarial test coverage:
 *   - swap step order → the "extension after daemon" invariant test flips red
 *   - drop the rollback → the "step-3 fails, steps 1+2 uninstalled in reverse,
 *     config.enabled stays false" test flips red
 *
 * @module
 */

import type { CmaConfig } from "../config-store.ts";

/** One installer's contribution to the install/uninstall pipeline. */
export type OrchestrationStep = {
	/** Human-readable step name shown in log lines and rollback reports. */
	name: string;
	/**
	 * Run the step with an authoritative flag. `true` for install. Return
	 * `ok: false` to signal failure — the orchestrator will roll back
	 * previous successful steps in reverse.
	 */
	install: (flag: boolean) => Promise<{ ok: boolean; detail?: string }>;
	/**
	 * Reverse the step. Called during rollback and during `cma uninstall`.
	 * Must be best-effort (never throw): a rollback that itself throws
	 * leaves the machine in a worse state than the original failure.
	 */
	uninstall: (flag: boolean) => Promise<{ ok: boolean; detail?: string }>;
};

/** Dependencies the command needs beyond the step list. */
export type InstallPorts = {
	steps: readonly OrchestrationStep[];
	/** Read current config; return undefined for "not initialised yet". */
	readConfig: () => Promise<CmaConfig | undefined>;
	/** Persist a config value (used to flip `enabled`). */
	writeConfig: (config: CmaConfig) => Promise<void>;
	/**
	 * `cma init` equivalent — ensure `~/.config/claude-multiacct/` exists
	 * and a default `config.json` is on disk. No-op when already present.
	 */
	ensureInit: () => Promise<void>;
	logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
};

/** Result of the top-level install pipeline. */
export type InstallResult = {
	exitCode: number;
	completed: readonly string[];
	failedStep?: string;
	rolledBack: readonly string[];
};

/**
 * `cma install`. See module docstring.
 *
 * @param {InstallPorts} ports - Steps + config + logger.
 * @returns {Promise<InstallResult>} Structured outcome; exitCode 0 on success.
 */
export async function installCommand(ports: InstallPorts): Promise<InstallResult> {
	await ports.ensureInit();
	const current = await ports.readConfig();
	if (current === undefined) {
		throw new Error(
			"cma install: config.json still missing after ensureInit(); run `cma init` manually to diagnose",
		);
	}

	const completed: string[] = [];
	const rolledBack: string[] = [];

	let index = 0;
	for (const step of ports.steps) {
		try {
			// eslint-disable-next-line no-await-in-loop -- pipeline ordering: each step depends on prior success
			const outcome = await step.install(true);
			if (!outcome.ok) {
				ports.logger.error(
					`cma install: step '${step.name}' failed${outcome.detail === undefined ? "" : `: ${outcome.detail}`}`,
				);
				// eslint-disable-next-line no-await-in-loop -- rollback must complete before returning
				await rollback(ports, completed, rolledBack, current);
				return { exitCode: 2, completed, failedStep: step.name, rolledBack };
			}
			completed.push(step.name);
			ports.logger.log(`cma install: ${step.name} ok`);
			// After step 1 (shim) succeeded, flip `enabled=true` so downstream
			// steps see the truth via readConfig.
			if (index === 0) {
				// eslint-disable-next-line no-await-in-loop -- config flip must precede subsequent steps
				await ports.writeConfig({ ...current, enabled: true });
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ports.logger.error(`cma install: step '${step.name}' threw: ${detail}`);
			// eslint-disable-next-line no-await-in-loop -- rollback must complete before returning
			await rollback(ports, completed, rolledBack, current);
			return { exitCode: 2, completed, failedStep: step.name, rolledBack };
		}
		index += 1;
	}

	ports.logger.log(
		`cma install: enabled: true — ${String(completed.length)}/${String(ports.steps.length)} installers ok`,
	);
	ports.logger.log("cma install: next step → cma launch");
	return { exitCode: 0, completed, rolledBack };
}

/**
 * Reverse successful steps in reverse order and restore `config.enabled=false`.
 * Best-effort: individual uninstall failures are logged but do not abort.
 *
 * @param {InstallPorts} ports - Same ports the pipeline used.
 * @param {readonly string[]} completed - Names of steps that succeeded.
 * @param {string[]} rolledBack - Mutated: names of steps whose uninstall ran.
 * @param {CmaConfig} baseline - Config snapshot before install ran.
 * @returns {Promise<void>} Resolves when rollback is exhausted.
 */
async function rollback(
	ports: InstallPorts,
	completed: readonly string[],
	rolledBack: string[],
	baseline: CmaConfig,
): Promise<void> {
	for (let i = completed.length - 1; i >= 0; i -= 1) {
		const name = completed[i];
		const step = ports.steps.find((s) => s.name === name);
		// completed is only appended when a step succeeds so `find` always
		// returns a match; the `!` pins that so we don't emit a coverage-blind
		// `continue` fallback branch.
		if (step === undefined) {
			throw new Error(
				`unreachable: step '${String(name)}' missing from ports.steps during rollback`,
			);
		}
		try {
			// eslint-disable-next-line no-await-in-loop -- rollback must be sequential
			await step.uninstall(true);
			rolledBack.push(step.name);
		} catch (error) {
			ports.logger.warn(
				`cma install: rollback of '${step.name}' failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	try {
		await ports.writeConfig({ ...baseline, enabled: false });
	} catch (error) {
		ports.logger.warn(
			`cma install: could not restore config.enabled=false: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
