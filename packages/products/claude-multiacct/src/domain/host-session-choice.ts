/**
 * `@foundation/claude-multiacct` — host-session → account choice model.
 *
 * The per-session choice (`session-choice.ts`) is keyed on the CLI session
 * uuid the shim mints. That uuid does NOT survive a Claude.app restart: when
 * the user reopens a conversation the launcher spawns a FRESH id-less CLI
 * session, the shim mints a brand-new uuid, and the old choice (keyed on the
 * pre-restart uuid) is never found, so the session falls back to the primary
 * account. That is the "my pick reverts to primary after a restart" bug.
 *
 * A `HostSessionChoice` binds the same account to a STABLE identity instead:
 * `CLAUDE_CODE_HOST_SESSION_ID`, the `local_<uuid>` the desktop app carries for
 * a conversation. Unlike the CLI uuid, that id is the app's own durable handle
 * for the conversation — it is what Claude.app persists in its on-disk store
 * (verified 2026-07-24: the same `local_<uuid>` values appear as the app's
 * IndexedDB `starredIds`, so a starred conversation keeps its id across a
 * restart). Keying the choice on it lets a resumed conversation re-apply its
 * chosen account after the app restarts, even though the CLI uuid changed.
 *
 * The shape mirrors `SessionAccountChoice`: one sticky binding stamped with
 * when it was made. The absent case is still the shim's "fall back to primary"
 * signal — a conversation with no recorded host choice resolves to `undefined`.
 *
 * @module
 */

import * as v from "valibot";
import { AccountUuidSchema } from "./account.ts";

/**
 * The host session id shape. `CLAUDE_CODE_HOST_SESSION_ID` is `local_<uuid>`,
 * but this stays a bounded filename-safe charset rather than a strict
 * `local_`-prefixed uuid: the value keys a per-id sidecar file, so constraining
 * it to `[A-Za-z0-9_-]` (no `/`, no `.`, no traversal) and a length ceiling is
 * what makes an untrusted env value safe to use as a filename, and it keeps the
 * model from breaking if the app ever tweaks the id format.
 */
const HostSessionIdSchema = v.pipe(
	v.string(),
	v.regex(/^[A-Za-z0-9_-]{1,128}$/u, "host session id must be a bounded filename-safe token"),
);

/** ISO-8601 timestamp string, e.g. `2026-07-24T12:00:00.000Z`. */
const IsoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

/**
 * One recorded host-session choice. `strictObject` so a typo in a hand-edited
 * sidecar fails validation instead of silently resolving to an undefined field.
 */
export const HostSessionChoiceSchema = v.strictObject({
	hostSessionId: HostSessionIdSchema,
	accountUuid: AccountUuidSchema,
	chosenAt: IsoTimestampSchema,
});
export type HostSessionChoice = v.InferOutput<typeof HostSessionChoiceSchema>;

/**
 * True iff `id` is a valid host session id (filename-safe, bounded). The store
 * guards on this before ever building a path from the id, so a malformed or
 * hostile `CLAUDE_CODE_HOST_SESSION_ID` can never escape the sidecar directory.
 *
 * @param {string} id - Candidate host session id.
 * @returns {boolean} Whether `id` matches {@link HostSessionIdSchema}.
 */
export function isValidHostSessionId(id: string): boolean {
	return v.safeParse(HostSessionIdSchema, id).success;
}
