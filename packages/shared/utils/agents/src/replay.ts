/**
 * `@foundation/agents` — replay adapter for fixture-driven tests.
 *
 * Given a recorded map of (phase:label) → response, `makeReplayHost()`
 * returns a Host that dispatches sub-agent calls by looking up the recorded
 * response, normalizes timestamps to a monotonic counter (so the emitted
 * journal.jsonl is byte-for-byte comparable across runs), and writes
 * JournalEntry values into its own in-process buffer.
 *
 * The normalized-ts + response-map design is what makes the Phase 3 ROADMAP
 * proof ("replay the last recorded TRP workflow run; identical journal.jsonl")
 * a well-defined check. Any workflow module that consumes @foundation/agents
 * primitives can be replayed against a fixture with no extra plumbing.
 *
 * @module
 */

import { setHost } from "./host.ts";
import type { AgentRequest, Host, JournalEntry } from "./types.ts";

// Response-map key format. Exported so fixture authors do not have to
// re-derive the shape from the source.
export function replayKey(phase: string, label: string): string {
	return `${phase}:${label}`;
}

export type ReplayHostOptions = {
	// (phase:label) → recorded response. Missing keys resolve to null so a
	// consumer's `results.filter(Boolean)` keeps working — an incomplete
	// fixture degrades gracefully rather than crashing at dispatch.
	readonly responses: Readonly<Record<string, unknown>>;
};

// A live replay session. `finish()` returns the emitted journal and restores
// the previous host, so a subsequent test does not see this session's state.
export type ReplaySession = {
	finish(): JournalEntry[];
};

export function makeReplayHost(opts: ReplayHostOptions): {
	host: Host;
	drain(): JournalEntry[];
} {
	let counter = 0;
	const buffer: JournalEntry[] = [];
	const host: Host = {
		dispatchAgent(request: AgentRequest): Promise<unknown | null> {
			const key = replayKey(request.phase, request.label);
			const has = Object.hasOwn(opts.responses, key);
			return Promise.resolve(has ? opts.responses[key] : null);
		},
		journalWrite(entry: JournalEntry): void {
			// Overwrite ts with the monotonic counter so replay journals are
			// stable across wall-clock drift. Spread copies the original keys
			// in their declared order; the ts override updates its value in
			// place (V8 preserves insertion order on overwrite).
			buffer.push({ ...entry, ts: counter++ } as JournalEntry);
		},
		now(): number {
			// Fallback for the primitive-level ts. The replay host discards
			// this value in journalWrite (overwrites with counter), but the
			// primitive still needs a number so downstream arithmetic does not
			// NaN out.
			return counter;
		},
	};
	const drain = (): JournalEntry[] => {
		const out = buffer.slice();
		buffer.length = 0;
		return out;
	};
	return { host, drain };
}

// Install a replay host on the current WorkflowState. Returns a session
// object; call `session.finish()` after the workflow completes to read the
// emitted journal and restore the previous host.
export function installReplayHost(opts: ReplayHostOptions): ReplaySession {
	const { host, drain } = makeReplayHost(opts);
	const previous = setHost(host);
	return {
		finish(): JournalEntry[] {
			const entries = drain();
			setHost(previous);
			return entries;
		},
	};
}
