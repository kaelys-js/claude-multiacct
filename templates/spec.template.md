---
# ── Spine frontmatter (shared schema; SPEC variant) ─────────────────────────
# id regex: ^SPEC-\d{4}$
id: SPEC-0000
type: SPEC
title: <the capability / system, as a noun phrase>
status: accepted            # one of: proposed | accepted | superseded
# owner: CODEOWNERS handle for the domain that owns this capability.
owner: '@lead-backend'
date: '2026-01-01'
# references: up-chain records that justify this current state — the PDR/ADR decisions
#   that shaped it. A SPEC must cite at least one ADR (PRD is not a valid SPEC parent).
references:
  - ADR-0000
# supersedes: prior SPEC id this current-state record replaces, or null.
supersedes: null
---

# SPEC-NNNN — <title>

<!-- A SPEC describes what a capability IS right now — the authoritative "how it works
     today" reference. It is descriptive, not aspirational: if something is not yet
     built, it does not belong here (it belongs in a PDR/ADR). When reality changes,
     revise the SPEC or supersede it — never let it drift from the system. -->

## Overview

<!-- What this capability is and what it is responsible for, in a few sentences.
     Where it sits in the larger system. -->

## Scope and boundaries

<!-- What this SPEC covers and, just as importantly, where its edges are — what is
     handled by adjacent capabilities. Prevents readers assuming it owns more than it does. -->

## Current behaviour

<!-- How it actually behaves today, concretely. Inputs, outputs, states, and the rules
     that govern transitions. This is the load-bearing section — be precise and cite
     the code paths / files that implement each behaviour where you can. -->

## Interfaces and contracts

<!-- The surfaces other things depend on: schemas, APIs, file formats, CLI commands,
     config shapes. Anything a consumer couples to. Pin exact shapes (regexes, enums,
     required fields) rather than describing them loosely. -->

## Invariants and constraints

<!-- The rules that must always hold for this capability to be correct, and the
     constraints it operates under. These are what tests and CI checks defend. -->

## Known gaps and limitations

<!-- Where the current state falls short — honestly. Things that are partial, fragile,
     or explicitly not handled yet. Link the record(s) tracking any planned change.
     Do NOT pretend the gap away; the SPEC's value is that it is true. -->

## Verification

<!-- How the described behaviour is checked — the CI jobs, test suites, or schema
     validators that keep this SPEC honest. If a stated invariant has no check, say so. -->

---

## Filled example

```markdown
---
id: SPEC-0001
type: SPEC
title: Foundation registry — current state
status: accepted
owner: '@lead-backend'
date: '2026-05-24'
references:
  - PDR-0001
  - ADR-0001
supersedes: null
---

# SPEC-0001 — Foundation registry — current state

## Overview

The registry is a Git repository of governance records. Each record is a Markdown file
with YAML frontmatter conforming to a shared spine schema. Records form a chain —
PRD → PDR/ADR → SPEC — where each child names its up-chain parent(s) via `references`,
so any "why" is one hop up the chain. This SPEC describes the registry as it exists
after the foundation's first cut.

## Scope and boundaries

Covers the record files, the schema, the up-chain contract, CI validation, CODEOWNERS,
branch protection, the contribution/proposal path, and the static index generator. It
does NOT cover the hosted catalogue, the ownership graph, or the MCP interface — those
are later stages and are absent by design.

## Current behaviour

- Records live under `records/<domain>/<type>-<id-lowercased>-<slug>.md`, one record per file; the directory is the owning domain and the filename carries the type.
- Every record carries frontmatter: `id`, `title`, `status`, `owner`, `date`,
  `references`, `supersedes`.
- CI validates each record on every push: id matches the per-type regex, `status` is one
  of the enum, `owner` is a CODEOWNERS handle, every id in `references` resolves to an
  existing record, and the up-chain parent-type contract holds (a PDR/ADR references a
  PRD; a SPEC references a PRD/PDR/ADR; a PRD references nothing below it).
- A change inside a domain cannot merge without its CODEOWNERS owner's review; branch
  protection enforces this on the default branch.
- Anyone may open a proposal (a new or edited record via pull request); the owning
  domain's owner is the reviewer.
- The static index generator (per PDR-0001) renders all records into one HTML page.

## Interfaces and contracts

- **id regexes:** `^PRD-\d{4}$`, `^PDR-\d{4}$`, `^ADR-\d{4}$`, `^SPEC-\d{4}$`.
- **status enum:** `proposed | accepted | superseded`.
- **owner:** a literal CODEOWNERS handle including the leading `@`.
- **references:** an array of up-chain record ids (may be empty only for a PRD).
- **supersedes:** a same-type record id or `null`.
- **up-chain contract:** child → parent link direction; parent types are fixed per the
  spine PRD → PDR/ADR → SPEC.

## Invariants and constraints

- Every `references` entry resolves to an existing record (no dangling ids).
- The parent-type of each reference is legal for the child's type.
- No two records share an id.
- A `superseded` record names its successor and the successor names it via `supersedes`.
- The registry is Markdown-only; no datastore is introduced at this stage.

## Known gaps and limitations

- The reader surface is a single static page; the hosted catalogue / ownership-graph /
  MCP is not built and is out of scope for this stage (see PRD-0001).
- CODEOWNERS is lazily populated — a domain has an owner only once a real owner is
  harvested for it.
- Only the first real decisions are harvested so far (PRD-0001, ADR-0001, the migrated
  Providence docs/adr/0001, ADRs for standardised existing patterns, SPEC-0001).

## Verification

The registry-validation CI job enforces the schema, id regexes, reference resolution,
and the up-chain parent-type contract on every push; branch protection enforces
CODEOWNERS review on merge. The index generator fails the build if any record cannot be
parsed.
```
