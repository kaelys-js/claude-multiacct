/**
 * `@foundation/agents` — parallel fan-out primitive.
 *
 * `parallel()` runs an array of thunks concurrently and returns their results
 * in input order. Failed sub-agents surface as `null` in the result array;
 * callers filter with `results.filter(Boolean)` per the observed workflow
 * contract.
 *
 * Taking thunks (`() => Promise<T>`) rather than raw promises lets callers
 * defer expensive setup — prompt interpolation, schema construction — until
 * the harness is ready to fan out.
 *
 * @module
 */

import { getHost } from "./host.ts";

export async function parallel<T>(
	thunks: ReadonlyArray<() => Promise<T | null>>,
): Promise<Array<T | null>> {
	const host = getHost();
	host.journalWrite({ kind: "parallel-start", count: thunks.length, ts: host.now() });

	// Each thunk owns its own error handling; a rejection surfaces as null in
	// that slot so a partial failure does not collapse the whole fan-out.
	const settled = await Promise.all(
		thunks.map(async (thunk) => {
			try {
				return await thunk();
			} catch {
				return null;
			}
		}),
	);
	const succeeded = settled.filter((r) => r !== null && r !== undefined).length;
	host.journalWrite({
		kind: "parallel-end",
		count: thunks.length,
		succeeded,
		ts: host.now(),
	});
	return settled;
}
