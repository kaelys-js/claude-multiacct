# Migrating from the old bash `claude-multiacct`

The pre-rewrite tool ran as a collection of shell scripts, a YAML
config, per-account mirror `.app` bundles, four launchd agents, and an
in-place patch to `/Applications/Claude.app`. `cma migrate` detects
and cleans up every artifact of that layout so the new (TypeScript,
single-app) tool can run cleanly.

## Report first

```bash
cma migrate
```

Read-only. Enumerates each detected artifact by category, path, and
severity, with a suggested fix. Categories:

- **`instances.yaml`** — the old YAML config at
  `~/.config/claude-multiacct/instances.yaml`. The new tool uses
  `registry.json` + `config.json` in the same directory.
- **`launchd-agent`** — one or more of
  `com.user.claude-{clone-refresh,sessions-sync,metadata-symlink,primary-patch-refresh}.plist`
  under `~/Library/LaunchAgents/`.
- **`mirror-clone`** — any `~/Applications/Claude Account *.app`
  bundle the old tool created per account.
- **`asar-patch`** — an in-place patch to
  `/Applications/Claude.app/Contents/Resources/app.asar`, either
  detected via a preserved `.multiacct-backup` sibling or via a
  marker string inside the asar itself.

## Apply the cleanup

```bash
cma migrate --apply           # asks y/N first
cma migrate --apply --yes     # non-interactive
```

`--apply` snapshots every removed item into
`~/.claude-multiacct-backups/<iso-timestamp>/migrate/` before deleting.
It runs best-effort: a failure on one item does not stop the
subsequent items, and the exit code is non-zero only if at least one
item failed.

## Pristine-primary restore

The delicate case. If the old tool left
`/Applications/Claude.app/Contents/Resources/app.asar.multiacct-backup`
in place, `--apply` moves that backup back over the patched `app.asar`
(and its `.unpacked` sibling if present). It does **not** touch
`Info.plist` — see the Rule 1 decision below.

After the restore, verify:

```bash
codesign -v /Applications/Claude.app
```

If that passes, you are done. If it fails, the old tool also modified
`Info.plist`'s `ElectronAsarIntegrity` block, and the safest recovery
is to reinstall Claude Desktop.

### Rule 1 decision — no Info.plist rewrite

`Info.plist → ElectronAsarIntegrity → app.asar.hash` is checked by
Electron at launch against the SHA-256 of the asar header (not the
whole file). Getting that hash wrong bricks the primary. We chose the
safe path — restore the byte-identical asar backup and leave
`Info.plist` alone — over a hopeful hash write. If `Info.plist` was
already correct for the pristine asar, the restore is a full recovery;
if it was patched to match the modified asar, `codesign -v` will fail
and reinstalling Claude Desktop is the guaranteed fix.

If the `.multiacct-backup` file is missing but a marker string is
still present in the asar, `--apply` refuses to touch the asar and
exits non-zero. Reinstall Claude Desktop to restore the Apple
signature.

## What runs after the cleanup

You are ready for the new tool's install flow. See
[README.md](README.md).
