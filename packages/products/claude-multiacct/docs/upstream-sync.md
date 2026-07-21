# Upstream sync

This fork tracks [`kaelys-js/foundation-registry`](https://github.com/kaelys-js/foundation-registry) for shared infra (mise config, lint config, `packages/shared/`, CI workflows, `.schemas/`). The fork's product package (`packages/products/claude-multiacct/`) never syncs from upstream.

## Automatic

`.github/workflows/sync-upstream.yml` runs on cron and on manual `workflow_dispatch`. It merges `upstream/main` into `main` using a fixed conflict rule:

- Shared infra paths (`packages/shared`, `.schemas`, `mise.toml`, `mise.lock`, `turbo.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `vitest.config.ts`, `renovate.json5`, `bin/mise`, `tsconfig.json`) → upstream wins.
- Everything else that conflicts → fork wins.

Requires the repo secret `GH_TOKEN` (personal-access-token with `repo` + `workflow` scope on the owning account). Set once via `gh secret set GH_TOKEN --repo <owner>/<repo>`.

## Manual

```sh
pnpm sync-upstream                   # ff-only; fails on conflict
pnpm sync-upstream:opt-in --force    # regenerate the workflow file
```

## Seed (one-time)

The fork was scaffolded (not git-cloned), so the two histories were originally unrelated. A one-time seed merge established a common ancestor:

```sh
git merge --allow-unrelated-histories --no-ff --no-commit upstream/main
# resolve per the conflict rule above
git commit -s -m "chore(sync): seed merge-base with upstream/main"
```

After that seed, every subsequent sync is an ordinary three-way merge.

## Fork-only paths (never overwritten from upstream)

- `packages/products/claude-multiacct/` — the whole product
- `README.md` — fork-specific product front page
- `docs/` — this documentation
- `.github/ISSUE_TEMPLATE/` — fork-specific issue templates
- `.sync-upstream.json` — fork sync-mode config
