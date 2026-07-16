# claude-multiacct

[![CI](https://github.com/kaelys-js/claude-multiacct/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kaelys-js/claude-multiacct/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![shellcheck](https://img.shields.io/badge/shellcheck-clean-brightgreen?style=flat-square)](#quality-gates)
[![bats](https://img.shields.io/badge/bats-hermetic-brightgreen?style=flat-square)](#quality-gates)
[![gitleaks](https://img.shields.io/badge/gitleaks-clean-brightgreen?style=flat-square)](#quality-gates)

**Run any number of Claude Desktop instances under different accounts on the same Mac, sharing sessions between them, without logout/login.**

## What it does

Claude Desktop stores OAuth per-userData directory. `--user-data-dir` lets you point at a second one; combined with `CLAUDE_CONFIG_DIR` for the embedded Claude Code CLI, the same app binary boots into a different identity. This repo automates:

- **Instance install** — one command builds the per-instance `configDir` + `userData` + terminal launcher + Dock-clickable `.app` bundle (a full ~745 MB clone of `/Applications/Claude.app` with a rewritten `CFBundleIdentifier` so the Dock groups each mirror separately from the primary — see [docs/dock-icon-fix.md](docs/dock-icon-fix.md)). A `launchd` WatchPaths agent auto-refreshes every clone after each Claude Desktop Squirrel update; disk cost is ~745 MB per mirror.
- **Session sharing** at every layer that's safe to share (JSONL bodies + desktop UI metadata + agent-mode metadata → symlinked at file layer; Chromium IndexedDB / Local Storage / Session Storage → `launchd`-triggered rsync one-way primary → mirrors on primary-close).
- **Per-instance state that must stay isolated** (Cookies / Preferences / Network Persistent State / Crashpad) is left untouched, per instance.
- **Repair + diagnostics** — idempotent `repair` + a `doctor` subcommand that walks every layer and reports what's healthy vs drifted.

## Quickstart

Fresh Mac? Get the prerequisites first:

```sh
xcode-select --install                   # git + build tools
curl https://mise.run | sh               # mise (pins the toolchain)
brew install gh                          # GitHub CLI (or use SSH for a private clone)
gh auth login                            # authorise your GitHub account
```

Then clone + bootstrap:

```sh
# 1. Clone + install the pinned toolchain (self-contained via mise).
gh repo clone kaelys-js/claude-multiacct ~/Documents/work/@personal/claude-multiacct
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
#    writes on OAuth token cache — derives the required account+org UUIDs
#    from `lastKnownAccountUuid` + the newest `dxt:allowlistLastUpdated:<org>`
#    timestamp, installs the session-metadata symlinks the moment sign-in
#    completes, and on the first symlink install auto-quits + relaunches
#    the running mirror so Desktop's React sidebar re-reads the freshly
#    symlinked session dir. Sessions appear within seconds of sign-in with
#    no manual quit/relaunch step.
open ~/Applications/Claude\ Account\ B.app
# → sign in to Account B via the normal Claude Desktop UI. Sessions appear.

# 7. (Optional fallback) if the metadata symlinks didn't appear — e.g. the
#    launchd agent hadn't been loaded, or you're on an older macOS release —
#    run repair to install them by hand.
claude-multiacct repair b

# 8. Confirm health.
claude-multiacct doctor
```

### Running a command against a mirror instance

`claude-multiacct exec <label> [--] <cmd> [args…]` sets `CLAUDE_CONFIG_DIR` and
`CHROMIUM_USER_DATA_DIR` to the mirror's paths and execs the given command:

```sh
# Point `claude` at the 'b' mirror for one invocation:
claude-multiacct exec b -- claude
# Any tool that reads $CLAUDE_CONFIG_DIR (Anthropic's CLI, Claude Code SDK, etc.)
# sees the mirror's config, not the primary.

# No command → dry-run: prints the two `export` lines the wrapper would use.
# Useful for `eval "$(claude-multiacct exec b)"` in a subshell.
claude-multiacct exec b
```

The subcommand's exit code is the child command's exit code, so it composes
cleanly in scripts and Makefiles.

### Uninstall

```sh
claude-multiacct remove-instance <label>   # tears down configDir + userData + clone + launcher (snapshots first)
claude-multiacct uninstall                 # removes the ~/.local/bin symlink
# Nuke every trace (launchd + config + backups): see docs/troubleshooting.md → "Complete reset".
```

## Upgrading an existing install

```sh
# 1. Pull latest.
cd ~/Documents/work/@personal/claude-multiacct
git pull

# 2. Re-run install so the CLI symlink at ~/.local/bin/claude-multiacct
#    picks up any new subcommands (idempotent — safe to re-run any time;
#    only rewrites the symlink if the target has changed).
bin/claude-multiacct install

# 3. Verify. `doctor --json` gives a structured JSON report suitable for
#    piping to jq or diffing between two Macs.
claude-multiacct doctor
claude-multiacct doctor --json | jq .
```

**On any additional Mac** — run the same steps 1-3. Anthropic's per-account
cloud already syncs each account's sessions across devices, so as long as each
mirror on the second Mac is signed in with the same account as on the first,
the sessions appear on both. See [docs/cross-mac-setup.md](docs/cross-mac-setup.md)
for the field-by-field cross-Mac diff protocol.

To verify two installs are structurally identical, run on each Mac:

```sh
claude-multiacct doctor --json > "$(hostname -s).json"
```

then copy both JSON files to one machine and diff them.

## Sharing model

See [docs/sync-model.md](docs/sync-model.md) for the full four-layer breakdown. Short version:

| Layer | Location | Sharing mechanism |
|---|---|---|
| Session JSONL content | `~/.claude/projects/…/<sessId>.jsonl` | file-layer symlink (`~/.claude-<label>/projects` → primary) |
| Desktop UI session metadata | `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json` | per-account-folder symlink at userData level |
| Agent-mode subagent metadata | `<userData>/local-agent-mode-sessions/<accountUuid>/…` | per-account-folder symlink at userData level |
| Chromium IndexedDB / Local Storage / Session Storage | `<userData>/{IndexedDB,Local Storage,Session Storage}/` | `launchd`-triggered rsync primary → mirrors on primary close |
| Cookies / Preferences / Network Persistent State / Crashpad | `<userData>/{Cookies,Preferences,…}` | NEVER SHARED (per-instance OAuth + window state; sharing breaks auth) |

## Documentation

- [docs/architecture.md](docs/architecture.md) — end-to-end system diagram
- [docs/sync-model.md](docs/sync-model.md) — the four-layer sharing model in detail
- [docs/dock-icon-fix.md](docs/dock-icon-fix.md) — why Dock launch silently fails on unsigned bundles + the fix
- [docs/cross-mac-setup.md](docs/cross-mac-setup.md) — running the same mirrors on multiple Macs
- [docs/troubleshooting.md](docs/troubleshooting.md) — symptom → diagnosis table
- [AGENTS.md](AGENTS.md) — engineering rules every contributor (human or agent) follows
- [CONTRIBUTING.md](CONTRIBUTING.md) — local gates + PR flow

## Requirements

- macOS (tested on 15.x)
- Claude Desktop installed at `/Applications/Claude.app` with the primary account signed in
- `mise` (pins shellcheck, bats, gitleaks, yq, yamllint from `mise.toml`)
- `gh` for a private clone (or SSH); `git` for pulls

## Development

Repository layout:

```text
bin/                        # the CLI + rsync/refresh/metadata-watcher workers
lib/                        # per-instance install/uninstall/build helpers
launchd/                    # WatchPaths agent templates (sessions-sync / clone-refresh / metadata-symlink)
config/instances.example.yaml
docs/                       # architecture / sync-model / dock-icon-fix / troubleshooting / cross-mac-setup
tests/                      # bats — smoke / sync-worker / clone-app / metadata-watcher (52 hermetic tests)
```

### Quality gates

```sh
claude-multiacct qa lint    # shellcheck -x + gitleaks
claude-multiacct qa test    # bats tests/
```

Both must pass on `main`. `.gitleaks.toml` covers OAuth-adjacent paths that the tooling touches.

### Known issues + fixes

- **Claude Desktop updated but mirror shows old version** — the `com.user.claude-clone-refresh` WatchPaths agent auto-refreshes on Squirrel updates. If it hasn't fired (e.g. a mirror was running at update-time and the refresh skipped it), run `claude-multiacct refresh-clones` manually after quitting the mirror(s).
- **launchd agent missing after macOS update** — macOS occasionally resets per-user launchd state after a major OS update. `claude-multiacct repair` re-installs and re-loads all three agents.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the local gates every push must pass.

## Support + Security

- Bug reports: [Issues](https://github.com/kaelys-js/claude-multiacct/issues)
- Questions: [Discussions](https://github.com/kaelys-js/claude-multiacct/discussions)
- Security: [SECURITY.md](SECURITY.md) (private vulnerability reporting)
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE) © kaelys-js
