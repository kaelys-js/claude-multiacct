// Behavior tests for `replay-normalize.ts`.
//
// WHY it matters: the parity comparator relies on this pipeline to rebuild
// the exact byte-for-byte shape the fixture-prep step wrote. Counter drift
// (ts sequence not starting at 0, per-kind id counters bleeding across
// runs, or the walker missing a nested object) breaks parity silently,
// which reads as an unrelated regression at the caller. These tests pin
// the contract: counters reset to zero, ts is a monotonic sequence,
// each id kind counts independently, and the walker descends into every
// nested container without touching non-target fields.

import { describe, it, expect, beforeEach } from "vitest";
import {
	RANDOM_ID_FIELDS,
	TS_START,
	normalizeJournal,
	normalizeReturn,
	resetCounters,
} from "./replay-normalize.ts";

beforeEach(() => {
	resetCounters();
});

describe("module constants", () => {
	it("exposes RANDOM_ID_FIELDS as the four id kinds the pipeline knows", () => {
		expect(RANDOM_ID_FIELDS).toEqual(["agentId", "workflowRunId", "sessionId", "requestId"]);
	});

	it("pins TS_START at 0 (the fixture-prep contract)", () => {
		expect(TS_START).toBe(0);
	});
});

describe("resetCounters", () => {
	it("zeros ts so the next journal starts at TS_START again", () => {
		normalizeReturn({ ts: 1234 });
		normalizeReturn({ ts: 5678 });
		resetCounters();
		expect(normalizeReturn({ ts: 999 })).toEqual({ ts: TS_START });
	});

	it("zeros the per-kind id counters", () => {
		normalizeReturn({ agentId: "real-a", workflowRunId: "real-wf" });
		resetCounters();
		expect(normalizeReturn({ agentId: "x", workflowRunId: "y" })).toEqual({
			agentId: "test-agent-0",
			workflowRunId: "test-wf-0",
		});
	});

	it("keeps runs independent when called between it() blocks", () => {
		// The beforeEach() at the top of the file calls resetCounters(),
		// so this test's first ts must be 0 regardless of what earlier
		// tests did. If isolation broke, the value would be non-zero.
		expect(normalizeReturn({ ts: 42 })).toEqual({ ts: 0 });
	});
});

describe("ts normalization", () => {
	it("replaces the first ts encounter with TS_START (0)", () => {
		expect(normalizeReturn({ ts: "anything" })).toEqual({ ts: 0 });
	});

	it("issues a monotonic sequence across multiple ts occurrences", () => {
		const out = normalizeJournal([
			{ ts: 100, kind: "A" },
			{ ts: 200, kind: "B" },
			{ ts: 300, kind: "C" },
		]);
		expect(out).toEqual([
			{ ts: 0, kind: "A" },
			{ ts: 1, kind: "B" },
			{ ts: 2, kind: "C" },
		]);
	});

	it("counts ts in insertion order across nested objects", () => {
		const out = normalizeReturn({
			ts: "outer",
			inner: { ts: "middle", deeper: { ts: "deepest" } },
			tail: { ts: "last" },
		});
		expect(out).toEqual({
			ts: 0,
			inner: { ts: 1, deeper: { ts: 2 } },
			tail: { ts: 3 },
		});
	});

	it("counts ts inside arrays too", () => {
		const out = normalizeReturn({
			entries: [{ ts: "a" }, { ts: "b" }],
		});
		expect(out).toEqual({
			entries: [{ ts: 0 }, { ts: 1 }],
		});
	});
});

describe("RANDOM_ID_FIELDS normalization", () => {
	it("replaces agentId with test-agent-N", () => {
		const out = normalizeJournal([
			{ agentId: "real-1" },
			{ agentId: "real-2" },
			{ agentId: "real-3" },
		]);
		expect(out).toEqual([
			{ agentId: "test-agent-0" },
			{ agentId: "test-agent-1" },
			{ agentId: "test-agent-2" },
		]);
	});

	it("replaces workflowRunId with test-wf-N", () => {
		const out = normalizeJournal([{ workflowRunId: "x" }, { workflowRunId: "y" }]);
		expect(out).toEqual([{ workflowRunId: "test-wf-0" }, { workflowRunId: "test-wf-1" }]);
	});

	it("replaces sessionId with test-session-N", () => {
		const out = normalizeJournal([{ sessionId: "s1" }, { sessionId: "s2" }]);
		expect(out).toEqual([{ sessionId: "test-session-0" }, { sessionId: "test-session-1" }]);
	});

	it("replaces requestId with test-request-N", () => {
		const out = normalizeJournal([{ requestId: "r1" }, { requestId: "r2" }]);
		expect(out).toEqual([{ requestId: "test-request-0" }, { requestId: "test-request-1" }]);
	});

	it("keeps per-kind counters independent (each starts at 0)", () => {
		const out = normalizeReturn({
			agentId: "a",
			workflowRunId: "b",
			sessionId: "c",
			requestId: "d",
		});
		expect(out).toEqual({
			agentId: "test-agent-0",
			workflowRunId: "test-wf-0",
			sessionId: "test-session-0",
			requestId: "test-request-0",
		});
	});

	it("keeps counting across nested objects and arrays", () => {
		const out = normalizeReturn({
			agentId: "outer",
			nested: {
				agentId: "middle",
				more: [{ agentId: "in-array" }],
			},
		});
		expect(out).toEqual({
			agentId: "test-agent-0",
			nested: {
				agentId: "test-agent-1",
				more: [{ agentId: "test-agent-2" }],
			},
		});
	});
});

