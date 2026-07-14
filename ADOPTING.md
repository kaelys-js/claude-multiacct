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

## Opting into upstream sync

Runtime forks (`kaelys-js/ttt-studio-cole-30-60-90-plan` is the first) track this repo's `main` branch through a daily GitHub Actions workflow. The workflow lives in the fork, but its shape is versioned here at `packages/shared/config/workflows/sync-upstream.<mode>.template.yml`; a fork generates its own copy with `pnpm sync-upstream:opt-in` and never hand-copies.

Two topologies are supported, picked by the `mode` field in `.sync-upstream.json`:

- `"cross-owner"` (default) — the fork and the upstream sit under different GitHub accounts, so a single deploy key installed on both repos is unique per-account. This is the shape the template was originally designed around.
- `"same-owner"` — both repos sit under the same account, and GitHub refuses to install the same deploy key twice. The variant carries no deploy key: origin push and upstream fetch both ride HTTPS with a repo-scoped PAT stored as `secrets.GH_TOKEN` on the fork.

Steps, cross-owner:

1. In the fork checkout, create `.sync-upstream.json` at the repo root:

   ```json
   {
   	"upstreamRepoSsh": "git@github.com:<owner>/foundation-registry.git",
   	"upstreamBranch": "main",
   	"deployKeySecret": "UPSTREAM_DEPLOY_KEY"
   }
   ```

   `mode` may be omitted; it defaults to `"cross-owner"`.

2. Generate an Ed25519 deploy key locally: `ssh-keygen -t ed25519 -N '' -f /tmp/upstream-deploy-key -C "sync-upstream <fork>"`.
3. Add `/tmp/upstream-deploy-key.pub` as a READ-ONLY deploy key on the upstream repo (Settings → Deploy keys → Add).
4. Add the SAME public key as a WRITE deploy key on the fork (Settings → Deploy keys → check "Allow write access").
5. Store the private key as the `UPSTREAM_DEPLOY_KEY` (or whatever `deployKeySecret` was set to) repo secret on the fork: `gh secret set UPSTREAM_DEPLOY_KEY --repo <owner>/<fork> < /tmp/upstream-deploy-key`.
6. Wipe the local private key: `rm /tmp/upstream-deploy-key*`.
7. From the fork root, run `pnpm sync-upstream:opt-in`. That writes `.github/workflows/sync-upstream.yml` in the fork with placeholders substituted.
8. Commit `.sync-upstream.json` and the generated workflow, push, and the daily cron takes over. `workflow_dispatch` triggers a run on demand.

Steps, same-owner:

1. In the fork checkout, create `.sync-upstream.json` at the repo root:

   ```json
   {
   	"mode": "same-owner",
   	"upstreamRepoSsh": "git@github.com:<owner>/foundation-registry.git",
   	"upstreamBranch": "main"
   }
   ```

   The SSH URL is only there so the CLI can derive `owner/repo` for the HTTPS URL it composes; the workflow itself never fetches over SSH in this mode. `deployKeySecret` is omitted (and rejected if set).

2. On the same account that owns both repos, create a classic PAT (`repo` + `workflow` scope) or a fine-grained PAT with `Contents: read/write` + `Pull requests: read/write` on the fork AND `Contents: read` on the upstream.
3. Store the token as the `GH_TOKEN` repo secret on the fork: `gh secret set GH_TOKEN --repo <owner>/<fork> < /path/to/token`.
4. From the fork root, run `pnpm sync-upstream:opt-in`. Same output path; the CLI picks the same-owner template automatically off `mode`.
5. Commit `.sync-upstream.json` and the generated workflow, push, and the daily cron takes over.

Re-running `pnpm sync-upstream:opt-in` is a no-op when the workflow file already matches. If the fork owner hand-edits the generated workflow (for instance to widen the fork-wins path list) and the config later changes, the tool exits with a conflict message and preserves the local edit; pass `--force` to overwrite.

## Cross-linking a runtime product to its records

Every runtime product ships its own PRD (linked from the package README), its own ADR log at `packages/products/<name>/docs/adr/`, and its own SPEC. The governing PRD and the top-level ADRs live in the registry spine at `packages/products/registry/records/<domain>/`. Cross-link with two fields: the record's frontmatter carries `runtime_package: "@foundation/trp"`, and the product's `package.json` carries `foundationRegistry.governingPrd: "PRD-0042"`. The schema validator checks both sides resolve.

## Renovate (dependency PRs)

`renovate.json5` at the repo root drives Renovate's PRs against `packages/**/package.json` + `pnpm-lock.yaml` and `mise.toml`'s `[tools]` block. Patch/minor/digest updates auto-merge after CI + a 3-day cool-down; major updates open a review PR. Every commit reads `chore(deps): update <dep> to <new>` — that passes this repo's commitlint (`chore` in type-enum, `deps` in scope-enum).

Two setup paths, matching how sibling repos already run Renovate:

**Renovate hosted GitHub App (simplest).** Open `https://github.com/apps/renovate` and install on the target repository. `renovate.json5` at the repo root is the only config. Within a few hours Renovate opens the **Dependency Dashboard** issue and starts filing PRs.

**Self-hosted GitHub App (matches `kaelys-js/stardust`).** Follow `kaelys-js/stardust`'s `docs/renovate-setup.md`. Two secrets need to land on the repo (`RENOVATE_APP_CLIENT_ID`, `RENOVATE_APP_PRIVATE_KEY`), plus `.github/workflows/renovate.yml` + `renovate-fixup.yml` copied from stardust. This path keeps every credential inside your own account instead of trusting the Mend-hosted service.

Validate the config before pushing changes:

```sh
pnpm dlx renovate-config-validator renovate.json5
```

The current `renovate.json5` enables the `npm` and `mise` managers only. GitHub Actions, container images, and other managers stay off — this repo pins no images and does not consume GH Actions versions Renovate would upgrade.
