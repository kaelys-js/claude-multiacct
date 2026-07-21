// Behavior tests for `@foundation/agents`'s phase() primitive.
//
// WHY it matters: phase() is what groups the workflow's downstream agent() and
// log() entries in the journal. If it silently swallowed the title, replay
// diffs would lose the section boundaries. If it gated execution (returned a
// value the workflow branched on), the observed workflows would already have
// carried the value; they do not — the primitive is purely observability.

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, phase, resetWorkflow, type JournalEntry } from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

// Extracted so the conditional lives outside the it() body — vitest's
// no-conditional-in-test rule expects branches to be data-lifted this way.
function titleOrNull(entry: JournalEntry): string | null {
	return entry.kind === "phase" ? entry.title : null;
}

describe("phase", () => {
	it("emits a phase-kind journal entry carrying the title", () => {
		phase("TaskRecon");
		const entries = drainJournal();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "phase", title: "TaskRecon" });
	});

	it("emits one entry per call in call order", () => {
		phase("Load");
		phase("TaskRecon");
		phase("Bundle");
		const entries = drainJournal();
		expect(entries.map(titleOrNull)).toEqual(["Load", "TaskRecon", "Bundle"]);
	});

	it("returns undefined so it cannot be used as a gate value", () => {
		const result = phase("X");
		expect(result).toBeUndefined();
	});
});
