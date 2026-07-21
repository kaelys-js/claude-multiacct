# Security Policy

## Reporting a vulnerability

If you find a security issue in this repo, please report it privately through
GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/kaelys-js/foundation-registry/security/advisories/new)**

Private reports let us investigate and coordinate a fix before the issue is
public. Please avoid opening a public issue for anything that could be exploited.

## Scope

This repo holds Kaelys' governance and business-as-code records — schema
contracts, catalog inputs, and per-team policies that other repos consume.
In-scope issues include:

- Injection paths in `packages/products/registry/src/validate-records.ts` —
  the schema validator processes untrusted YAML input; a crafted record that
  escapes validation and reaches downstream consumers (catalog sync,
  workflow generation, etc.) is a bug.
- Sensitive-data leaks from governance records under `records/`. Business
  content may name clients, engagements, or internal decisions; a merge
  that exposes that material publicly (or lands it in a public sibling
  repo via catalog sync) is in scope.
- Over-scoped `kaelys-js-catalog` GitHub App token on the
  `.github/workflows/sync-catalog.yml` workflow — the app is scoped to
  `Contents: read+write` on the catalog consumer repos; any wider write
  scope is a bug.
- Over-scoped `kaelys-js-renovate` GitHub App token on Renovate PRs — the
  Renovate app should never gain write access outside dependency PRs it
  opens itself.
- Any workflow that logs, echoes, or exports a secret to an untrusted sink
  (job logs, artifact uploads, PR comments).
- Secret exposure in build outputs (e.g. a bundled catalog artifact that
  embeds a token pulled from a workflow `secrets.*` reference).

Known limitations:

- Vulnerabilities in the upstream GitHub Actions we pin (report those to
  the action's maintainer).
- Bugs affecting only a local fork with no security impact.

## Supported versions

The `main` branch is the only supported version.
