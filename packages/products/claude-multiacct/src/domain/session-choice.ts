/**
 * `@foundation/claude-multiacct` — Session→Account choice model.
 *
 * A `SessionAccountChoice` is a single sticky binding between a Claude Code
 * session (`sessionUuid`) and a pooled account (`accountUuid`), stamped with
 * the moment it was made. The choice store maps `sessionUuid → choice`; the
 * routing shim reads it on every prompt so the same session keeps hitting the
 * same account across process boundaries and restarts.
 *
 * The load-bearing invariant here is the ABSENT case: a session with no
 * recorded choice must resolve to `undefined`, so the caller (the future
 * routing shim) can transparently fall back to the primary account. That
 * fallback is why the model exists at all — the runtime treats "I have no
 * opinion about this session" as a first-class state, not an error.
 *
 * `resolveChoice` also takes the `AccountRegistry` so it can return a
 * resolved `Account`: a choice whose `accountUuid` no longer matches any
 * registered account (an account was removed after the choice was written)
 * resolves to `undefined`, same as absent. That keeps the shim's fallback
 * path uniform — the shim never has to distinguish "no choice" from
 * "stale choice", both mean "use the primary".
 *
 * @module
 */

import * as v from "valibot";
import { type Account, AccountUuidSchema } from "./account.ts";
import { type AccountRegistry, byUuid } from "./registry.ts";

/** The Code session UUID is a plain uuid — no brand needed at this layer. */
const SessionUuidSchema = v.pipe(v.string(), v.uuid());

/** ISO-8601 timestamp string, e.g. `2026-07-19T12:00:00.000Z`. */
const IsoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

/**
 * One recorded choice. `strictObject` so a typo (`session_uuid` vs
 * `sessionUuid`) in a hand-edited choices file fails validation instead of
 * silently producing a choice with an undefined uuid.
 */
export const SessionAccountChoiceSchema = v.strictObject({
	sessionUuid: SessionUuidSchema,
	accountUuid: AccountUuidSchema,
	chosenAt: IsoTimestampSchema,
});
export type SessionAccountChoice = v.InferOutput<typeof SessionAccountChoiceSchema>;

/**
 * The persisted store shape: a record keyed by `sessionUuid`. `v.record`
 * cannot enforce that the key equals `value.sessionUuid`, so
 * `ChoiceStoreStateSchema` adds that cross-field check — a mismatch is
 * almost certainly a corrupted file and must not resolve to an unexpected
 * account. Named `...State` to distinguish it from the `ChoiceStoreState` port
 * interface (an I/O adapter), defined in `../ports.ts`.
 */
export const ChoiceStoreStateSchema = v.pipe(
	v.record(SessionUuidSchema, SessionAccountChoiceSchema),
	v.check(
		(store) => Object.entries(store).every(([key, choice]) => key === choice.sessionUuid),
		"ChoiceStoreState keys must equal the sessionUuid of the stored choice",
	),
);
export type ChoiceStoreState = v.InferOutput<typeof ChoiceStoreStateSchema>;

/**
 * Serialize a validated store to a stable JSON string. Kept trivial — the
 * point of the wrapper is that callers go through a named function rather
 * than reaching for `JSON.stringify` and drifting on formatting.
 *
 * @param {ChoiceStoreState} store - A validated store to serialize.
 * @returns {string} A JSON string representation of `store`.
 */
export function serializeChoiceStoreState(store: ChoiceStoreState): string {
	return JSON.stringify(store);
}

/**
 * Parse and validate a serialized store. Throws on malformed input.
 *
 * @param {string} raw - JSON text emitted by `serializeChoiceStoreState`.
 * @returns {ChoiceStoreState} The validated store.
 */
export function parseChoiceStoreState(raw: string): ChoiceStoreState {
	return v.parse(ChoiceStoreStateSchema, JSON.parse(raw) as unknown);
}

/**
 * Resolve a session's stuck account.
 *
 * Returns `undefined` when the session has no recorded choice OR when the
 * recorded choice points at an account no longer in the registry. Both cases
 * are the shim's "fall back to primary" signal.
 *
 * @param {ChoiceStoreState} store - The validated choice store.
 * @param {AccountRegistry} registry - The validated registry to resolve against.
 * @param {string} sessionUuid - The Code session uuid to look up.
 * @returns {Account | undefined} The pinned account, or `undefined` when
 *   absent or stale.
 */
export function resolveChoice(
	store: ChoiceStoreState,
	registry: AccountRegistry,
	sessionUuid: string,
): Account | undefined {
	const choice = store[sessionUuid];
	if (choice === undefined) {
		return undefined;
	}
	return byUuid(registry, choice.accountUuid);
}
