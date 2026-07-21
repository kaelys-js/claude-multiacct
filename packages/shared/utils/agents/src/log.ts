/**
 * `@foundation/agents` — narration channel.
 *
 * `log()` is the workflow's stdout — free-form strings, one entry per call.
 * The observed workflows call `log()` ~50 times per fix-task run for status
 * narration ("mode=solve is_spike=false", "preflight cheap: 3/4 passed").
 * Routing through the host means the harness journals log lines into the
 * same JSONL stream as agent requests and phase markers, so the Phase 3
 * proof ("identical journal.jsonl") is well-defined.
 *
 * @module
 */

import { getHost } from "./host.ts";

export function log(message: string): void {
	const host = getHost();
	host.journalWrite({ kind: "log", message, ts: host.now() });
}
