# claude-multiacct

**Run any number of Claude Desktop instances under different accounts on the same Mac, sharing sessions between them, without logout/login.**

[![shellcheck](https://img.shields.io/badge/shellcheck-clean-brightgreen?style=flat-square)](#quality-gates)
[![bats](https://img.shields.io/badge/bats-hermetic-brightgreen?style=flat-square)](#quality-gates)
[![gitleaks](https://img.shields.io/badge/gitleaks-clean-brightgreen?style=flat-square)](#quality-gates)

## What it does

Claude Desktop stores OAuth per-userData directory. `--user-data-dir` lets you point at a second one; combined with `CLAUDE_CONFIG_DIR` for the embedded Claude Code CLI, the same app binary boots into a different identity. This repo automates:

- **Instance install**: one command builds the per-instance `configDir` + `userData` + terminal launcher + Dock-clickable `.app` bundle (with the ad-hoc codesign / xattr / `lsregister` dance Gatekeeper requires).
- **Session sharing** at every layer that's safe to share (JSONL bodies + desktop UI metadata + agent-mode metadata → symlinked at file layer; Chromium IndexedDB / Local Storage / Session Storage → `launchd`-triggered rsync one-way primary→mirrors on primary-close).
- **Per-instance state that must stay isolated** (Cookies / Preferences / Network Persistent State / Crashpad) is left untouched, per instance.
- **Repair + diagnostics**: idempotent `repair` + a `doctor` subcommand that walks every layer and reports what's healthy vs drifted.

## Quick start

```sh
# 1. Clone + install the toolchain (self-contained via mise).
git clone git@github.com:kaelys-js/claude-multiacct.git ~/Documents/work/@personal/claude-multiacct
cd ~/Documents/work/@personal/claude-multiacct
mise install                              # pins shellcheck, bats, gitleaks, yq
export PATH="$PWD/bin:$PATH"              # or symlink bin/claude-multiacct into ~/.local/bin/

# 2. Bootstrap. Detects the running Claude Desktop primary + writes ~/.config/claude-multiacct/instances.yaml.
claude-multiacct init

# 3. Add every mirror instance you want.
claude-multiacct add-instance b --email you@example.com
claude-multiacct add-instance work --email work@example.com

# 4. Launch the new instance + sign in (once).
open ~/Applications/Claude\ Account\ B.app
# → sign in to Account B via the normal Claude Desktop UI

# 5. After the first launch + login, re-run repair to finish the metadata symlinks.
claude-multiacct repair b

# 6. Confirm health.
claude-multiacct doctor
```

## Sharing model

See [docs/sync-model.md](docs/sync-model.md) for the full four-layer breakdown. Short version:

| Layer | Location | Sharing mechanism |
|---|---|---|
| Session JSONL content | `~/.claude/projects/…/<sessId>.jsonl` | file-layer symlink (`~/.claude-<label>/projects` → primary) |
| Desktop UI session metadata | `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json` | per-account-folder symlink at userData level |
| Agent-mode subagent metadata | `<userData>/local-agent-mode-sessions/<accountUuid>/…` | per-account-folder symlink at userData level |
| Chromium IndexedDB / Local Storage / Session Storage | `<userData>/{IndexedDB,Local Storage,Session Storage}/` | `launchd`-triggered rsync primary → mirrors on primary close |
| Cookies / Preferences / Network Persistent State / Crashpad | `<userData>/{Cookies,Preferences,…}` | NEVER SHARED (per-instance OAuth + window state; sharing breaks auth) |

## What's in the repo

```
bin/
  claude-multiacct          # the CLI (init / add-instance / remove-instance / list / repair / sync-now / doctor / qa)
  claude-sessions-sync.sh   # sync worker (called by launchd + `sync-now`)
lib/
  common.sh                 # shared functions (logging, config parsing, path helpers)
  install-instance.sh       # per-instance idempotent installer
  uninstall-instance.sh     # symmetric teardown (with snapshot-first)
  build-cli-launcher.sh     # writes ~/.local/bin/claude-account-<label>
  build-launcher-app.sh     # builds Claude Account <Title>.app + codesign + xattr + lsregister
  metadata-symlinks.sh      # per-account-folder metadata symlinks
  install-launchd.sh        # renders + bootstraps the WatchPaths agent
  discover.sh               # on-disk health inspection (used by list + doctor)
launchd/
  com.user.claude-sessions-sync.plist.tmpl   # launchd template (paths substituted at install)
config/
  instances.example.yaml    # scaffold copied by init
docs/
  architecture.md           # end-to-end system diagram
  sync-model.md             # the four-layer sharing model in detail
  dock-icon-fix.md          # why Dock launch silently fails on unsigned bundles + the fix
  troubleshooting.md        # symptom → diagnosis table
tests/
  smoke.bats                # hermetic install/uninstall under a scratch $HOME
```

## Quality gates

```sh
claude-multiacct qa lint    # shellcheck -x + gitleaks
claude-multiacct qa test    # bats tests/
```

Both must pass on `main`. `.gitleaks.toml` covers OAuth-adjacent paths that the tooling touches.

## Known issues + fixes

- **Dock icon fails silently** → see [docs/dock-icon-fix.md](docs/dock-icon-fix.md). `claude-multiacct repair <label>` re-runs the codesign + xattr + lsregister dance. `claude-multiacct doctor` catches when the fix has drifted.
- **launchd agent missing after macOS update** → `claude-multiacct repair` re-installs the plist and re-bootstraps.
- **Mirror instance never logged in yet** → `metadata-symlinks.sh` skips the desktop-UI-metadata symlinks with a warning; run `claude-multiacct repair <label>` after first login + quit.

## Engineering

This repo follows the 13 rules in [AGENTS.md](AGENTS.md). AI agents load `AGENTS.md` automatically; humans reading the code should skim it once too.

## Related

- The design was extracted from an ad-hoc setup on this Mac (2026-06-24 through 2026-06-26) — see the linked memory entry in [`~/.claude/projects/memory/claude-multiacct-second-instance.md`](../..). This repo is the canonical version.
