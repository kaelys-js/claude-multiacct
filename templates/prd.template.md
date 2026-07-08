---
# ── Spine frontmatter (shared schema; PRD variant) ──────────────────────────
# id: pinned to this record type. Regex: ^PRD-\d{4}$  (PRD-0001 … PRD-9999)
id: PRD-0000
type: PRD
title: <one line, imperative or noun-phrase; no trailing period>
# status: lifecycle of THIS record, not the work it describes.
#   proposed   → drafted, not yet signed off
#   accepted   → signed off; this is current truth
#   superseded → replaced by a newer record (name it in `supersedes` of the successor)
status: proposed            # one of: proposed | accepted | superseded
# owner: a CODEOWNERS handle (team or user), literal, incl. leading '@'.
#   For a PRD this is product/delivery, e.g. @lead-governance or @delivery-lead.
owner: '@lead-governance'
date: 2026-01-01            # ISO-8601; date this record reached its current status
# references: up-chain parent IDs this record derives from.
#   PRD is the spine ROOT: this is normally [] (empty). Cross-links to other
#   PRDs are allowed but a PRD never references a PDR/ADR/SPEC below it.
references: []
# supersedes: the record ID this one replaces, or null. Same type only (PRD supersedes PRD).
supersedes: null
---

# PRD-NNNN — <title>

<!-- The PRD is the durable "why this exists" leadership signs off on. It changes rarely.
     It answers what the thing is and why the business is doing it — not how it is built
     (that is an ADR) and not the current shape of a system (that is a SPEC). -->

## Summary

<!-- 2–4 sentences a non-engineer can read. What is this, and why now? A delivery lead
     or account manager should understand the stakes without reading further. -->

## Problem

<!-- The concrete problem or opportunity, grounded in evidence: cite tickets, PRs,
     incidents, metrics, or client asks. Name who feels the pain and how often.
     No solution language here — describe the world as it is. -->

## Target outcome

<!-- The measurable change in the world when this succeeds. State it as an outcome,
     not an output: "time from ticket-ready to build-start drops below N days",
     not "we ship a gate". One to three outcomes, each observable. -->

## Users and stakeholders

<!-- Who this is for and who has a stake. For an agency: engineering, delivery/PM,
     account, clients. Note which role each outcome serves. -->

## Acceptance criteria

<!-- The bar for "the outcome is real", as a checklist. Each item must be testable —
     something a reviewer can confirm true or false. If you cannot phrase it as
     pass/fail, it belongs in Open questions until it is resolved. -->

- [ ] <criterion 1 — observable / testable>
- [ ] <criterion 2>

## Out of scope

<!-- What this record explicitly does NOT cover, so no one assumes it does. Draw the
     boundary hard: name the tempting adjacent thing and say it is elsewhere or later. -->

## Constraints and assumptions

<!-- Budget, timeline, regulatory, org, or technical constraints taken as fixed.
     Assumptions that, if false, would invalidate this PRD — state them so they can
     be challenged rather than discovered mid-build. -->

## Open questions → decisions

<!-- Every open question that must be settled before build. Do NOT leave them open:
     each row resolves to a decision (often a downstream PDR/ADR) or is closed here.
     A PRD with unresolved questions is not yet `accepted`. -->

| # | Question | Resolution / owning record |
|---|----------|----------------------------|
| 1 | <question> | <decision, or PDR-/ADR- id> |

## Down-chain records

<!-- Populated as the spine grows: the PDRs, ADRs and SPECs that reference THIS PRD.
     A projection for readers — the authoritative link direction is child → parent via
     `references`. Leave a placeholder line until children exist. -->

- <none yet>

---

## Filled example

<!-- Below is a real, populated PRD so a reader sees the shape in practice. -->

```markdown
---
id: PRD-0001
title: Why the foundation exists
status: accepted
owner: '@lead-product'
date: 2026-05-18
references: []
supersedes: null
---

# PRD-0001 — Why the foundation exists

## Summary

Every client project re-litigates the same decisions and rebuilds the same primitives
from scratch, and no past decision survives the person who made it. The foundation is a
governance registry plus a set of harvested standards, owned in pieces by named
engineers, so that decisions are written down once, enforced mechanically, and inherited
by every project. This record is the business case leadership signs off on.

## Problem

Across the two repos that matter — handled-monorepo-poc and providence-living — 726
merged PRs and 663 tickets show the same waste recurring. Exactly one substantive ADR
exists (Providence's assessment-lifecycle record); the Turborepo-vs-Nx choice lives only
in README prose and the ITC re-architecture rationale only in scattered PR comments.
Base primitives are rebuilt per app: `documentIntelligence.ts` was forked into two
divergent copies (949-line diff), and 161 hand-rolled catch blocks coexist with 46 uses
of the shared `catchAsync`. Work waits 6–14 days before build because tickets arrive
without a testable definition of done. Every one of these is legible in the history and
survived adversarial re-checking.

## Target outcome

- Any "why did we do it this way?" is answerable in one hop up a chain of records, not an
  investigation of someone's memory.
- No work crosses into build without a linked, ready requirement.
- The current state of every project — owner, status, decisions — is readable by a
  non-engineer without opening a repo.

## Users and stakeholders

- Engineering — fewer settled arguments re-opened; a clear requirement to build against.
- Delivery / PM — predictable start dates and a real definition of ready.
- Account / clients — a readable view of status and decisions without chasing engineers.
- Leadership — the sign-off authority for this record and its budget.

## Acceptance criteria

- [ ] A registry repo exists with a pinned record schema and the up-chain parent-type
      contract enforced in CI.
- [ ] CODEOWNERS names a real engineer for each governance domain.
- [ ] The first real decisions are harvested into records (PRD-0001, ADR-0001, SPEC-0001,
      and the migration of Providence's docs/adr/0001).
- [ ] A one-page static index renders the registry for a non-engineer reader.

## Out of scope

The generator, the first client scaffold, propagation of shared runtime packages,
brownfield onboarding, and the hosted catalogue / ownership-graph / MCP visibility layer
are all later stages, not this record. This PRD covers the governance registry, records,
and a static index only.

## Constraints and assumptions

- The registry is Markdown with YAML frontmatter; no new datastore.
- Standards are harvested from what the team already does, not imposed top-down —
  assumed necessary for adoption.
- Domain owners are drawn from engineers already doing that work; if no willing owner
  exists for a domain, that domain is not stood up yet.

## Open questions → decisions

| # | Question | Resolution / owning record |
|---|----------|----------------------------|
| 1 | Which build orchestrator is the standard? | Deferred to the build owner on the record — ADR-0001 |
| 2 | What is the minimum bar for "ready"? | Codified as the DEFINITION-OF-READY checklist |

## Down-chain records

- ADR-0001 (build orchestrator), SPEC-0001 (registry current state), PDR-0001 (index site)
```
