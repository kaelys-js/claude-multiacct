/**
 * `@foundation/claude-multiacct` — Usage snapshot model.
 *
 * A `UsageSnapshot` is a point-in-time reading of how much of an account's
 * quota remains. The router uses it to skip accounts that are exhausted or
 * near-exhausted, and to prefer accounts with more headroom under load.
 *
 * `remainingRatio` is modelled as `number ∈ [0, 1] | "unknown"`. The literal
 * `"unknown"` is deliberate: the underlying `/usage` endpoint returns a
 * number for most tiers but returns nothing for a few (some legacy tiers,
 * some enterprise plans), and the router must distinguish "we know this
 * account has 5% left" from "we have no reading at all". Collapsing them to
 * `null` or `0` would either quietly retire healthy accounts or route to
 * exhausted ones.
 *
 * @module
 */

import * as v from "valibot";
import { AccountUuidSchema } from "./account.ts";

/** ISO-8601 timestamp for the quota reset moment. */
const IsoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

/**
 * Ratio in `[0, 1]` OR the literal `"unknown"`. Values outside `[0, 1]`
 * (negative, > 1, `NaN`) fail validation — the endpoint has been observed
 * to return over-1 numbers when a quota is temporarily miscounted, and we
 * would rather reject than let downstream heuristics divide by them.
 */
export const RemainingRatioSchema = v.union([
	v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
	v.literal("unknown"),
]);
export type RemainingRatio = v.InferOutput<typeof RemainingRatioSchema>;

/**
 * One usage reading for one account. `strictObject` so an unknown field
 * from a future API version fails loud rather than being silently ignored
 * — better a build break than misrouted traffic.
 */
export const UsageSnapshotSchema = v.strictObject({
	accountUuid: AccountUuidSchema,
	remainingRatio: RemainingRatioSchema,
	tier: v.pipe(v.string(), v.minLength(1)),
	resetAt: IsoTimestampSchema,
});
export type UsageSnapshot = v.InferOutput<typeof UsageSnapshotSchema>;
