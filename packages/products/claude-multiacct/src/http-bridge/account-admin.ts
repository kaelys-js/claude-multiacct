/**
 * `@foundation/claude-multiacct` — bridge add/remove orchestration.
 *
 * Binds the daemon's `POST /accounts` and `DELETE /accounts/:uuid` routes to
 * the library-callable pool mutations in `cli/commands.ts`, translating their
 * classified result unions into the `{status, reason, detail}` outcome the
 * pure route handlers emit. The routes never import `cli/commands.ts`
 * directly; they take the two functions built here as injected ports, so a
 * route test can substitute a fake without a keychain or a registry file.
 *
 * # The OAuth sign-in handoff
 *
 * Adding an account needs an OAuth token that belongs to a real Anthropic
 * account. Acquiring that token is the ONE step performed outside the daemon:
 * the user signs in to the target account (in Claude.app or at claude.ai),
 * copies its OAuth token, and the picker forwards it in the `POST /accounts`
 * body. The daemon then proves the token via the injected `verify` port
 * (`cliPorts.verify`, wired to `oauth/verify.ts::verifyToken`, which spawns the
 * real `claude` CLI). That verify port is the mock seam: unit + integration
 * tests inject a fake `verify` so no real sign-in ever happens, while the live
 * daemon runs the genuine subprocess. Nothing here holds a token — it flows
 * straight into `provisionAccount`, which stores it in the keychain.
 *
 * # Fail-closed removal
 *
 * `removeAccount` (in `cli/commands.ts`) deletes the keychain token BEFORE the
 * registry write and rolls the token back if the registry write fails, so a
 * failing/locked keychain aborts with `token_store_failed` and the registry is
 * left intact (fail closed). It addresses exactly one uuid, so a removal can
 * never delete more than its target — the guard the legacy over-broad-delete
 * incident demands.
 *
 * @module
 */

import {
	addAccount as libAddAccount,
	type CliPorts,
	removeAccount as libRemoveAccount,
	type SkippedResult,
} from "../cli/commands.ts";
import type { ProvisionFailKind } from "../oauth/models.ts";
import type {
	AddAccountFn,
	AddAccountOutcome,
	RemoveAccountFn,
	RemoveAccountOutcome,
} from "./routes.ts";

/** Ports the orchestration binds. `env` gates the mutating library commands. */
export type AdminDeps = {
	cliPorts: CliPorts;
	/** Env source read for the feature-flag gate. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
};

/**
 * Narrow the shared flag-off skip shape out of a command result union.
 *
 * @param {object} result - The union result to narrow.
 * @returns {boolean} True iff `result` is the flag-off skip.
 */
function isSkipped(result: { ok: boolean }): result is SkippedResult {
	return result.ok === false && "skipped" in result && (result as SkippedResult).skipped === true;
}

/**
 * HTTP status per provision failure kind. A bad token is the caller's fault
 * (400); a duplicate is a conflict (409); a store/registry failure is ours
 * (500). `skipped` is handled before this map is consulted, but is listed for
 * type-exhaustiveness.
 */
const PROVISION_STATUS: Record<ProvisionFailKind, number> = {
	verify_failed: 400,
	duplicate_label: 409,
	duplicate_uuid: 409,
	skipped: 403,
	registry_write_failed: 500,
	token_store_failed: 500,
};

/** HTTP status per remove failure reason. */
const REMOVE_STATUS: Record<"not_found" | "registry_write_failed" | "token_store_failed", number> =
	{
		not_found: 404,
		registry_write_failed: 500,
		token_store_failed: 500,
	};

/**
 * Build the `AddAccountFn` the route injects. Delegates to
 * `cli/commands.ts::addAccount` (verify → duplicate checks → atomic
 * keychain+registry write with token rollback) and classifies the result.
 *
 * @param {AdminDeps} deps - Injected ports.
 * @returns {AddAccountFn} A function the route calls with `{label, token}`.
 */
export function makeAddAccount(deps: AdminDeps): AddAccountFn {
	return async ({ label, token }): Promise<AddAccountOutcome> => {
		const result = await libAddAccount({
			label,
			token,
			ports: deps.cliPorts,
			env: deps.env,
		});
		if (result.ok) {
			return { ok: true, account: result.account };
		}
		if (isSkipped(result)) {
			return { ok: false, status: 403, reason: "flag-off", detail: result.reason };
		}
		return {
			ok: false,
			status: PROVISION_STATUS[result.kind],
			reason: result.kind,
			detail: result.detail,
		};
	};
}

/**
 * Build the `RemoveAccountFn` the route injects. Delegates to
 * `cli/commands.ts::removeAccount` (fail-closed, target-only) and classifies
 * the result.
 *
 * @param {AdminDeps} deps - Injected ports.
 * @returns {RemoveAccountFn} A function the route calls with a uuid.
 */
export function makeRemoveAccount(deps: AdminDeps): RemoveAccountFn {
	return async (uuid): Promise<RemoveAccountOutcome> => {
		const result = await libRemoveAccount({
			selector: { uuid },
			ports: deps.cliPorts,
			env: deps.env,
		});
		if (result.ok) {
			return { ok: true, removed: result.removed };
		}
		if (isSkipped(result)) {
			return { ok: false, status: 403, reason: "flag-off", detail: result.reason };
		}
		return {
			ok: false,
			status: REMOVE_STATUS[result.reason],
			reason: result.reason,
			detail: result.detail,
		};
	};
}
