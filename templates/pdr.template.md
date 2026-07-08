---
# ── Spine frontmatter (shared schema; PDR variant) ──────────────────────────
# id regex: ^PDR-\d{4}$
id: PDR-0000
type: PDR
title: <the feature / product decision, as a noun phrase>
status: proposed            # one of: proposed | accepted | superseded
# owner: CODEOWNERS handle. For a PDR this is product/delivery.
owner: '@lead-product'
date: 2026-01-01
# references: MUST contain at least one up-chain PRD id. May also cite sibling
#   PDR/ADR ids this decision depends on. Never references a SPEC (that is down-chain).
references:
  - PRD-0000
# supersedes: prior PDR id this replaces, or null.
supersedes: null
---

# PDR-NNNN — <title>

<!-- A PDR settles a product question — what a thing is, for whom, and what "done"
     means — in a document, before code. It is held to the definition-of-ready gate:
     the five DoR fields below are mandatory and must be resolved (not left open)
     before status can be `accepted`. The tracker ticket is a projection of this record. -->

## Problem

<!-- [DoR field] The concrete problem this feature addresses, with evidence. Who is
     blocked or underserved, and how do we know? No solution language. -->

## Target outcome

<!-- [DoR field] The measurable change when this ships. An outcome, not an output.
     Tie it back to a PRD outcome where possible. -->

## Users and context

<!-- Who this is for and the situation they are in when they hit it. For an agency,
     name whether this serves the client's user, the delivery team, or internal ops. -->

## Decision

<!-- What we are actually going to do — the shape of the feature/product. Specific
     enough that engineering can spec it and a designer can design it. Describe the
     WHAT and the WHY; leave the HOW-it-is-built to a downstream ADR/SPEC. -->

## Acceptance criteria

<!-- [DoR field] The testable bar for "done". Each item pass/fail. This is what QA and
     the merge gate check against. If it is not testable, it is an open question. -->

- [ ] <criterion — observable / testable>
- [ ] <criterion>

## Out of scope

<!-- [DoR field] What this decision explicitly excludes. Name the adjacent thing people
     will assume is included and say plainly that it is not. -->

## Resolved open questions

<!-- [DoR field] Every question that was open is closed here, each into a decision.
     This is the field the DoR gate cares about most: an unresolved question means the
     record is not ready and the work cannot enter build. -->

| # | Question (was open) | Decision |
|---|---------------------|----------|
| 1 | <question> | <decision> |

## Dependencies

<!-- Other records, systems, teams, or client inputs this decision depends on.
     Link ADR/PDR ids where a dependency is itself a governed decision. -->

## Consequences

<!-- What becomes true, easier, or harder once this is accepted. Follow-on work,
     new obligations, things now foreclosed. -->

---

## Filled example

```markdown
---
id: PDR-0001
title: Static index site for the foundation registry
status: accepted
owner: '@lead-product'
date: 2026-05-22
references:
  - PRD-0001
supersedes: null
---

# PDR-0001 — Static index site for the foundation registry

## Problem

The registry is Markdown-with-frontmatter in a repo. That is legible to engineers but
not to the delivery leads, account managers, and clients who most need to see status and
decisions. A raw repo does not clear that bar, and asking non-engineers to browse Git is
the status quo we are trying to end.

## Target outcome

Anyone in the business can open one page and read the current registry — every record,
its type, owner, status, and what it references — without opening a repo. This directly
serves PRD-0001's outcome of "current state readable by a non-engineer."

## Users and context

Delivery leads and account managers checking project state; leadership scanning what has
been decided; engineers wanting a fast overview. Read-only; the repo remains the source
of truth.

## Decision

We generate a single static HTML page from the registry's Markdown records at CI time. It
lists every record grouped by type (PRD / PDR / ADR / SPEC), showing id, title, owner,
status, date, and up-chain references as links. It is committed as a build artifact and
viewable without a server. The page is plain, non-engineer-readable, and has no auth,
search backend, or database.

## Acceptance criteria

- [ ] Running the index generator over the registry produces one self-contained HTML file.
- [ ] Every record in `records/` appears exactly once, in its type group.
- [ ] Each record's `references` render as working in-page links to the parent records.
- [ ] A person who has never seen the repo can identify the owner and status of any record.
- [ ] The generator runs in CI and fails the build if a record cannot be parsed.

## Out of scope

The hosted, browsable catalogue with the ownership graph and the MCP interface is a later
stage and is not this record. No auth, no search service, no live database, no per-client
theming — one static page only.

## Resolved open questions

| # | Question (was open) | Decision |
|---|---------------------|----------|
| 1 | Hosted app or static file? | Static file — a hosted catalogue is a later stage per PRD-0001 out-of-scope. |
| 2 | Who can read it? | Anyone with repo/artifact access; no auth layer at this stage. |

## Dependencies

- The registry schema and CI validation (SPEC-0001) must exist so the generator has a
  reliable input shape.

## Consequences

The registry gains a reader-facing surface with near-zero maintenance. It sets an
expectation that a richer hosted catalogue will replace it later; that replacement is
tracked separately and is explicitly not built now.
```
