/**
 * `@foundation/agents` — replay fixture workflow.
 *
 * Shape-equivalent to trp-fix-task.js's phase progression, slimmed to the
 * primitive-exercising minimum: one agent() in TaskRecon, a parallel() of
 * agent()s in PreflightCheap, a pipeline() in Bundle, plus phase/log/budget
 * calls throughout. Given the recorded input + agent-responses fixture, this
 * workflow emits a deterministic journal that byte-for-byte matches the
 * recorded `journal.jsonl` (verbatim copy of the strach-poc workflow run at
 * `~/.claude/projects/-Users-Cole-Beuker-Documents-ttt-work-repos-strach-poc/af28d7d2-bbb1-4b52-b6c3-9a6415cce4b5/subagents/workflows/wf_98c20bb6-7c7/journal.jsonl`).
 *
 * When Item 19/20 migrates the real trp-fix-task.js to a TypeScript module,
 * this fixture gets swapped for the migrated file and the response map is
 * refilled from an instrumented replay pass over a newer recorded run.
 *
 * @module
 */

import { agent, budget, log, parallel, phase, pipeline } from "../../../src/index.ts";

const STYLE_SCHEMA = {
	type: "object",
	properties: { voice: { type: "string" } },
	required: ["voice"],
} as const;

const CHEAP_SCHEMA = {
	type: "object",
	properties: { exit_code: { type: "integer" } },
	required: ["exit_code"],
} as const;

export type FixtureWorkflowArgs = {
	readonly task_id: string;
	readonly client_repo: string;
	readonly items: readonly string[];
};

export type FixtureWorkflowBundle = {
	readonly task_id: string;
	readonly client_repo: string;
	readonly files_to_modify: Array<{ path: string; bytes: number; verified: true } | null>;
	readonly pr_title: string;
};

export async function runFixtureWorkflow(
	args: FixtureWorkflowArgs,
): Promise<FixtureWorkflowBundle> {
	phase("Load");
	log(`workflow start for ${args.task_id}`);
	budget.setTotal(30_000);

	phase("TaskRecon");
	const style = await agent(`Read PR style for ${args.client_repo}`, {
		label: "pr-style",
		phase: "TaskRecon",
		schema: STYLE_SCHEMA,
	});
	const voiceHead = (style?.voice ?? "").slice(0, 40);
	log(`style: voice="${voiceHead}"`);

	phase("PreflightCheap");
	type CheapResult = { exit_code?: number };
	const cheapResults = await parallel<CheapResult>(
		args.items.map(
			(item) => (): Promise<CheapResult | null> =>
				agent(`Run cheap check on ${item}`, {
					label: `cheap:${item}`,
					phase: "PreflightCheap",
					schema: CHEAP_SCHEMA,
				}),
		),
	);
	const passed = cheapResults.filter((r) => r?.exit_code === 0).length;
	log(`cheap: ${passed}/${cheapResults.length} passed`);

	phase("Bundle");
	const bundle = await pipeline(
		args.items,
		(item: string) => Promise.resolve({ path: item, bytes: item.length }),
		(record: { path: string; bytes: number }) =>
			Promise.resolve({
				...record,
				verified: true as const,
			}),
	);
	budget.charge(2500);

	const voiceLead = (style?.voice ?? "").slice(0, 20);
	return {
		task_id: args.task_id,
		client_repo: args.client_repo,
		files_to_modify: bundle,
		pr_title: `security(${args.task_id}): style=${voiceLead}`,
	};
}
