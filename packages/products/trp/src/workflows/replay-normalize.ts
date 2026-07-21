/**
 * Deterministic normalization pipeline used by the parity comparator
 * (decision #4 — parity comparator as the caller contract).
 *
 * WHY it matters. The fixture-prep pipeline already stripped or replaced
 * every non-deterministic field on the expected-output side; see
 * `tests/fixtures/workflows/<slug>/sanitize-manifest.json` for the audit.
 * The runtime side has to rebuild the same rules so actual output and
 * expected fixture match byte-for-byte.
 *
 * Two exported entry points, one shared counter state:
 *   - `normalizeJournal(entries)` — journal-array shape (a run's trace).
 *   - `normalizeReturn(value)`   — workflow return-object shape (recursive).
 *
 * Rules:
 *   - Every `ts` field encountered, in insertion order, is replaced with a
 *     monotonic counter starting at `TS_START` (0).
 *   - Every field named in `RANDOM_ID_FIELDS` (`agentId`, `workflowRunId`,
 *     `sessionId`, `requestId`) is replaced with `test-<kind>-<N>`, where
 *     `<N>` is the per-kind encounter count and `<kind>` is the short slug
 *     for that field (`agent`, `wf`, `session`, `request`).
 *
 * Counter state is module-local. Callers reset between fixture cases via
 * `resetCounters()`; tests rely on this to keep runs independent.
 *
 * @module
 */

// Structural shape the comparator hands us. Kept minimal — the pipeline
// only cares about `ts` and the named id fields; every other key passes
// through untouched.
export type JournalEntry = Readonly<Record<string, unknown>>;

export const RANDOM_ID_FIELDS = ["agentId", "workflowRunId", "sessionId", "requestId"] as const;
export const TS_START = 0;

// Field name -> short kind slug used in `test-<kind>-<N>`.
const KIND_BY_FIELD: Readonly<Record<(typeof RANDOM_ID_FIELDS)[number], string>> = {
	agentId: "agent",
	workflowRunId: "wf",
	sessionId: "session",
	requestId: "request",
};

const RANDOM_ID_SET: ReadonlySet<string> = new Set(RANDOM_ID_FIELDS);

// Closure-backed state so `resetCounters()` can zero it between cases.
type CounterState = {
	ts: number;
	ids: Map<string, number>;
};

function freshState(): CounterState {
	return { ts: TS_START, ids: new Map() };
}

let state: CounterState = freshState();

export function resetCounters(): void {
	state = freshState();
}

function nextTs(): number {
	const value = state.ts;
	state.ts += 1;
	return value;
}

function nextRandomId(field: string): string {
	const kind = KIND_BY_FIELD[field as (typeof RANDOM_ID_FIELDS)[number]];
	const seen = state.ids.get(field) ?? 0;
	state.ids.set(field, seen + 1);
	return `test-${kind}-${seen}`;
}

// Recursive walker shared by both entry points. Objects walked in
// insertion order so counter assignment matches encounter order.
function walk(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(walk);
	}
	if (value !== null && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(src)) {
			if (key === "ts") {
				out[key] = nextTs();
			} else if (RANDOM_ID_SET.has(key)) {
				out[key] = nextRandomId(key);
			} else {
				out[key] = walk(src[key]);
			}
		}
		return out;
	}
	return value;
}

export function normalizeJournal(entries: JournalEntry[]): JournalEntry[] {
	return entries.map((entry) => walk(entry) as JournalEntry);
}

export function normalizeReturn(value: unknown): unknown {
	return walk(value);
}
