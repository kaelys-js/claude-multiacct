// Behavior tests for `@foundation/agents`'s log() primitive.
//
// WHY it matters: log() is the workflow's stdout — TRP's fix-task calls it 50+
// times per run. If it dropped the message body (e.g. truncated), the journal
// would lose narration. If it filtered by some heuristic, an operator's `log`
// call could silently disappear. These tests fix the pass-through contract.

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, log, resetWorkflow } from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

describe("log", () => {
	it("emits a log-kind journal entry carrying the exact message", () => {
		log("mode=solve is_spike=false");
		const entries = drainJournal();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "log",
			message: "mode=solve is_spike=false",
		});
	});

	it("preserves empty strings without dropping the entry", () => {
		log("");
		const entries = drainJournal();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "log", message: "" });
	});

	it("preserves messages with embedded quotes and newlines", () => {
		log('style: voice="Direct, focused"\ndetail=none');
		const entries = drainJournal();
		expect(entries[0]).toMatchObject({
			kind: "log",
			message: 'style: voice="Direct, focused"\ndetail=none',
		});
	});

	it("returns undefined so it cannot be used as a gate value", () => {
		const result = log("x");
		expect(result).toBeUndefined();
	});
});
