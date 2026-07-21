# Install and uninstall

## Install

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node \
  packages/products/claude-multiacct/dist/cma.js install
```

Runs five ordered steps:

1. **legacy-cleanup** — detects + prompts to remove old bash-tool artifacts (see below). Pass `CMA_YES=1` to skip the confirm.
2. **shim** — copies the shim binary into `/Applications/Claude.app/…/MacOS/claude`, renaming the original to `claude.real`.
3. **watcher** — installs a launchd agent that re-applies the shim after Claude auto-updates.
4. **daemon** — installs the bridge-daemon launchd agent; starts it.
5. **extension** — plants the extension at Claude's DevTools loader path.

Idempotent — safe to re-run.

## Uninstall

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node \
  packages/products/claude-multiacct/dist/cma.js uninstall
```

Removes every artifact the install created. Old bash-tool artifacts are NOT touched here — use `install` for auto-cleanup, or remove them manually.

## Legacy bash-tool auto-cleanup

If the machine ran the older bash-based multi-clone tool that preceded this TypeScript rewrite, `cma install` detects + prompts to remove:

- `~/Applications/Claude Account *.app` bundles (clone apps)
- Launchd agents: `com.user.claude-{sessions-sync,clone-refresh,primary-patch-refresh,metadata-symlink}`
- Legacy `bin/claude-multiacct` in `$PATH`
- `~/Library/Application Support/Claude-*/` mirror stores (excluding the current TS system's own)
- `~/.claude-multiacct-backups/` legacy backup dir

One prompt with a summary; `CMA_YES=1` skips it. Idempotent.

## Verify

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node \
  packages/products/claude-multiacct/dist/cma.js status
```

Prints per-subsystem install state (present, missing, mismatched) and the current registry contents.

## Uninstall old bash tool WITHOUT installing the TS system

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node \
  packages/products/claude-multiacct/dist/cma.js legacy-cleanup --yes
```

Runs step 1 only.
