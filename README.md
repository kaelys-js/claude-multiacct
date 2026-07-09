# foundation-registry

The **Business-as-Code governance layer** for the shared client foundation. This repository holds the firm's owned decisions and records — Product Requirement Documents (PRD), Product Decision Records (PDR), Architecture Decision Records (ADR), capability Specs (SPEC), Tasks, and Releases — that govern _how_ client projects are built; it is the single source of truth for those decisions, it does **not** run in production, and it is **not** the client TypeScript monorepo. Records are Markdown with YAML frontmatter, validated by schema, and owned in pieces by named GitHub teams (see [`owners.yaml`](packages/products/registry/owners.yaml)).

## Status

Stood up per **STEP-2.1** of `foundation-stage1-tasks.md`. The directory layout (STEP-2.2), the record schema (STEP-2.3), the record templates (STEP-2.4/2.5), the no-deflect commit hook (STEP-2.6/2.7), CI validation and CODEOWNERS (STEP-3), the harvested records (STEP-4), and the generated index site (STEP-5) land in their own tasks. This repo intentionally contains no application or runtime code.

## Workspace layout

This is a pnpm workspace. The governed records and the toolchain that validates them are separate `@foundation/*` packages; the repo root carries only orchestration (turbo, vitest, lefthook) plus the config files whose tools read them from the root.

```text
packages/
  shared/
    config/          # @foundation/config    shared tsconfig base + every tool config
                     #                        (oxlint, oxfmt, taplo, syncpack, markdownlint,
                     #                        yamllint, commitlint, gitleaks, editorconfig,
                     #                        lefthook base)
    utils/
      core/          # @foundation/core       repoRoot() + miseExec(), shared by qa and sync
      qa/            # @foundation/qa         lint/format dispatch over the whole tree, plus
                     #                        gitmeta / editorconfig / lefthook / schema checks
      sync/          # @foundation/sync       generated-file drift guards (versions, vendored
                     #                        schemas, turbo config, post-checkout/merge sync)
  products/
    registry/        # @foundation/registry   the record spine (below) + its schema validator
```

Cross-package imports resolve through each package's `exports` map and run under Node's native TypeScript type-stripping, so there is no build step. A single vitest config covers every package, the QA gate runs whole-repo, and each turbo task is cached against the whole tree.

## Directory layout

Records are partitioned by **domain** (matching the branch keys in `owners.yaml`), so CODEOWNERS routes review to the owning team per domain. The record type and id live in the filename and frontmatter; the PRD → (PDR/ADR) → SPEC → tasks → release **spine** is a reference relationship enforced by the schema, not a directory hierarchy.

The record spine lives in the `@foundation/registry` package (`packages/products/registry/`); its internal layout:

```text
packages/products/registry/    # @foundation/registry — the record spine
  records/
    governance/     # cross-domain & governance records (e.g. PRD-0001, foundation SPEC)  -> @foundation-lead
    build/          # -> @ttt/build
    design/         # -> @ttt/design
    frontend/       # -> @ttt/frontend
    backend/        # -> @ttt/backend
    infra/          # -> @ttt/infra
    security/       # -> @ttt/security
    data/           # -> @ttt/data
    observability/  # -> @ttt/observability
  schema/           # record.schema.json + owners.schema.json + tasks.schema.json (JSON Schema draft 2020-12)
  templates/        # record templates (prd / pdr / adr / spec) + tasks / release spine-tier formats
  proposals/        # open-contribution drafts
  owners.yaml       # domain -> team + lead manifest (validated by owners.schema.json)
  site/             # generated static index of the records (built in CI; STEP-5)
```

Record filenames are `<type>-<id-lowercased>-<slug>.md`, e.g. `packages/products/registry/records/build/adr-0001-build-orchestrator.md`.

## Ownership

`owners.yaml` maps each governed branch to the GitHub **team** that owns it (CODEOWNERS review routing) and its named **lead** (accountable engineer of record). Team creation, slug wiring, and funding are tracked in STEP-1.5.
