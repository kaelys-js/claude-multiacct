# ADR 0001: Pin the vendored turbo schema to the installed turbo version

- Status: accepted
- Date: 2026-07-24
- Deciders: foundation-registry maintainers (owner of `packages/shared/utils/sync`)

## Context

The repo vendors config schemas under `.schemas/` so editors validate config
files offline and `check-jsonschema` has a stable metaschema. A drift gate
(`pnpm sync:check`, run in pre-push and CI) re-fetches each schema from its
upstream and fails when the vendored copy no longer matches.

Most tool schemas are pinned to the tool's installed version: the fetch URL
embeds the version read from `mise.toml` (oxlint, oxfmt, markdownlint), so the
vendored copy changes only on a deliberate version bump. Turbo was the
exception. Its source was `https://turbo.build/schema.json`, an unversioned
"latest" URL. Every time the turbo project published a new schema, the live URL
moved, the drift gate saw the vendored copy as stale, and CI went red across the
whole fleet (foundation-registry plus every fork that file-syncs `.schemas/`).

The break recurred. PR #33 re-vendored `.schemas/turbo.json` to match the then
current latest, but that is a point fix: the next upstream publish re-drifts it.
The gate was doing exactly what it should; the source URL was the defect.

## Decision

Pin turbo's schema fetch to the installed turbo version, matching how the
mise-managed tools already work.

Turbo is a pnpm devDependency (Renovate bumps `"turbo"` in `package.json`), not a
mise tool, so its version is read from `package.json` rather than `mise.toml`. A
new `readPackageVersion` helper in `schemas.ts` reads that pin, and the turbo
source function fetches the per-version schema shipped in the `turbo-types`
package at the matching git tag:

```text
https://raw.githubusercontent.com/vercel/turborepo/v<version>/packages/turbo-types/schemas/schema.json
```

The schema-source functions now receive both version files (`mise.toml` and
`package.json` text) instead of just `mise.toml`, so a bad or missing pin throws
inside that one schema's fetch and degrades to a per-schema warning rather than
aborting the sync (the same isolation the mise-pinned schemas already had).

`.schemas/turbo.json` was re-vendored once against the pinned version so it
matches the new source.

## Consequences

- The vendored turbo schema changes only when Renovate bumps the turbo
  devDependency. An upstream `turbo.build` publish no longer touches the drift
  gate, because the fetch is version-keyed and never reads the latest URL.
- A turbo bump now carries a `pnpm sync:schemas` step (re-vendor the schema for
  the new version), the same as an oxlint or markdownlint bump.
- The turbo version lives in `package.json` only. There is no second pin to keep
  in lockstep; `readPackageVersion` reads the one Renovate already maintains.
- If turbo ever stops publishing the per-version schema at that tag path, the
  fetch 404s and turbo degrades to an unreachable warning (never false drift),
  and the source URL would need revisiting.
