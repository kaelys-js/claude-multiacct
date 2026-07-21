/**
 * `@foundation/agents` — shared types.
 *
 * Every primitive's public interface routes through these. Kept at one file so
 * consumers can import from the barrel without reaching into subpaths.
 *
 * @module
 */

// JSON Schema shape as consumed by agent(). The harness enforces `required`
// fields at parse time; other keywords are advisory. Deliberately looser than
// the full draft-07 union — sub-agents produce free-form JSON and the shared
// package's job is to type the return, not to validate the schema itself.
// `type` accepts a string or a readonly array of strings per JSON Schema
// draft-07 (e.g. `["string", "null"]` for nullable fields).
export type JsonSchema = {
	readonly type?: string | readonly string[];
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly items?: JsonSchema;
	readonly required?: readonly string[];
	readonly enum?: readonly unknown[];
	readonly [key: string]: unknown;
};

// Map a JSON Schema literal to a TypeScript type. Requires callers to write
// `as const` on the schema literal so the type field narrows to a literal
// string — without it, TypeScript widens to `string` and infer falls back to
// `unknown`. Documented in the README example.
export type InferSchema<S> = S extends {
	readonly type: "object";
	readonly properties: infer P;
}
	? { [K in keyof P]?: InferSchema<P[K]> }
	: S extends { readonly type: "array"; readonly items: infer I }
		? Array<InferSchema<I>>
		: S extends { readonly type: "string"; readonly enum: ReadonlyArray<infer E> }
			? E
			: S extends { readonly type: "string" }
				? string
				: S extends { readonly type: "integer" | "number" }
					? number
					: S extends { readonly type: "boolean" }
						? boolean
						: unknown;

export type AgentOptions<S extends JsonSchema> = {
	readonly label: string;
	readonly phase: string;
	readonly schema: S;
};

export type AgentRequest = {
	readonly prompt: string;
	readonly label: string;
	readonly phase: string;
	readonly schema: JsonSchema;
};

// Discriminated union on `kind`. Field order per variant is stable —
// JSON.stringify emits keys in declared insertion order, so downstream
// byte-for-byte journal comparison works without a normalizer.
export type JournalEntry =
	| { readonly kind: "phase"; readonly title: string; readonly ts: number }
	| { readonly kind: "log"; readonly message: string; readonly ts: number }
	| {
			readonly kind: "agent-request";
			readonly label: string;
			readonly phase: string;
			readonly prompt_hash: string;
			readonly schema_hash: string;
			readonly ts: number;
	  }
	| {
			readonly kind: "agent-response";
			readonly label: string;
			readonly phase: string;
			readonly ok: boolean;
			readonly ts: number;
	  }
	| { readonly kind: "parallel-start"; readonly count: number; readonly ts: number }
	| {
			readonly kind: "parallel-end";
			readonly count: number;
			readonly succeeded: number;
			readonly ts: number;
	  }
	| {
			readonly kind: "pipeline-start";
			readonly items: number;
			readonly stages: number;
			readonly ts: number;
	  }
	| { readonly kind: "pipeline-end"; readonly items: number; readonly ts: number }
	| {
			readonly kind: "budget-charge";
			readonly amount: number;
			readonly spent: number;
			readonly remaining: number;
			readonly ts: number;
	  };

export type Host = {
	// Called by agent() to dispatch to whatever provides the sub-agent runtime.
	// The default host answers null; the workflow harness overrides with a real
	// dispatcher; the replay host answers from a recorded fixture.
	dispatchAgent(request: AgentRequest): Promise<unknown | null>;
	// Called by every primitive after its own work — writes one JournalEntry.
	// The default host writes to an in-process buffer that tests drain; the
	// harness host writes to whatever it uses for tracing; the replay host
	// overrides ts with a monotonic counter and writes to its own buffer.
	journalWrite(entry: JournalEntry): void;
	// Primitives use this for the ts they pass to journalWrite. The replay host
	// discards that value and stamps its own counter, but the primitive still
	// needs a number to construct the JournalEntry.
	now(): number;
};

// Per-workflow "world" the primitives close over. One state per process for
// the common case; tests that want isolation call `resetWorkflow()` between
// runs.
export type WorkflowState = {
	readonly host: Host;
	total: number;
	spent: number;
};
