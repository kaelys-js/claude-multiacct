# `last-workflow-run` fixture

Provenance for the Phase 3 replay proof (`@foundation/agents`).

## What it is

Inputs, expected outputs, and a slim workflow that together replay the last recorded TRP workflow run against the shared package. Byte-for-byte parity on the recorded `journal.jsonl` is the ROADMAP Phase 3 acceptance gate.

## Files

| File                   | Origin                                                                                                                                                                                                        | Purpose                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.json`           | Verbatim copy of `trp/discovery/trp-input-clickup_hand_synth-01.json`                                                                                                                                         | Args the TRP driver passed to trp-fix-task.js on the last recorded run.                                                                                                           |
| `bundle-expected.json` | Verbatim copy of `trp/discovery/trp-bundle-clickup_hand_synth-01.json`                                                                                                                                        | The workflow's returned Bundle-phase artefact. Test asserts shape parity on `task_id`, `client_repo`, `files_to_modify[].path`.                                                   |
| `agent-responses.json` | Derived from `bundle-expected.json` and the recorded journal                                                                                                                                                  | (phase:label) -> recorded response. Voice from `style_recon.voice`; cheap exit codes from `preflight.still_failing`.                                                              |
| `journal.jsonl`        | Verbatim copy of `~/.claude/projects/-Users-Cole-Beuker-Documents-ttt-work-repos-strach-poc/af28d7d2-bbb1-4b52-b6c3-9a6415cce4b5/subagents/workflows/wf_98c20bb6-7c7/journal.jsonl` (70834 bytes, 76 entries) | The real recorded journal. ts is normalized by the replay Host to a monotonic counter; the recorded prompt_hash + schema_hash on agent-request entries are asserted on every run. |
| `workflow.ts`          | Slim workflow that mirrors trp-fix-task.js phases                                                                                                                                                             | Exercises every primitive: `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`.                                                                                             |

## When to regenerate

- **When Item 19/20 migrates trp-fix-task.js to a TypeScript module.** Swap `workflow.ts` for the migrated file, refill `agent-responses.json` from an instrumented replay pass, refresh `journal.jsonl` by re-copying the newer recorded run from `~/.claude/projects/*/subagents/workflows/wf_*/journal.jsonl`.
- **When a @foundation/agents primitive changes its journal shape.** Regenerate `journal.jsonl` from the newer recorded run at the same source path; the fixture is a pointer to an authoritative recording, not a hand-authored expected shape.

## What it does NOT prove

- The migrated workflow's per-agent responses match the historical run — those were not recorded per-agent, only in aggregate as the returned bundle. Full-fidelity replay needs the migration to land AND an instrumented recorder to run against the real Claude Code harness.
- Every phase of trp-fix-task.js — the slim `workflow.ts` covers Load / TaskRecon / PreflightCheap / Bundle. The remaining phases (FixItemsExtract, SpikeWriteup, DesignFix, PreflightScratch, PreflightInstall, PreflightClassify, PreflightAutofix, PreflightRevise, Adversarial) come in the Phase 4-6 migration when the real workflow module lands.