describe("nested walker", () => {
	it("descends into nested objects", () => {
		const out = normalizeReturn({
			a: { b: { c: { agentId: "deep" } } },
		});
		expect(out).toEqual({
			a: { b: { c: { agentId: "test-agent-0" } } },
		});
	});

	it("descends into arrays and applies the same rules to each element", () => {
		const out = normalizeReturn([
			{ ts: "1", agentId: "a" },
			{ ts: "2", agentId: "b" },
		]);
		expect(out).toEqual([
			{ ts: 0, agentId: "test-agent-0" },
			{ ts: 1, agentId: "test-agent-1" },
		]);
	});

	it("handles mixed nesting: object -> array -> object", () => {
		const out = normalizeReturn({
			runs: [
				{ workflowRunId: "wf-a", steps: [{ ts: "t0" }, { ts: "t1" }] },
				{ workflowRunId: "wf-b", steps: [{ ts: "t2" }] },
			],
		});
		expect(out).toEqual({
			runs: [
				{ workflowRunId: "test-wf-0", steps: [{ ts: 0 }, { ts: 1 }] },
				{ workflowRunId: "test-wf-1", steps: [{ ts: 2 }] },
			],
		});
	});

	it("passes non-normalized fields through untouched", () => {
		const input = {
			name: "keep-me",
			count: 42,
			flag: true,
			pi: 3.14,
			nested: { keep: "also" },
			tags: ["x", "y", "z"],
		};
		expect(normalizeReturn(input)).toEqual(input);
	});

	it("does not mutate the input object", () => {
		const input = { ts: "orig", inner: { agentId: "orig-a" } };
		const snapshot = structuredClone(input);
		normalizeReturn(input);
		expect(input).toEqual(snapshot);
	});
});

describe("edge cases", () => {
	it("returns null unchanged (typeof null === 'object' branch is guarded)", () => {
		expect(normalizeReturn(null)).toBeNull();
	});

	it("returns undefined unchanged", () => {
		expect(normalizeReturn(undefined)).toBeUndefined();
	});

	it("returns primitives unchanged at the top level", () => {
		expect(normalizeReturn("hello")).toBe("hello");
		expect(normalizeReturn(42)).toBe(42);
		expect(normalizeReturn(true)).toBe(true);
		expect(normalizeReturn(false)).toBe(false);
	});

	it("returns arrays at the top level, walking each element", () => {
		expect(normalizeReturn([1, 2, 3])).toEqual([1, 2, 3]);
		expect(normalizeReturn([{ ts: "a" }, { ts: "b" }])).toEqual([{ ts: 0 }, { ts: 1 }]);
	});

	it("handles empty containers", () => {
		expect(normalizeReturn({})).toEqual({});
		expect(normalizeReturn([])).toEqual([]);
		expect(normalizeJournal([])).toEqual([]);
	});

	it("handles null values inside an object without descending", () => {
		expect(normalizeReturn({ maybe: null, ts: "1" })).toEqual({
			maybe: null,
			ts: 0,
		});
	});

	it("handles arrays containing null and primitive elements", () => {
		expect(normalizeReturn({ list: [null, 1, "s", { ts: "x" }] })).toEqual({
			list: [null, 1, "s", { ts: 0 }],
		});
	});
});

describe("normalizeJournal", () => {
	it("returns a new array (does not reuse the input reference)", () => {
		const input = [{ ts: "a" }];
		const out = normalizeJournal(input);
		expect(out).not.toBe(input);
		expect(out[0]).not.toBe(input[0]);
	});

	it("preserves entry ordering", () => {
		const out = normalizeJournal([
			{ kind: "first", ts: "1" },
			{ kind: "second", ts: "2" },
			{ kind: "third", ts: "3" },
		]);
		expect(out.map((e) => e.kind)).toEqual(["first", "second", "third"]);
	});
});
