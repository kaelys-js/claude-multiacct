// Behavior tests for `@foundation/agents`'s budget namespace.
//
// WHY it matters: Rule 6 says budgets are not advisory. If setTotal did not
// round-trip through total(), a workflow could not know its ceiling. If
// charge() did not accumulate, per-agent costs would silently drop. If
// remaining() went negative, consumer branches like `if (budget.remaining() <
// 5000)` would misroute. If charge() did not journal, replay-fixture diffs
// would lose the cost trail. These tests fix each contract.

import { beforeEach, describe, expect, it } from "vitest";
import { budget, drainJournal, resetWorkflow } from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

describe("budget — setTotal / total / spent / remaining", () => {
	it("round-trips setTotal through total() and starts at spent=0 remaining=total", () => {
		budget.setTotal(30_000);
		expect(budget.total()).toBe(30_000);
		expect(budget.spent()).toBe(0);
		expect(budget.remaining()).toBe(30_000);
	});

	it("remaining defaults to zero when no total is set", () => {
		expect(budget.total()).toBe(0);
		expect(budget.remaining()).toBe(0);
	});
});

describe("budget — charge additivity", () => {
	it("accumulates spent across charge() calls", () => {
		budget.setTotal(10_000);
		budget.charge(2500);
		budget.charge(1500);
		expect(budget.spent()).toBe(4000);
		expect(budget.remaining()).toBe(6000);
	});

	it("clamps remaining at zero on over-budget rather than going negative", () => {
		budget.setTotal(1000);
		budget.charge(1500);
		expect(budget.spent()).toBe(1500);
		expect(budget.remaining()).toBe(0);
	});

	it("returns the post-charge { spent, remaining } from charge() so callers do not have to re-query", () => {
		budget.setTotal(5000);
		const result = budget.charge(1200);
		expect(result).toEqual({ spent: 1200, remaining: 3800 });
	});
});

describe("budget — journal", () => {
	it("emits a budget-charge entry with amount, spent, remaining", () => {
		budget.setTotal(5000);
		budget.charge(750);
		const entries = drainJournal();
		const chargeEntry = entries.find((e) => e.kind === "budget-charge");
		expect(chargeEntry).toMatchObject({
			kind: "budget-charge",
			amount: 750,
			spent: 750,
			remaining: 4250,
		});
	});

	it("does NOT emit a journal entry for setTotal — initialization is not a charge event", () => {
		budget.setTotal(9999);
		const entries = drainJournal();
		expect(entries).toEqual([]);
	});

	it("does NOT emit for total(), spent(), or remaining() reads", () => {
		budget.setTotal(1000);
		drainJournal();
		budget.total();
		budget.spent();
		budget.remaining();
		expect(drainJournal()).toEqual([]);
	});
});
