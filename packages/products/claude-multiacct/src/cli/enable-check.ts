/**
 * `@foundation/claude-multiacct` — enable-flag check.
 *
 * The single truth-source for "is the shim enabled". PR6b will hand this
 * function's result to every mutating installer as an `overrideFlag`
 * parameter, so the answer to "is this system in cma mode?" has ONE
 * definition and one call site per subsystem.
 *
 * The truth is the OR of two signals:
 *
 *   - env `CLAUDE_MULTIACCT_ENABLE_SHIM === "1"` (PR4's `FLAG_ENV_VAR`).
 *     Preserved so a scripted CI run can force-enable without touching
 *     the on-disk config.
 *   - `config.enabled === true` (persisted via `config-store.ts`).
 *
 * Pure function over its inputs — no `process.env` read here so callers
 * can inject a deterministic env in tests. Rule 5 (deterministic over
 * "clever"): a two-line check with no side effects.
 *
 * @module
 */

import type { CmaConfig } from "./config-store.ts";

/**
 * True iff the shim should behave as enabled for this invocation.
 *
 * @param {object} args - `{env, config}` — inject both explicitly.
 * @param {Record<string, string | undefined>} args.env - Env source.
 * @param {CmaConfig | undefined} args.config - Parsed config (may be undefined pre-init).
 * @returns {boolean} True when either signal says "on".
 */
export function isEnabled(args: {
	env: Record<string, string | undefined>;
	config: CmaConfig | undefined;
}): boolean {
	if (args.env["CLAUDE_MULTIACCT_ENABLE_SHIM"] === "1") {
		return true;
	}
	return args.config?.enabled === true;
}
