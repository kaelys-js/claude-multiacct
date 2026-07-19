/**
 * `@foundation/mutations` — the gate helper.
 *
 * `withMutation()` wraps any function that would touch remote state (GitHub
 * write, ClickUp write, memex PR creation, calendar send, git push) or write
 * a file that ends up checked in and shared. The default is dry-run: unless
 * both `MUTATIONS_ENABLED` AND the per-service
 * flag are armed, `execute()` is never called and the plan is logged with
 * the `[DRY-RUN] would call <action> with args {...}` shape the task
 * specifies. When both flags are armed, `execute()` runs exactly once and
 * the result flows back through the returned `MutationOutcome`.
 *
 * The helper takes NO ambient dependency on `process.env` — the caller
 * parses env once at boot (via `parseMutationsEnv`) and passes the result
 * in. That keeps tests deterministic and closes the "sourced .env silently
 * armed a mutation" foot-gun.
 *
 * @module
 */

import * as v from "valibot";
import { SERVICE_FLAGS, type MutationsEnv } from "./env.ts";
import {
	MutationPlanSchema,
	type Logger,
	type MutationOutcome,
	type MutationPlan,
} from "./types.ts";

// Default logger — writes one line per event to `process.stderr` (never
// stdout, never `console.log`). `data` is JSON-serialised onto the same
// line so tail/grep on stderr produces one log entry per line. The internal
// callers below always pass a data object, so `JSON.stringify` receives a
// real value; a Logger caller that omits `data` will see `undefined` on the
// line, which is a loud signal that the caller is skipping context.
// Hoisted to module scope to satisfy unicorn/consistent-function-scoping —
// the writer closes over no test/factory state.
function writeStderrLine(msg: string, data?: unknown): void {
	process.stderr.write(`${msg} ${JSON.stringify(data)}\n`);
}

function defaultLogger(): Logger {
	return {
		info: writeStderrLine,
		warn: writeStderrLine,
	};
}

export type WithMutationOpts = {
	// Parsed env. The caller runs `parseMutationsEnv(process.env)` once at
	// boot and reuses the result — re-parsing per call would mask env drift
	// caught at boot and add work on the hot path.
	readonly env: MutationsEnv;
	// Optional logger override. When absent, a stderr writer is used. The
	// task rules forbid `console.log`, so consumers that want to route logs
	// elsewhere pass their own here.
	readonly logger?: Logger;
};

/**
 * Gate a remote mutation behind the pair of env flags.
 *
 * When either the global `MUTATIONS_ENABLED` or the per-service flag is
 * not armed, this function logs the intended call and returns without
 * invoking `execute()`. When both are armed, it calls `execute()` exactly
 * once and returns the awaited result.
 *
 * @param {MutationPlan} plan - The intended remote change; parsed through
 *   `MutationPlanSchema` so a typo in `service` fails loud at parse time.
 * @param {() => Promise<T>} execute - Zero-argument thunk that performs the
 *   actual remote call. Invoked exactly once when both env flags are armed,
 *   and never otherwise.
 * @param {WithMutationOpts} opts - Parsed env (from `parseMutationsEnv`) plus
 *   an optional logger override; the default logger writes structured lines
 *   to `process.stderr`.
 * @returns {Promise<MutationOutcome<T>>} A `MutationOutcome<T>` —
 *   `{ mutated: false, ... }` on dry-run, `{ mutated: true, result }` when
 *   armed and `execute()` resolved.
 */
export async function withMutation<T>(
	plan: MutationPlan,
	execute: () => Promise<T>,
	opts: WithMutationOpts,
): Promise<MutationOutcome<T>> {
	const parsedPlan = v.parse(MutationPlanSchema, plan);
	const logger = opts.logger ?? defaultLogger();
	const flagName = SERVICE_FLAGS[parsedPlan.service];
	/* v8 ignore start -- MutationsEnv fields are boolean (BoolFlagSchema.transform coerces undefined to false at parseMutationsEnv time); the ?? false fallback is defensive TypeScript-narrowing and unreachable at runtime */
	const globalEnabled = opts.env.MUTATIONS_ENABLED ?? false;
	const serviceEnabled = opts.env[flagName] ?? false;
	/* v8 ignore stop */
	const armed = globalEnabled && serviceEnabled;

	if (!armed) {
		logger.info(
			`[DRY-RUN] would call ${parsedPlan.action} with args ${JSON.stringify(parsedPlan.args)}`,
			{
				service: parsedPlan.service,
				serviceFlag: flagName,
				globalEnabled,
				serviceEnabled,
			},
		);
		return {
			mutated: false,
			reason: "dry-run",
			plan: parsedPlan,
			gate: { globalEnabled, serviceEnabled },
			result: null,
		};
	}

	const result = await execute();
	logger.info(`[APPLIED] ${parsedPlan.action}`, { service: parsedPlan.service });
	return { mutated: true, plan: parsedPlan, result };
}
