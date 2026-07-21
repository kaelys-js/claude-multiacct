/**
 * `@foundation/agents` — typed sub-agent primitive.
 *
 * `agent()` runs one prompt in a fresh sub-agent context with a JSON Schema
 * pinning the return shape. The host receives the (prompt, label, phase,
 * schema) tuple and answers with a parsed JSON value matching the schema —
 * or `null` on error/timeout, mirroring the observed workflow contract where
 * callers do `results.filter(Boolean)`.
 *
 * The `InferSchema<S>` generic maps the passed schema literal to a TypeScript
 * type so `const style = await agent(prompt, { schema: STYLE_SCHEMA })` types
 * `style.voice` as `string | undefined` without a manual cast. Callers write
 * `as const` on the schema literal for the inference to fire.
 *
 * @module
 */

import { fnv1a, fnv1aJson } from "./hash.ts";
import { getHost } from "./host.ts";
import type { AgentOptions, InferSchema, JsonSchema } from "./types.ts";

export async function agent<S extends JsonSchema>(
	prompt: string,
	opts: AgentOptions<S>,
): Promise<InferSchema<S> | null> {
	const host = getHost();
	const requestTs = host.now();
	host.journalWrite({
		kind: "agent-request",
		label: opts.label,
		phase: opts.phase,
		prompt_hash: fnv1a(prompt),
		schema_hash: fnv1aJson(opts.schema),
		ts: requestTs,
	});
	const response = await host.dispatchAgent({
		prompt,
		label: opts.label,
		phase: opts.phase,
		schema: opts.schema,
	});
	host.journalWrite({
		kind: "agent-response",
		label: opts.label,
		phase: opts.phase,
		ok: response !== null && response !== undefined,
		ts: host.now(),
	});
	return (response ?? null) as InferSchema<S> | null;
}
