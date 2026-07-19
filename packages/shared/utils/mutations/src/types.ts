/**
 * `@foundation/mutations` — shared types.
 *
 * `MutationPlan` describes an intended remote change. `withMutation()` parses
 * every plan through the valibot schema below, so a typo in `service` fails
 * loud at parse time rather than sliding into an unexpected env flag lookup.
 *
 * @module
 */

import * as v from "valibot";
import { MutationServiceSchema } from "./env.ts";

// One planned mutation. `action` is a short human-readable verb (e.g.
// "post PR comment", "create task"); `args` is whatever payload the
// executor will pass to the remote — a raw object literal is fine.
export const MutationPlanSchema = v.object({
	service: MutationServiceSchema,
	action: v.string(),
	args: v.unknown(),
});
export type MutationPlan = v.InferOutput<typeof MutationPlanSchema>;

// Minimal logger surface. Injected by the caller. A default that writes
// structured lines to `process.stderr` is exported from `withMutation.ts`
// so callers that only want the default do not have to wire one.
//
// `data` is optional. When present it is JSON-serialised onto the same
// line, so callers get a single greppable line per event.
export type Logger = {
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
};

// Outcome of a `withMutation()` call. Discriminated union on `mutated` —
// consumers can narrow to `result: T` without a runtime null check.
export type MutationOutcome<T> =
	| {
			readonly mutated: false;
			readonly reason: "dry-run";
			readonly plan: MutationPlan;
			readonly gate: {
				readonly globalEnabled: boolean;
				readonly serviceEnabled: boolean;
			};
			readonly result: null;
	  }
	| {
			readonly mutated: true;
			readonly plan: MutationPlan;
			readonly result: T;
	  };
