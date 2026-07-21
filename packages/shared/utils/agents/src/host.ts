/**
 * `@foundation/agents` — Host adapter machinery.
 *
 * The runtime primitives look up a Host implementation via `getHost()`. The
 * workflow harness (Claude Code's Workflow tool) installs its own host via
 * `setHost()` at startup; tests and the replay proof install a recording or
 * playback host. Default host is a no-op that captures the journal in-process
 * so unit tests can read it via `drainJournal()` without registering a mock.
 *
 * @module
 */

import type { AgentRequest, Host, JournalEntry, WorkflowState } from "./types.ts";

// In-process journal buffer written by the default host. Only meaningful when
// the default host is active — a custom host writes to its own sink.
const defaultJournal: JournalEntry[] = [];

function makeDefaultHost(): Host {
	return {
		dispatchAgent(_request: AgentRequest): Promise<null> {
			// No sub-agent runtime available. Callers in tests must register a
			// replay host or wire the workflow harness. Return null so a
			// consumer's `results.filter(Boolean)` keeps working.
			return Promise.resolve(null);
		},
		journalWrite(entry: JournalEntry): void {
			defaultJournal.push(entry);
		},
		now(): number {
			return Date.now();
		},
	};
}

// Module-scoped WorkflowState. Tests call resetWorkflow() between fixtures so
// prior journals + budgets don't leak.
let currentState: WorkflowState = {
	host: makeDefaultHost(),
	total: 0,
	spent: 0,
};

// Install a host. Returns the previously-installed host so callers can
// restore (mirrors the beforeEach/afterEach pattern).
export function setHost(host: Host): Host {
	const previous = currentState.host;
	currentState = { ...currentState, host };
	return previous;
}

// Restore defaults — used between test fixtures so prior state does not
// bleed across runs.
export function resetWorkflow(opts: { total?: number } = {}): void {
	defaultJournal.length = 0;
	currentState = {
		host: makeDefaultHost(),
		total: opts.total ?? 0,
		spent: 0,
	};
}

// Read and empty the default in-process journal. Only meaningful when the
// default host is active; returns [] if a custom host is installed (because
// a custom host writes to its own sink).
export function drainJournal(): JournalEntry[] {
	const out = [...defaultJournal];
	defaultJournal.length = 0;
	return out;
}

// Internal accessors used by the primitives. Exported so tests validate the
// state machinery without reaching into module-scope internals.
export function getHost(): Host {
	return currentState.host;
}

export function getState(): WorkflowState {
	return currentState;
}

export function setTotalBudget(total: number): void {
	currentState = { ...currentState, total };
}

export function chargeBudget(amount: number): { spent: number; remaining: number } {
	currentState = { ...currentState, spent: currentState.spent + amount };
	return {
		spent: currentState.spent,
		remaining: Math.max(0, currentState.total - currentState.spent),
	};
}
