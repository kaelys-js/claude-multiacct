# @foundation/agents

Workflow-harness primitives promoted from the strach-poc + TRP workflow scripts. Typed `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, and a `budget` singleton, all routed through a pluggable Host so the same code runs under Claude Code's Workflow tool (production), a replay fixture (E2E proof), or a no-op default (unit tests).

## API

```ts
import {
	agent,
	parallel,
	pipeline,
	phase,
	log,
	budget,
	setHost,
	resetWorkflow,
	installReplayHost,
} from "@foundation/agents";

const STYLE_SCHEMA = {
	type: "object",
	properties: { voice: { type: "string" } },
	required: ["voice"],
} as const;

phase("TaskRecon");
const style = await agent("Read the last 5 merged PRs and extract voice.", {
	label: "pr-style",
	phase: "TaskRecon",
	schema: STYLE_SCHEMA,
});
log(`voice: ${(style?.voice ?? "").slice(0, 40)}`);

phase("PreflightCheap");
const results = await parallel(
	paths.map(
		(path) => () =>
			agent(`Run cheap check on ${path}`, {
				label: `cheap:${path}`,
				phase: "PreflightCheap",
				schema: { type: "object", properties: { exit_code: { type: "integer" } } } as const,
			}),
	),
);
```

## Primitives

| Primitive                    | Purpose                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `agent(prompt, opts)`        | One sub-agent call; returns the schema-typed response or `null` on failure.                  |
| `parallel(thunks)`           | Fan out an array of thunks; preserves order; failed slots become `null`.                     |
| `pipeline(items, ...stages)` | Sequential per-item, sequential across stages; `null` from a stage short-circuits that item. |
| `phase(title)`               | Emit a phase marker into the journal.                                                        |
| `log(message)`               | Emit a free-form log line into the journal.                                                  |
| `budget`                     | Namespace for token accounting: `setTotal`, `total`, `spent`, `remaining`, `charge`.         |

## Host adapter

Every primitive resolves through `getHost()`. The default Host writes journal entries into an in-process buffer that tests drain with `drainJournal()`. The workflow harness installs its own Host via `setHost()`. The replay Host (`makeReplayHost` / `installReplayHost`) dispatches by recorded `phase:label` and normalizes timestamps to a monotonic counter so `journal.jsonl` is byte-for-byte diffable across runs.

```ts
import { installReplayHost, resetWorkflow } from "@foundation/agents";

resetWorkflow();
const session = installReplayHost({
	responses: {
		"TaskRecon:pr-style": { voice: "Direct, business-outcome focused prose ..." },
		"PreflightCheap:cheap:apps/handled/src/routes/submit-retroactive.ts": { exit_code: 1 },
	},
});
await runWorkflow(args);
const emitted = session.finish();
// emitted is a JournalEntry[] with ts normalized 0, 1, 2, ...
```

## JournalEntry shape

Every primitive stamps one JournalEntry per call. Shape (discriminated union on `kind`):

- `{ kind: "phase", title, ts }`
- `{ kind: "log", message, ts }`
- `{ kind: "agent-request", label, phase, prompt_hash, schema_hash, ts }`
- `{ kind: "agent-response", label, phase, ok, ts }`
- `{ kind: "parallel-start", count, ts }`
- `{ kind: "parallel-end", count, succeeded, ts }`
- `{ kind: "pipeline-start", items, stages, ts }`
- `{ kind: "pipeline-end", items, ts }`
- `{ kind: "budget-charge", amount, spent, remaining, ts }`

Stable field order per variant; `JSON.stringify(entry)` yields deterministic bytes. The `prompt_hash` and `schema_hash` fields on `agent-request` are FNV-1a 32-bit hex strings covering the prompt body and the JSON-serialized schema — drift detection ships by default; fixture authors opt out with `setHashMode("none")` when hand-authoring expected journals.

## Test-mode `drainJournal()` usage

The default Host writes every JournalEntry into an in-process buffer. Tests read entries via `drainJournal()` with no host swap, no mock wiring, no lifecycle to manage. Call `resetWorkflow()` in `beforeEach` so residue from a prior test doesn't leak.

```ts
import { agent, drainJournal, log, phase, resetWorkflow } from "@foundation/agents";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => resetWorkflow());

describe("workflow shape", () => {
	it("emits phase, agent request/response pair, and log in call order", async () => {
		phase("TaskRecon");
		await agent("prompt body", {
			label: "pr-style",
			phase: "TaskRecon",
			schema: { type: "object" } as const,
		});
		log("done");
		const entries = drainJournal();
		expect(entries.map((e) => e.kind)).toEqual(["phase", "agent-request", "agent-response", "log"]);
	});
});
```

`drainJournal()` empties the buffer as a side effect, so a subsequent call returns `[]`. A test that only checks the tail can drain first to reset, then run the code under test, then drain to read.

## Budget usage example

`budget` is a namespace object: read `total()` / `spent()` / `remaining()` as queries, mutate via `setTotal()` at startup and `charge(amount)` per event. Nothing auto-charges — the workflow decides what to attribute.

```ts
import { agent, budget, log } from "@foundation/agents";

budget.setTotal(30_000);

const style = await agent("Read the last 5 merged PRs and extract voice.", {
	label: "pr-style",
	phase: "TaskRecon",
	schema: STYLE_SCHEMA,
});
const { spent, remaining } = budget.charge(4200);
if (remaining < 5_000) {
	log(`budget low: ${spent}/${budget.total()} — short-circuit remaining stages`);
}
```

`charge()` returns the post-charge `{ spent, remaining }` so callers don't have to re-query. `remaining()` clamps at zero on over-budget — consumers guard with `< 5_000` not `< 0`. Every `charge()` call journals a `budget-charge` entry; the reads (`total`, `spent`, `remaining`) do not journal.

## Why not just runtime globals?

The existing .js workflows (`trp-fix-task.js`, `srp-fix-finding.js`, ...) reference `agent`, `parallel`, `phase`, `log` as free-variable globals injected by the workflow harness. That works but gives no types, no unit-testability, and no replay path. `@foundation/agents` gives all three: typed schema-keyed generics, a default Host that captures a testable journal, and a replay Host for byte-for-byte fixture comparison — the Phase 3 ROADMAP proof.

## Contributing

- Add tests alongside every primitive change; the 90% per-file lines/functions/branches/statements floor holds under the root vitest config.
- Keep `JournalEntry` field order stable across variants — replay depends on `JSON.stringify` byte-for-byte diffing, and V8's insertion-order guarantee is what makes that safe.
- Prompt and schema hashes on `agent-request` are FNV-1a 32-bit hex. The implementation is 10 lines of native TypeScript (`src/hash.ts`), no runtime dependency. Test fixtures that need to hand-author the expected journal can call `setHashMode("none")` to zero out both fields for authorability.
- When a primitive changes its journal shape (adds a field, renames a kind), regenerate the fixture's `journal.jsonl` and bump every affected test's expected sequence in the same commit.
