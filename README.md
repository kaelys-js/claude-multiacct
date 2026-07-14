# claude-multiacct

**Run any number of Claude Desktop instances under different accounts on the same Mac, sharing sessions between them, without logout/login.**

[![shellcheck](https://img.shields.io/badge/shellcheck-clean-brightgreen?style=flat-square)](#quality-gates)
[![bats](https://img.shields.io/badge/bats-hermetic-brightgreen?style=flat-square)](#quality-gates)
[![gitleaks](https://img.shields.io/badge/gitleaks-clean-brightgreen?style=flat-square)](#quality-gates)

## What it does

Claude Desktop stores OAuth per-userData directory. `--user-data-dir` lets you point at a second one; combined with `CLAUDE_CONFIG_DIR` for the embedded Claude Code CLI, the same app binary boots into a different identity. This repo automates:

- **Instance install**: one command builds the per-instance `configDir` + `userData` + terminal launcher + Dock-clickable `.app` bundle (a full ~745 MB clone of `/Applications/Claude.app` with a rewritten `CFBundleIdentifier` so the Dock groups each mirror separately from the primary — see [docs/dock-icon-fix.md](docs/dock-icon-fix.md)). A `launchd` WatchPaths agent auto-refreshes every clone after each Claude Desktop Squirrel update; disk cost is ~745 MB per mirror.
- **Session sharing** at every layer that's safe to share (JSONL bodies + desktop UI metadata + agent-mode metadata → symlinked at file layer; Chromium IndexedDB / Local Storage / Session Storage → `launchd`-triggered rsync one-way primary→mirrors on primary-close).
- **Per-instance state that must stay isolated** (Cookies / Preferences / Network Persistent State / Crashpad) is left untouched, per instance.
- **Repair + diagnostics**: idempotent `repair` + a `doctor` subcommand that walks every layer and reports what's healthy vs drifted.

## Prerequisites

Fresh Mac? Get these first:

```sh
xcode-select --install                   # git + build tools
curl https://mise.run | sh               # mise (pins the toolchain)
brew install gh                          # GitHub CLI (or use SSH — either works for a private clone)
gh auth login                            # authorise your GitHub account
```

Below, `<owner>/claude-multiacct` is a placeholder — replace `<owner>` with whichever GitHub account or org has been granted access to the repo (typically an individual account that owns the fork you've been shared into).

## Quick start

```sh
# 1. Clone + install the toolchain (self-contained via mise).
gh repo clone <owner>/claude-multiacct ~/Documents/work/@personal/claude-multiacct
cd ~/Documents/work/@personal/claude-multiacct
mise install                              # pins shellcheck, bats, gitleaks, yq, yamllint

# 2. Put the CLI on PATH (idempotent; symlinks into ~/.local/bin/claude-multiacct).
bin/claude-multiacct install
# Ensure ~/.local/bin is on PATH — add to ~/.zshrc if not:
#   export PATH="$HOME/.local/bin:$PATH"

# 3. Make sure Claude Desktop is installed at /Applications/Claude.app and you've
#    signed into the PRIMARY account you want it to boot into by default (once).

# 4. Bootstrap. Detects the primary from ~/.claude/.claude.json + writes
#    ~/.config/claude-multiacct/instances.yaml + installs the two launchd
#    agents that don't depend on any mirrors existing yet (sessions-sync +
#    clone-refresh). The third agent (metadata-symlink) gets installed by
#    the first `add-instance` below.
claude-multiacct init

# 5. Add every mirror instance you want. Each mirror clones /Applications/Claude.app
#    (~745 MB, ~30-60s per clone) into ~/Applications/Claude Account <Title>.app
#    with its own bundle-id + shell-wrapped MacOS/Claude.
claude-multiacct add-instance b --email you@example.com
claude-multiacct add-instance work --email work@example.com

# 6. Launch the new instance + sign in (once). The launchd metadata-symlink
#    agent watches the per-mirror <userData>/config.json — which Desktop
#    writes on OAuth token cache — and derives the required account+org UUIDs
#    from `lastKnownAccountUuid` + the newest `dxt:allowlistLastUpdated:<org>`
#    timestamp. It installs the session-metadata symlinks the moment sign-in
#    completes, no "open Code inside Desktop first" step required. On the
#    first symlink install the watcher also auto-quits + relaunches the
#    running mirror so Desktop's React sidebar re-reads the freshly-symlinked
#    session dir on app-start — sessions appear within seconds of sign-in
#    with no manual quit/relaunch step.
open ~/Applications/Claude\ Account\ B.app
# → sign in to Account B via the normal Claude Desktop UI. Sessions appear.

# 7. (Optional fallback) if the metadata symlinks didn't appear — e.g. the
#    launchd agent hadn't been loaded, or you're on an older macOS release —
#    run repair to install them by hand.
claude-multiacct repair b

# 8. Confirm health.
claude-multiacct doctor
```

## Upgrading from a previous install

If you installed a previous version of this repo and see `bundle-id-drift` under `claude-multiacct doctor`, rebuild every clone against the current bundle-id namespace:

```sh
git pull
claude-multiacct refresh-clones     # rebuilds every mirror clone; refuses if any mirror is running
# or, per instance:
claude-multiacct repair <label>
```

Then `claude-multiacct doctor` should report each instance `→ ok`. Dock launch of the rebuilt clones is served from the new bundle-id via LaunchServices.

## Uninstall

```sh
claude-multiacct remove-instance <label>   # tears down configDir + userData + clone + launcher (snapshots first)
claude-multiacct uninstall                 # removes the ~/.local/bin symlink
# Nuke every trace (launchd + config + backups): see docs/troubleshooting.md → "Complete reset".
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
  claude-multiacct              # the CLI (install / uninstall / init / add-instance / remove-instance /
                                #  list [--tsv] / repair / sync-now / sync-log / refresh-clones / doctor / qa)
  claude-sessions-sync.sh       # sessions rsync worker (called by launchd + `sync-now`)
  claude-clone-refresh.sh       # clone-refresh worker (called by launchd on Claude Desktop update)
  claude-metadata-watcher.sh    # metadata-symlink worker (called by launchd on mirror sign-in)
lib/
  common.sh                 # shared functions (logging, config parsing, path helpers)
  install-instance.sh       # per-instance idempotent installer
  uninstall-instance.sh     # symmetric teardown (with snapshot-first)
  build-cli-launcher.sh     # writes ~/.local/bin/claude-account-<label>
  build-clone-app.sh        # clones Claude.app → Claude Account <Title>.app + rewrites Info.plist + wraps MacOS/Claude + codesigns
  metadata-symlinks.sh      # per-account-folder metadata symlinks
  install-launchd.sh        # renders + bootstraps all three WatchPaths agents
  discover.sh               # on-disk health inspection (used by list + doctor)
launchd/
  com.user.claude-sessions-sync.plist.tmpl     # sessions rsync agent template
  com.user.claude-clone-refresh.plist.tmpl     # clone refresh agent template (fires on Claude.app Info.plist mtime)
  com.user.claude-metadata-symlink.plist.tmpl  # metadata-symlink agent template (fires on mirror sign-in)
config/
  instances.example.yaml    # scaffold copied by init
docs/
  architecture.md           # end-to-end system diagram
  sync-model.md             # the four-layer sharing model in detail
  dock-icon-fix.md          # why Dock launch silently fails on unsigned bundles + the fix
  troubleshooting.md        # symptom → diagnosis table
tests/
  smoke.bats                # 23 tests — install/uninstall/list/repair/sync-log/doctor under a scratch $HOME
  sync-worker.bats          #  5 tests — hermetic coverage of bin/claude-sessions-sync.sh
  clone-app.bats            # 12 tests — hermetic coverage of lib/build-clone-app.sh (uses a fake Claude.app fixture)
  metadata-watcher.bats     # 12 tests — hermetic coverage of bin/claude-metadata-watcher.sh, pre-created watch targets, and config.json UUID derivation
```

## Quality gates

```sh
claude-multiacct qa lint    # shellcheck -x + gitleaks
claude-multiacct qa test    # bats tests/
```

Both must pass on `main`. `.gitleaks.toml` covers OAuth-adjacent paths that the tooling touches.

## Known issues + fixes

- **Claude Desktop updated but mirror shows old version** → the `com.user.claude-clone-refresh` WatchPaths agent auto-refreshes on Squirrel updates. If it hasn't fired (e.g. a mirror was running at update-time and the refresh skipped it), run `claude-multiacct refresh-clones` manually after quitting the mirror(s).
- **launchd agent missing after macOS update** → macOS occasionally resets per-user launchd state after a major OS update. `claude-multiacct repair` re-installs and re-loads all three agents.

## Engineering

This repo follows the 13 rules in [AGENTS.md](AGENTS.md). AI agents load `AGENTS.md` automatically; humans reading the code should skim it once too.
