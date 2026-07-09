---
# ── Spine frontmatter (shared schema; ADR variant) ──────────────────────────
# id regex: ^ADR-\d{4}$
id: ADR-0000
type: ADR
title: <the architectural decision, as a noun phrase>
status: proposed # one of: proposed | accepted | superseded
# owner: CODEOWNERS handle for the governance domain this decision lives in,
#   e.g. @lead-build, @lead-infra, @lead-security, @lead-data, @lead-backend.
owner: "@lead-build"
date: "2026-01-01"
# references: MUST contain at least one up-chain PRD id; may cite related ADR/PDR ids.
references:
  - PRD-0000
# supersedes: prior ADR id this replaces, or null. A superseding ADR flips the old
#   record's status to `superseded` and names it here.
supersedes: null
---

# ADR-NNNN — <title>

<!-- MADR-style. This record settles a HOW question once, on the record, so it is not
     re-argued from memory. The decision must be made HERE, in this document, by the
     domain owner — options are presented with real evidence on each side, NOT
     pre-picked in the prose. -->

## Context and problem statement

<!-- The forces at play and the question being decided, in a few sentences. What
     situation makes this decision necessary now? Link the driving PRD and any
     evidence (PRs, tickets, benchmarks). End with the decision question itself. -->

## Decision drivers

<!-- The criteria the decision is judged against — bullet list. These are the axes the
     options are scored on (e.g. build speed, ecosystem maturity, migration cost,
     team familiarity, lock-in). Keep them decision-relevant and honest. -->

- <driver 1>
- <driver 2>

## Considered options

<!-- Name every option seriously on the table (including "do nothing" where relevant).
     Just the list here; detail each below. -->

1. <Option A>
2. <Option B>

### Option A — <name>

<!-- One line describing the option, then honest pros and cons weighed against the
     drivers above. Give each surviving option a fair hearing; do not strawman the
     losers. Cite evidence where you have it. -->

- Good, because <pro tied to a driver>
- Good, because <pro>
- Bad, because <con tied to a driver>
- Bad, because <con>

### Option B — <name>

- Good, because <pro>
- Bad, because <con>

## Decision outcome

<!-- State the chosen option in one sentence: "Chosen option: <B>, because <the
     decisive reason(s) tied to the drivers>." This is where the owner records the
     call. If the decision is still open, status stays `proposed` and this section
     names who decides and by when — it is NOT filled with a pre-picked answer. -->

**Chosen option:** <option>, because <justification against the drivers>.

## Consequences

<!-- What follows from the choice, good and bad. What is now easier, what is now harder,
     what new obligations or follow-on work this creates, and what we accept as the
     cost of the con we chose to live with. -->

- Good — <consequence>
- Bad / accepted cost — <consequence>

## Enforcement and rollout

<!-- How this decision is enforced or verified going forward (a CI check, a lint rule,
     a review gate), and any migration or rollout work it triggers. -->

---

## Filled example

<!-- A real ADR with genuine evidence on BOTH sides, left for the build owner to decide
     on the record — NOT pre-picked in this template's prose. -->

```markdown
---
id: ADR-0001
type: ADR
title: Build orchestrator for the TypeScript monorepo
status: proposed
owner: "@lead-build"
date: "2026-05-20"
references:
  - PRD-0001
supersedes: null
---

# ADR-0001 — Build orchestrator for the TypeScript monorepo

## Context and problem statement

The estate runs two monorepos with different orchestrators: handled-monorepo-poc uses
Nx (its CI runs `pr-validation.yml` on Nx affected tests), and providence-living uses
Turborepo. The split currently lives only in README prose, so the choice has never been
decided on the record. The foundation is a single TypeScript monorepo and must pick one
orchestrator as its standard. Which build orchestrator does the foundation standardise
on — Turborepo or Nx?

This record presents the evidence on both sides. The decision is the build owner's to
make here; it is deliberately left `proposed` and un-pre-picked.

## Decision drivers

- Incremental / affected-graph build and test speed at monorepo scale
- Ecosystem maturity, plugin/generator story, and code-generation support
- Migration cost from the two orchestrators already in use
- Team familiarity and existing CI investment
- Lock-in and exit cost

## Considered options

1. Turborepo
2. Nx

### Option Turborepo

A lightweight task runner with remote caching; already in use in providence-living.

- Good, because it is minimal-config and already proven in-house on Providence.
- Good, because its task-pipeline model is simple to reason about and low-lock-in — it
  orchestrates existing package scripts rather than owning the build.
- Good, because remote caching is first-class and cheap to stand up.
- Bad, because it has a thinner code-generation / plugin story, which matters given the
  foundation's later goal of scaffolding new clients.
- Bad, because affected-graph analysis is less sophisticated than Nx's at large scale.

### Option Nx

An integrated build system with a rich plugin and generator ecosystem; already in use in
handled-monorepo-poc.

- Good, because affected-graph computation is mature and already gates handled's CI via
  `pr-validation.yml`.
- Good, because its generator/plugin ecosystem aligns with the foundation's future
  scaffolding needs.
- Good, because the team already operates it daily on the larger of the two repos.
- Bad, because it is heavier and more opinionated — higher lock-in and a steeper config
  surface.
- Bad, because migrating providence-living off Turborepo onto Nx is non-trivial work.

## Decision outcome

**Chosen option:** _pending — @lead-build to decide on this record._ Both orchestrators
are in production use in-house, so this is a genuine trade (Turborepo's simplicity and
low lock-in vs. Nx's mature affected-graph and generator ecosystem), not a formality.
The build owner records the call and the decisive driver here, and flips status to
`accepted`, before this ADR gates anything.

## Consequences

- Good — one orchestrator becomes the standard every future project inherits; the
  README-only split ends.
- Bad / accepted cost — whichever repo is not already on the chosen tool carries a
  migration; that migration is follow-on work, tracked against this ADR.

## Enforcement and rollout

Once accepted, the CI pipeline standardises on the chosen orchestrator's affected/task
commands, and the losing tool is removed from new-project templates. The migration of
the non-conforming repo is scheduled by @lead-build.
```
