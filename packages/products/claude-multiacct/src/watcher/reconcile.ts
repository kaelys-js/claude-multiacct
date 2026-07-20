/**
 * `@foundation/claude-multiacct` — pure decision function converting scan
 * output into the list of actions the watcher runtime should perform.
 *
 * Two contracts pinned by this module:
 *
 *   1. **Feature-flag gate** — with `flag: false`, EVERY dir routes to `skip`
 *      with reason `flag-off`. That is the load-bearing default-off assertion
 *      for this GATED PR: without CLAUDE_MULTIACCT_ENABLE_SHIM=1, the watcher
 *      runtime produces zero installs. The adversarial reconcile test mutates
 *      away the flag check and immediately fails.
 *   2. **Idempotence by construction** — `reconcile` on a state where every
 *      dir is already `installed` produces zero installs (all `skip:
 *      already-installed`). That is what lets launchd re-fire the watcher on
 *      unrelated writes into the watched parent without over-installing.
 *
 * @module
 */

import type { DirState } from "./scan.ts";

/** The output shape the watcher runtime consumes. */
export type Actions = {
	/** Version dirs that need `install()` to run. */
	install: string[];
	/** Reserved for future symmetry — currently always empty. */
	uninstall: string[];
	/** Dirs the watcher intentionally leaves alone, with a reason. */
	skip: Array<{ path: string; reason: string }>;
};

/**
 * Route each `DirState` into `install` / `skip` per the gate + mapping rules
 * pinned in the module docstring. Never throws.
 *
 * @param {DirState[]} states - Output of `scanClaudeCodeDirs`.
 * @param {{flag: boolean}} opts - `flag` is the resolved
 *   CLAUDE_MULTIACCT_ENABLE_SHIM state.
 * @returns {Actions} The per-dir plan.
 */
export function reconcile(states: readonly DirState[], opts: { flag: boolean }): Actions {
	const actions: Actions = { install: [], uninstall: [], skip: [] };
	if (!opts.flag) {
		for (const s of states) {
			actions.skip.push({ path: s.path, reason: "flag-off" });
		}
		return actions;
	}
	for (const s of states) {
		if (s.kind === "uninstalled") {
			actions.install.push(s.path);
		} else if (s.kind === "installed") {
			actions.skip.push({ path: s.path, reason: "already-installed" });
		} else {
			actions.skip.push({ path: s.path, reason: s.reason ?? "other" });
		}
	}
	return actions;
}
