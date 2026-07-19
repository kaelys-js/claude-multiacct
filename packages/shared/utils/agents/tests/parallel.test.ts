// Behavior tests for `@foundation/agents`'s parallel() primitive.
//
// WHY it matters: parallel() is what fans out preflight cheap-CI, adversarial
// refuter panels, sfp-deep-read per-surface passes. If the output order did
// not mirror the input order, downstream `results[i]` reads by index would
// misroute. If one thunk's rejection collapsed the whole fan-out, a single
// flaky sub-agent would abort a whole preflight round. If parallel-start
// and parallel-end did not bracket the child agent-request entries in the
// journal, journal-based diffing would lose the grouping. These tests fix
// each contract.

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, parallel, resetWorkflow } from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

// Timer thunks lifted out of the it() bodies so each arrow inside a test is
// a plain reference — dodges explicit-function-return-type and
// no-promise-executor-return in one move (the Promise executor lives here,
// with a block body that returns void).

function delayed<T>(value: T, ms: number): () => Promise<T> {
	return () =>
		new Promise<T>((resolve) => {
			setTimeout(() => resolve(value), ms);
		});
}

function immediate<T>(value: T): () => Promise<T> {
	return () => Promise.resolve(value);
}

function reject(message: string): () => Promise<never> {
	return () => Promise.reject(new Error(message));
}

function pushThenDelay(bucket: number[], id: number): () => Promise<string> {
	return async () => {
		bucket.push(id);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});
		return `slot-${id}`;
	};
}

function pushSync(bucket: string[], tag: string, value: string): () => Promise<string> {
	return () => {
		bucket.push(tag);
		return Promise.resolve(value);
	};
}

describe("parallel — order preservation", () => {
	it("returns results in input order regardless of resolution order", async () => {
		const results = await parallel([
			delayed("slow", 30),
			delayed("fast", 5),
			immediate("immediate"),
		]);
		expect(results).toEqual(["slow", "fast", "immediate"]);
	});

	it("returns an empty array when passed no thunks and journals count=0", async () => {
		const results = await parallel([]);
		expect(results).toEqual([]);
		const entries = drainJournal();
		expect(entries.map((e) => e.kind)).toEqual(["parallel-start", "parallel-end"]);
		const start = entries.find((e) => e.kind === "parallel-start");
		const end = entries.find((e) => e.kind === "parallel-end");
		expect(start).toMatchObject({ count: 0 });
		expect(end).toMatchObject({ count: 0, succeeded: 0 });
	});
});

describe("parallel — concurrency", () => {
	it("kicks every thunk before any of them resolves", async () => {
		const startOrder: number[] = [];
		await parallel([
			pushThenDelay(startOrder, 0),
			pushThenDelay(startOrder, 1),
			pushThenDelay(startOrder, 2),
		]);
		expect(startOrder).toEqual([0, 1, 2]);
	});
});

describe("parallel — failure handling", () => {
	it("maps a rejected thunk to null in that slot, keeps neighbours", async () => {
		const results = await parallel([immediate("ok-1"), reject("boom"), immediate("ok-3")]);
		expect(results).toEqual(["ok-1", null, "ok-3"]);
	});

	it("counts non-null slots in the parallel-end journal entry", async () => {
		await parallel<string | null>([
			immediate<string | null>("ok"),
			reject("boom"),
			immediate<string | null>(null),
			immediate<string | null>("ok"),
		]);
		const entries = drainJournal();
		const end = entries.find((e) => e.kind === "parallel-end");
		expect(end).toMatchObject({ count: 4, succeeded: 2 });
	});
});

describe("parallel — journal bracketing", () => {
	it("emits parallel-start before running any thunk and parallel-end after all settle", async () => {
		const emitOrder: string[] = [];
		await parallel([pushSync(emitOrder, "thunk-0", "a"), pushSync(emitOrder, "thunk-1", "b")]);
		const entries = drainJournal();
		const kinds = entries.map((e) => e.kind);
		expect(kinds.at(0)).toBe("parallel-start");
		expect(kinds.at(-1)).toBe("parallel-end");
		expect(emitOrder).toEqual(["thunk-0", "thunk-1"]);
	});
});
