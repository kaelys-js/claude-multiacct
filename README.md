# foundation-registry

The **Business-as-Code governance layer** for the shared client foundation. This repository holds the firm's owned decisions and records — Product Requirement Documents (PRD), Product Decision Records (PDR), Architecture Decision Records (ADR), capability Specs (SPEC), Tasks, and Releases — that govern *how* client projects are built; it is the single source of truth for those decisions, it does **not** run in production, and it is **not** the client TypeScript monorepo. Records are Markdown with YAML frontmatter, validated by schema, and owned in pieces by named GitHub teams (see [`owners.yaml`](owners.yaml)).

## Status

Stood up per **STEP-2.1** of `foundation-stage1-tasks.md`. The directory layout (STEP-2.2), the record schema (STEP-2.3), the record templates (STEP-2.4/2.5), the no-deflect commit hook (STEP-2.6/2.7), CI validation and CODEOWNERS (STEP-3), the harvested records (STEP-4), and the generated index site (STEP-5) land in their own tasks. This repo intentionally contains no application or runtime code.

## Directory layout

Records are partitioned by **domain** (matching the branch keys in `owners.yaml`), so CODEOWNERS routes review to the owning team per domain. The record type and id live in the filename and frontmatter; the PRD → (PDR/ADR) → SPEC → tasks → release **spine** is a reference relationship enforced by the schema, not a directory hierarchy.

```text
records/
  governance/      # cross-domain & governance records (e.g. PRD-0001, foundation SPEC)  -> @foundation-lead
  build/           # -> @ttt/build
  design/          # -> @ttt/design
  frontend/        # -> @ttt/frontend
  backend/         # -> @ttt/backend
  infra/           # -> @ttt/infra
  security/        # -> @ttt/security
  data/            # -> @ttt/data
  observability/   # -> @ttt/observability
schema/            # record.schema.json (JSON Schema draft 2020-12: frontmatter + parent-type contract)
templates/         # one template per record type (prd / pdr / adr / spec / tasks / release)
proposals/         # open-contribution drafts
site/              # generated static index (built in CI)
```

Record filenames are `<type>-<id>-<slug>.md`, e.g. `records/build/adr-0001-build-orchestrator.md`.

## Ownership

`owners.yaml` maps each governed branch to the GitHub **team** that owns it (CODEOWNERS review routing) and its named **lead** (accountable engineer of record). Team creation, slug wiring, and funding are tracked in STEP-1.5.
