# foundation-registry

The **Business-as-Code governance layer** for the shared client foundation. This repository holds the firm's owned decisions and records — Product Requirement Documents (PRD), Product Decision Records (PDR), Architecture Decision Records (ADR), capability Specs (SPEC), Tasks, and Releases — that govern *how* client projects are built; it is the single source of truth for those decisions, it does **not** run in production, and it is **not** the client TypeScript monorepo. Records are Markdown with YAML frontmatter, validated by schema, and owned in pieces by named GitHub teams (see [`owners.yaml`](owners.yaml)).

## Status

Stood up per **STEP-2.1** of `foundation-stage1-tasks.md`. The directory layout (STEP-2.2), the record schema (STEP-2.3), the record templates (STEP-2.4/2.5), the no-deflect commit hook (STEP-2.6/2.7), CI validation and CODEOWNERS (STEP-3), the harvested records (STEP-4), and the generated index site (STEP-5) land in their own tasks. This repo intentionally contains no application or runtime code.

## Ownership

`owners.yaml` maps each governed branch to the GitHub **team** that owns it (CODEOWNERS review routing) and its named **lead** (accountable engineer of record). Team creation, slug wiring, and funding are tracked in STEP-1.5.
