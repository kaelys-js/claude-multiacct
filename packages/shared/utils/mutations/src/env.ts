/**
 * `@foundation/mutations` — env-flag surface.
 *
 * The mutation gate is armed by a pair of env vars: the global kill-switch
 * `MUTATIONS_ENABLED` AND the per-service flag for whichever integration is
 * being called. Either half missing (or set to anything other than exact
 * lowercase `true`) leaves the gate closed and the caller stays in dry-run.
 *
 * Every flag defaults to `false` when unset. `"TRUE"` and `"True"` arm
 * (case-insensitive). `"1"`, `"yes"`, `"on"` stay dry-run. There is no
 * whitespace trim, so `"true "` (trailing space) stays dry-run too — the
 * test suite locks each of those cases.
 *
 * @module
 */

import * as v from "valibot";

// A single env var that arms only on exact lowercase "true" after `toLowerCase()`.
// The transform runs on whatever process.env supplies (a string or undefined).
const BoolFlagSchema = v.pipe(
	v.optional(v.string()),
	v.transform((raw) => (raw ?? "").toLowerCase() === "true"),
);

// The full env surface consumed by withMutation(). Fields default to `false`
// when the underlying env var is unset — v.optional + the transform above
// coerces `undefined` to `false` at parse time.
export const MutationsEnvSchema = v.object({
	MUTATIONS_ENABLED: BoolFlagSchema,
	GITHUB_WRITES_ENABLED: BoolFlagSchema,
	GITHUB_ISSUES_ENABLED: BoolFlagSchema,
	CLICKUP_WRITES_ENABLED: BoolFlagSchema,
	MEMEX_WRITES_ENABLED: BoolFlagSchema,
	GIT_PUSH_ENABLED: BoolFlagSchema,
	CALENDAR_INVITE_ENABLED: BoolFlagSchema,
	FILESYSTEM_WRITES_ENABLED: BoolFlagSchema,
});

// Parsed shape: every field is a boolean.
export type MutationsEnv = v.InferOutput<typeof MutationsEnvSchema>;

// Services the gate discriminates over. Adding a service means adding an env
// flag AND a SERVICE_FLAGS entry AND a picklist member — the compiler catches
// two of those and the test suite catches the third.
//
// `filesystem` covers writes to files that will be checked in and shared
// (the ITC dashboard, evidence-run outputs, regenerated success-metric docs).
// It stays distinct from `git-push` so someone can arm local file writes for
// review without also arming remote pushes.
export const MutationServiceSchema = v.picklist([
	"github",
	"github-issues",
	"clickup",
	"memex",
	"git-push",
	"calendar",
	"filesystem",
]);
export type MutationService = v.InferOutput<typeof MutationServiceSchema>;

// Service → per-service env flag. Kept as a const object (not a Map) so the
// type is a literal-key record and typos fail at compile time.
export const SERVICE_FLAGS = {
	github: "GITHUB_WRITES_ENABLED",
	"github-issues": "GITHUB_ISSUES_ENABLED",
	clickup: "CLICKUP_WRITES_ENABLED",
	memex: "MEMEX_WRITES_ENABLED",
	"git-push": "GIT_PUSH_ENABLED",
	calendar: "CALENDAR_INVITE_ENABLED",
	filesystem: "FILESYSTEM_WRITES_ENABLED",
} as const satisfies Record<MutationService, keyof MutationsEnv>;

// Convenience wrapper — parses a raw env source (typically `process.env`)
// into the branded shape. Callers hold the result for the lifetime of the
// process and pass it into `withMutation()`; re-parsing per call is
// unnecessary and would mask env drift caught at boot.
export function parseMutationsEnv(source: Record<string, string | undefined>): MutationsEnv {
	return v.parse(MutationsEnvSchema, {
		MUTATIONS_ENABLED: source["MUTATIONS_ENABLED"],
		GITHUB_WRITES_ENABLED: source["GITHUB_WRITES_ENABLED"],
		GITHUB_ISSUES_ENABLED: source["GITHUB_ISSUES_ENABLED"],
		CLICKUP_WRITES_ENABLED: source["CLICKUP_WRITES_ENABLED"],
		MEMEX_WRITES_ENABLED: source["MEMEX_WRITES_ENABLED"],
		GIT_PUSH_ENABLED: source["GIT_PUSH_ENABLED"],
		CALENDAR_INVITE_ENABLED: source["CALENDAR_INVITE_ENABLED"],
		FILESYSTEM_WRITES_ENABLED: source["FILESYSTEM_WRITES_ENABLED"],
	});
}
