/**
 * `@foundation/agents` — workflow-harness primitives promoted from the
 * strach-poc + TRP workflow scripts.
 *
 * Consumers (TRP's 4 workflows and security-pocs' 6 workflows once Item 19
 * lands) import typed primitives instead of relying on runtime globals:
 *
 *     import { agent, parallel, phase, log, budget } from "@foundation/agents";
 *
 * A pluggable Host lets the same primitives run under Claude Code's Workflow
 * harness (production), a replay fixture (E2E proof), or a no-op default
 * (unit tests that only check journal shape).
 *
 * @module
 */

export { agent } from "./agent.ts";
export { parallel } from "./parallel.ts";
export { pipeline, type PipelineStage } from "./pipeline.ts";
export { phase } from "./phase.ts";
export { log } from "./log.ts";
export { budget } from "./budget.ts";
export {
	setHost,
	getHost,
	resetWorkflow,
	drainJournal,
	getState,
	setTotalBudget,
	chargeBudget,
} from "./host.ts";
export {
	makeReplayHost,
	installReplayHost,
	replayKey,
	type ReplayHostOptions,
	type ReplaySession,
} from "./replay.ts";
export { fnv1a, fnv1aJson, getHashMode, setHashMode, type HashMode } from "./hash.ts";
export type {
	AgentOptions,
	AgentRequest,
	Host,
	InferSchema,
	JournalEntry,
	JsonSchema,
	WorkflowState,
} from "./types.ts";
