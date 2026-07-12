// Behavior tests for `@foundation/agents`'s Host + WorkflowState machinery.
//
// WHY it matters: every primitive routes through getHost(). If setHost silently
// dropped the previous host, tests could not isolate. If resetWorkflow leaked
// the journal across runs, fixtures would poison each other. If chargeBudget
// did not clamp remaining at zero, an over-budget workflow would report a
// negative remaining and every consumer would have to guard by hand.

import { beforeEach, describe, expect, it } from "vitest";
import {
	chargeBudget,
	drainJournal,
	getHost,
	getState,
	resetWorkflow,
	setHost,
	setTotalBudget,
	type Host,
} from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

describe("default Host", () => {
	it("dispatches to null so filter(Boolean) keeps working without a registered host", async () => {
		const result = await getHost().dispatchAgent({
			prompt: "any",
			label: "l",
			phase: "p",
			schema: { type: "object" },
		});
		expect(result).toBeNull();
	});

	it("returns a numeric timestamp from now()", () => {
		const now = getHost().now();
		expect(typeof now).toBe("number");
		expect(now).toBeGreaterThan(0);
	});

	it("appends every entry to the drainable in-process buffer", () => {
		getHost().journalWrite({ kind: "phase", title: "X", ts: 1 });
		getHost().journalWrite({ kind: "log", message: "hello", ts: 2 });
		const entries = drainJournal();
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ kind: "phase", title: "X" });
		expect(entries[1]).toMatchObject({ kind: "log", message: "hello" });
	});
});

describe("setHost", () => {
	it("returns the previous host so callers can restore", () => {
		const before = getHost();
		const swap: Host = {
			dispatchAgent: () => Promise.resolve({ swapped: true }),
			journalWrite: (): void => {},
			now: () => 42,
		};
		const previous = setHost(swap);
		expect(previous).toBe(before);
		expect(getHost()).toBe(swap);
	});

	it("routes journalWrite through the installed host and does not touch the default buffer", () => {
		const captured: unknown[] = [];
		setHost({
			dispatchAgent: () => Promise.resolve(null),
			journalWrite: (e) => captured.push(e),
			now: () => 7,
		});
		getHost().journalWrite({ kind: "phase", title: "Y", ts: 7 });
		expect(captured).toHaveLength(1);
		// Default buffer stays empty — a custom host owns its own sink.
		expect(drainJournal()).toEqual([]);
	});
});

describe("resetWorkflow", () => {
	it("clears the default journal, resets budget, and restores the default host", async () => {
		setTotalBudget(1000);
		chargeBudget(300);
		getHost().journalWrite({ kind: "log", message: "leftover", ts: 0 });
		resetWorkflow({ total: 500 });
		expect(getState().total).toBe(500);
		expect(getState().spent).toBe(0);
		const result = await getHost().dispatchAgent({
			prompt: "",
			label: "",
			phase: "",
			schema: {},
		});
		expect(result).toBeNull();
	});

	it("defaults total to 0 when no options passed", () => {
		setTotalBudget(9999);
		resetWorkflow();
		expect(getState().total).toBe(0);
	});
});

describe("chargeBudget + setTotalBudget", () => {
	it("charges are additive and remaining clamps at zero on over-budget", () => {
		setTotalBudget(100);
		const first = chargeBudget(60);
		expect(first).toEqual({ spent: 60, remaining: 40 });
		const second = chargeBudget(80);
		expect(second).toEqual({ spent: 140, remaining: 0 });
	});

	it("mutates the current WorkflowState so getState reflects running totals", () => {
		setTotalBudget(1000);
		chargeBudget(250);
		expect(getState().total).toBe(1000);
		expect(getState().spent).toBe(250);
	});
});

describe("drainJournal", () => {
	it("returns then empties the default buffer, so a second drain sees nothing", () => {
		getHost().journalWrite({ kind: "log", message: "a", ts: 1 });
		expect(drainJournal()).toHaveLength(1);
		expect(drainJournal()).toEqual([]);
	});
});
