# @foundation/trp

Task Resolution Protocol. Runtime product.

## Scope

TRP handles any ClickUp ticket via six response modes: `spike-writeup`, `spike-solve`, `spike-full`, `solve`, `reproduce`, `support`. The workflow harness uses adversarial-refute + CI-as-ground-truth verdicts, mirroring the SFP + SRP discipline the sibling product (`@foundation/security-pocs`) applies to security work.

## Status

**Phase 1 landed.** Package shell in place, one placeholder test runs green under Vitest, CI picks up in the 5-job matrix without wiring changes. Runtime code migration lands in Phase 4-6 per ROADMAP Item 20.

## Adopting this pattern for a new product

See [`ADOPTING.md`](../../../ADOPTING.md) at repo root. TRP is the first worked example.

## Source

Original TRP repo (pre-migration): `/Users/Cole.Beuker/Documents/ttt-work/repos/trp`. Five local commits on master, no remote. Migration phases move the code into this package; the original repo becomes an archive pointer at Phase 8 cutover.
