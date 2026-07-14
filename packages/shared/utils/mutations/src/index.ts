/**
 * `@foundation/mutations` — barrel.
 *
 * The gate helper (`withMutation`), the env parser + service map, and the
 * shared types. Consumers import from the barrel; there are no deep
 * subpath exports because the package's surface area is small enough to
 * fit in one file's worth of names.
 *
 * @module
 */

export { withMutation, type WithMutationOpts } from "./with-mutation.ts";
export {
	MutationsEnvSchema,
	MutationServiceSchema,
	SERVICE_FLAGS,
	parseMutationsEnv,
	type MutationsEnv,
	type MutationService,
} from "./env.ts";
export {
	MutationPlanSchema,
	type Logger,
	type MutationOutcome,
	type MutationPlan,
} from "./types.ts";
