# Adopting foundation-registry

## Purpose

This document answers the three questions in TODO.md for the operator bringing a new product into the foundation. It covers how records connect to the monorepo, how a runtime product is added, how the bidirectional flow with an agnostic tracker (ClickUp, Linear, GitHub Projects) works, and whether a records-only mirror repo is warranted. Read this before you stand up a new package or open your first PRD.

## Two ways to live in foundation-registry

A subject can enter the registry through one of two doors.

**As a governance record.** PRD, PDR, ADR, SPEC, Tasks, and Releases sit at `packages/products/registry/records/<domain>/`. Each is Markdown with YAML frontmatter, validated by `@foundation/registry`'s schema, routed to a domain owner via `owners.yaml` and CODEOWNERS. Nothing runs from these files. They are the record of what the firm decided and why.

**As a runtime product.** Packages sit at `packages/products/<name>/` with their own `package.json`, `tsconfig.json`, `src/`, and co-located tests. They inherit config from `@foundation/config` and are picked up by the root `pnpm-workspace.yaml` glob, root `turbo.json` tasks, the single `vitest.config.ts`, and the CI 5-job matrix without any wiring per new package. TRP is the first runtime product to land under this door.

## Worked example: TRP as first runtime product

The steps to add `@foundation/trp` from empty:

1. Create `packages/products/trp/` on disk.
2. Write `packages/products/trp/package.json` with `name: "@foundation/trp"`, `type: "module"`, `exports`, and dev/peer references to `@foundation/config`. No custom lint or format scripts. The root `qa` gate covers them.
3. Write `packages/products/trp/tsconfig.json` extending `@foundation/config/tsconfig.base.json`. No `outDir`. Node's native type-stripping runs the sources.
4. Put source at `packages/products/trp/src/` and tests at `packages/products/trp/src/**/*.test.ts` next to their subject. The vitest config includes them.
5. Do not edit `pnpm-workspace.yaml`. The `packages/products/*` glob already matches.
6. Do not edit `turbo.json`. Root tasks (`qa`, `test`, `build`, `check`) apply across every workspace member.
7. Do not edit the CI matrix. The 5-job GitHub Actions matrix runs against the whole workspace on every push.

Running `pnpm install` at the root wires TRP into the graph. Running `pnpm run qa` at the root lints, formats, type-checks, and tests it. That is the whole onboarding surface for a runtime product.

## Bidirectional tracker flow

The registry is the source of truth for governance record content. The tracker is the source of truth for operational state around each record (who is working on it, what its column is, chat threads).

Every record carries a stable spine ID in frontmatter: `PRD-0042`, `ADR-0017`, `SPEC-0091`. The tracker holds a stub ticket whose title cites the spine ID and whose description points at the record's URL under `packages/products/registry/records/<domain>/`. The ticket body is a pointer, not a copy.

Sync runs both directions on a schedule and on webhook. Tracker-side changes (status transition, assignee, comment) append to the record's `history` block in its YAML frontmatter as timestamped entries. Registry-side changes (a merged edit to the record body) post a comment back on the tracker ticket citing the commit SHA. The record's Markdown body is never rewritten by the tracker. History lives in the frontmatter and grows append-only.

This works with any tracker the firm adopts. ClickUp is the current target. Linear and GitHub Projects are drop-in replacements at the connector layer. The spine ID is the join key; nothing about the record schema binds it to a vendor.

## Records-only mirror repo

Not recommended. A second repo doubles the surface for drift and forces a sync layer whose failure modes are silent by construction. The same repo can expose a records-only view through a filtered branch, a generated static site (`packages/products/registry/site/`), or a read-only clone published on a schedule. Keep the record spine and the tooling that validates it in one place. Drift risk stays at zero.

## Cross-linking a runtime product to its records

Every runtime product ships its own PRD (linked from the package README), its own ADR log at `packages/products/<name>/docs/adr/`, and its own SPEC. The governing PRD and the top-level ADRs live in the registry spine at `packages/products/registry/records/<domain>/`. Cross-link with two fields: the record's frontmatter carries `runtime_package: "@foundation/trp"`, and the product's `package.json` carries `foundationRegistry.governingPrd: "PRD-0042"`. The schema validator checks both sides resolve.
