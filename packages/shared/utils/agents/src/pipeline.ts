/**
 * `@foundation/agents` — sequential-with-value-passing primitive.
 *
 * `pipeline()` runs each item through each stage in order. Stage N receives
 * stage N-1's output; a `null` from any stage short-circuits that item
 * (subsequent stages skipped) but does not block other items. Overloaded
 * signatures for 1/2/3 stages give inferred types on the way through.
 *
 * No observed workflow uses `pipeline()` yet — shipped for Phase 3 so the
 * six security-pocs workflows Item 19 lands can adopt it instead of
 * hand-rolling per-item chains that re-implement the observability the
 * harness gives to `parallel()`. When callers want concurrent per-item work,
 * they wrap the whole pipeline in `parallel()`.
 *
 * @module
 */

import { getHost } from "./host.ts";

export type PipelineStage<I, O> = (item: I, index: number) => Promise<O | null>;

// Sequential per-item stage chain: applies `stages[k]` to `current`, catches
// a stage throw as null, short-circuits on nullish current, and recurses to
// the next stage. Written recursively so no explicit for/while loop wraps
// the await (per no-await-in-loop) and so the sequential-per-item contract
// stays visible in the shape of the code.
async function runStages(
	item: unknown,
	index: number,
	stages: ReadonlyArray<PipelineStage<unknown, unknown>>,
	k = 0,
): Promise<unknown> {
	if (k === stages.length || item === null || item === undefined) {
		return item;
	}
	const stage = stages[k];
	if (stage === undefined) {
		return item;
	}
	let next: unknown;
	try {
		next = await stage(item, index);
	} catch {
		next = null;
	}
	return runStages(next, index, stages, k + 1);
}

export async function pipeline(items: readonly unknown[]): Promise<unknown[]>;
export async function pipeline<I, S1>(
	items: readonly I[],
	s1: PipelineStage<I, S1>,
): Promise<Array<S1 | null>>;
export async function pipeline<I, S1, S2>(
	items: readonly I[],
	s1: PipelineStage<I, S1>,
	s2: PipelineStage<S1, S2>,
): Promise<Array<S2 | null>>;
export async function pipeline<I, S1, S2, S3>(
	items: readonly I[],
	s1: PipelineStage<I, S1>,
	s2: PipelineStage<S1, S2>,
	s3: PipelineStage<S2, S3>,
): Promise<Array<S3 | null>>;
export async function pipeline(
	items: readonly unknown[],
	...stages: Array<PipelineStage<unknown, unknown>>
): Promise<unknown[]> {
	const host = getHost();
	host.journalWrite({
		kind: "pipeline-start",
		items: items.length,
		stages: stages.length,
		ts: host.now(),
	});
	// Each item's stages run sequentially — a stage sees its predecessor's
	// output. Items across the input array proceed concurrently (a slow item's
	// stages do not block another item's stages). The sequential step-chain
	// per item is written as a self-recursive async function so the linter
	// does not flag an await-in-for-loop.
	const results = await Promise.all(items.map((item, i) => runStages(item, i, stages)));
	const out = results.map((r) => r ?? null);
	host.journalWrite({ kind: "pipeline-end", items: items.length, ts: host.now() });
	return out;
}
