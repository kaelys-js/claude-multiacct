// Behavior tests for `@foundation/agents`'s pipeline() primitive.
//
// WHY it matters: pipeline() is the shape the Item 19 security-pocs workflows
// will adopt for per-finding-across-stages work. If a stage's null return
// leaked into the next stage's input, downstream code would fault on a nullish
// value. If a thrown stage stopped the whole pipeline, one flaky item would
// abort every neighbour. If stage output did not propagate to the next stage's
// input, the whole primitive would just be `items.map`. These tests fix each
// contract.

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, pipeline, resetWorkflow } from "../src/index.ts";

beforeEach(() => {
	resetWorkflow();
});

// Stage helpers extracted so tests hold no branching or side-effect logic
// inline — vitest's no-conditional-in-test rule expects branches to live
// outside the it() body, and require-await expects async stages to actually
// await something.

type PathRec = { path: string; len: number };
type PathDoubled = PathRec & { doubled: number };

function measure(item: string): Promise<PathRec> {
	return Promise.resolve({ path: item, len: item.length });
}

function doubleLen(record: PathRec): Promise<PathDoubled> {
	return Promise.resolve({ ...record, doubled: record.len * 2 });
}

function stampIndex(seen: number[]): (item: string, index: number) => Promise<string> {
	return (item, index) => {
		seen.push(index);
		return Promise.resolve(`${item}-${index}`);
	};
}

// Short-circuit stage: returns null for one specific input, an object otherwise.
// Kept as a factory so the "sentinel" input is data, not a branch inside the
// test body.
function dropIfMatches(sentinel: string): (item: string) => Promise<{ item: string } | null> {
	return (item) => Promise.resolve(item === sentinel ? null : { item });
}

function verifyItem(
	seen: string[],
): (rec: { item: string }) => Promise<{ item: string; verified: true }> {
	return (rec) => {
		seen.push(rec.item);
		return Promise.resolve({ ...rec, verified: true as const });
	};
}

// Throw stage: throws for one specific input. Factory keeps the branch out
// of the it() body.
function throwIfMatches(sentinel: string): (item: string) => Promise<{ item: string }> {
	const throwStage = (item: string): Promise<{ item: string }> => {
		if (item === sentinel) {
			return Promise.reject(new Error("stage failure"));
		}
		return Promise.resolve({ item });
	};
	return throwStage;
}

function inc(item: number): Promise<number> {
	return Promise.resolve(item + 1);
}

function times2(item: number): Promise<number> {
	return Promise.resolve(item * 2);
}

function tag(item: number): Promise<string> {
	return Promise.resolve(`n=${item}`);
}

function upper(item: string): Promise<string> {
	return Promise.resolve(item.toUpperCase());
}

describe("pipeline — value passing across stages", () => {
	it("passes each stage's output as the next stage's input, per item", async () => {
		const out = await pipeline(["a", "bb", "ccc"], measure, doubleLen);
		expect(out).toEqual([
			{ path: "a", len: 1, doubled: 2 },
			{ path: "bb", len: 2, doubled: 4 },
			{ path: "ccc", len: 3, doubled: 6 },
		]);
	});

	it("exposes the item index to each stage so stages can address the input position", async () => {
		const seenIndices: number[] = [];
		await pipeline(["x", "y", "z"], stampIndex(seenIndices));
		expect(seenIndices).toEqual([0, 1, 2]);
	});
});

describe("pipeline — null short-circuit", () => {
	it("skips subsequent stages when a stage returns null; other items continue", async () => {
		const secondCalls: string[] = [];
		const out = await pipeline(
			["keep", "drop", "keep2"],
			dropIfMatches("drop"),
			verifyItem(secondCalls),
		);
		expect(out).toEqual([
			{ item: "keep", verified: true },
			null,
			{ item: "keep2", verified: true },
		]);
		expect(secondCalls).toEqual(["keep", "keep2"]);
	});

	it("treats a thrown stage as null and continues with other items", async () => {
		const out = await pipeline(["ok", "throw", "ok2"], throwIfMatches("throw"), verifyItem([]));
		expect(out).toEqual([{ item: "ok", verified: true }, null, { item: "ok2", verified: true }]);
	});
});

describe("pipeline — journal bracketing", () => {
	it("emits pipeline-start with (items, stages) and pipeline-end with items", async () => {
		await pipeline([1, 2, 3], inc, times2, tag);
		const entries = drainJournal();
		const start = entries.find((e) => e.kind === "pipeline-start");
		const end = entries.find((e) => e.kind === "pipeline-end");
		expect(start).toMatchObject({ items: 3, stages: 3 });
		expect(end).toMatchObject({ items: 3 });
	});

	it("records items=0 stages=0 for an empty input array with no stages", async () => {
		const out = await pipeline([]);
		expect(out).toEqual([]);
		const entries = drainJournal();
		const start = entries.find((e) => e.kind === "pipeline-start");
		expect(start).toMatchObject({ items: 0, stages: 0 });
	});
});

describe("pipeline — single-stage form", () => {
	it("resolves to the stage's output when only one stage is passed", async () => {
		const out = await pipeline(["alpha", "beta"], upper);
		expect(out).toEqual(["ALPHA", "BETA"]);
	});
});
