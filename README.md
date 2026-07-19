# foundation-registry

[![CI](https://github.com/kaelys-js/foundation-registry/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kaelys-js/foundation-registry/actions/workflows/ci.yml)

**Business-as-code governance layer — every firm decision as a versioned Markdown record, validated by schema, owned by named teams.**

## What it does

Firm-level decisions scatter across wikis, chat, and one-off docs, and nobody can find the reasoning six months later. This repo keeps them as Markdown-with-YAML-frontmatter records — Product Requirement Documents (PRD), Product Decision Records (PDR), Architecture Decision Records (ADR), capability Specs (SPEC), Tasks, and Releases — validated by JSON Schema and routed to named teams via CODEOWNERS.

Records partition by domain (governance, design, frontend, backend, infra, security, data, observability), and cross-link forward: PRD → (PDR / ADR) → SPEC → Tasks → Release. It's the record of what the firm decided and why — **not** a runtime application, and **not** the client TypeScript monorepo.

Every record's frontmatter is validated by `packages/products/registry/src/validate-records.ts`, which loads every `records/**/*.md`, validates each against `schema/record.schema.json` (JSON Schema draft 2020-12), then asserts cross-record invariants JSON Schema can't express: id uniqueness, reference resolution, the parent-type matrix, and supersession integrity. Pure, deterministic, no network, no model calls.

## Quickstart

```sh
git clone https://github.com/kaelys-js/foundation-registry ~/Documents/work/@personal/foundation-registry
cd ~/Documents/work/@personal/foundation-registry
mise install                 # pins the whole toolchain
pnpm install --frozen-lockfile
```

Run the same gates CI runs (see [CONTRIBUTING.md](CONTRIBUTING.md)):

```sh
pnpm qa:lint && pnpm qa:format:check && pnpm qa:test
pnpm qa:schema               # validates every record against the JSON schemas
```

## Record types

Every record lives in `packages/products/registry/records/<domain>/` and matches a filename pattern `<type>-<id-lowercased>-<slug>.md`:

- **PRD** — Product Requirement Document (what problem, who, why)
- **PDR** — Product Decision Record (how we solved it, options weighed)
- **ADR** — Architecture Decision Record (technical trade-offs, consequences)
- **SPEC** — capability specification (interface contract, invariants)
- **Task** — a unit of work referencing its parent PRD/PDR/ADR/SPEC
- **Release** — cut, notes, changed records since the prior release

Templates for each type live in `packages/products/registry/templates/`. The parent-type matrix (which types may reference which) is enforced by the validator via rule codes `PT-1..PT-8`; supersession integrity via `SS-1..SS-4`.

## Workspace layout

pnpm workspace. Governed records + validator + toolchain each live as separate `@foundation/*` packages; repo root carries only orchestration.

```text
packages/
  shared/
    config/            # @foundation/config    shared tsconfig base + every tool config
    utils/
      core/            # @foundation/core       repoRoot() + miseExec()
      qa/              # @foundation/qa         lint/format dispatch + schema checks
      sync/            # @foundation/sync       generated-file drift guards
  products/
    registry/          # @foundation/registry   record spine + schema validator
      records/         # records partitioned by domain
      schema/          # JSON Schema draft 2020-12
      templates/       # per-type templates
      proposals/       # open-contribution drafts
      owners.yaml      # domain → team + lead manifest
      src/             # validate-records.ts + supporting code
      site/            # generated static index (built in CI)
```

Cross-package imports resolve through each package's `exports` map and run under Node's native TypeScript type-stripping — no build step.

## Adding a record

1. Pick the domain (matches a directory under `records/`) and the type.
2. Copy the matching template from `packages/products/registry/templates/<type>.template.md` into `records/<domain>/`.
3. Rename the file per pattern: `<type>-<id-lowercased>-<slug>.md` (e.g. `adr-0042-cache-topology.md`).
4. Fill the frontmatter — every required key comes from `schema/record.schema.json`.
5. Add any `references:` to parent records (validator asserts the parent-type matrix).
6. Run `pnpm qa:schema` locally. Fix any RULE-CODE violations reported by the validator.
7. Open a PR — CODEOWNERS routes review to the domain's team per `owners.yaml`.

## Ownership

`owners.yaml` maps each governed domain to the GitHub **team** that owns it (CODEOWNERS review routing) and its named **lead** (accountable engineer of record). Domain values in record frontmatter must match a key in `owners.yaml`; the validator asserts this with rule code `DOMAIN_UNKNOWN` / `OWNER_DOMAIN_MISMATCH`.

## Documentation

- [ADOPTING.md](ADOPTING.md) — how to bring a new product or runtime package into the foundation
- [AGENTS.md](AGENTS.md) — engineering rules every contributor (human or agent) follows
- [CONTRIBUTING.md](CONTRIBUTING.md) — local gates + PR flow
- [PARITY.md](PARITY.md) — intentional drifts against downstream forks
- Sibling repo: [ttt-studio-cole-30-60-90-plan](https://github.com/kaelys-js/ttt-studio-cole-30-60-90-plan) — a downstream fork that hosts the `cole-30-60-90` runtime product on top of this toolchain

## Requirements

- macOS or Linux
- `mise` (installs Node, pnpm, every linter/formatter from `mise.toml`)

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local gates every push must pass.

## Support + Security

- Bug reports: [Issues](https://github.com/kaelys-js/foundation-registry/issues)
- Questions: [Discussions](https://github.com/kaelys-js/foundation-registry/discussions)
- Security: [SECURITY.md](SECURITY.md) (private vulnerability reporting)
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Private — see repo settings.
