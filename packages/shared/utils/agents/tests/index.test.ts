// Behavior test for the `@foundation/agents` barrel.
//
// WHY it matters: the barrel is the contract every consumer imports from. If a
// symbol silently disappears (rename, refactor), downstream builds break with a
// runtime `undefined is not a function` rather than a compile error. One check
// per public symbol keeps the barrel honest across refactors.

import { describe, expect, it } from "vitest";
import {
	agent,
	budget,
	chargeBudget,
	drainJournal,
	getHost,
	getState,
	installReplayHost,
	log,
	makeReplayHost,
	parallel,
	phase,
	pipeline,
	replayKey,
	resetWorkflow,
	setHost,
	setTotalBudget,
} from "../src/index.ts";

describe("@foundation/agents barrel", () => {
	it("exports every primitive as a callable", () => {
		expect(typeof agent).toBe("function");
		expect(typeof parallel).toBe("function");
		expect(typeof pipeline).toBe("function");
		expect(typeof phase).toBe("function");
		expect(typeof log).toBe("function");
	});

	it("exports budget as an object with the documented methods", () => {
		expect(typeof budget.total).toBe("function");
		expect(typeof budget.spent).toBe("function");
		expect(typeof budget.remaining).toBe("function");
		expect(typeof budget.setTotal).toBe("function");
		expect(typeof budget.charge).toBe("function");
	});

	it("exports host controls", () => {
		expect(typeof setHost).toBe("function");
		expect(typeof getHost).toBe("function");
		expect(typeof resetWorkflow).toBe("function");
		expect(typeof drainJournal).toBe("function");
		expect(typeof getState).toBe("function");
		expect(typeof setTotalBudget).toBe("function");
		expect(typeof chargeBudget).toBe("function");
	});

	it("exports the replay adapter surface", () => {
		expect(typeof makeReplayHost).toBe("function");
		expect(typeof installReplayHost).toBe("function");
		expect(typeof replayKey).toBe("function");
		expect(replayKey("PhaseA", "label-x")).toBe("PhaseA:label-x");
	});
});
