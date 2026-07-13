# Architecture

## The problem

Claude Desktop (`/Applications/Claude.app`, Electron) stores OAuth per-`userData` directory. To run it under a second account you need a second `userData` dir. But the app's own login UI:

- Reuses the same `userData` dir for every login, so logout/login cycles the token
- Stores the account UUID in the OAuth blob AND uses it as a subdirectory name inside `<userData>/claude-code-sessions/` — logout/login orphans every session under the old UUID
- Persists nothing account-specific in the `~/.claude/` config dir (that's Claude Code CLI state, account-agnostic on the file layer but the desktop app injects the current account's OAuth token before launching CC)

So logging out is destructive. The alternative — running a second `Claude.app` instance with `--user-data-dir=<other>` — was the path this repo automates.

## The observation that made it possible

The desktop app is Electron. `open` supports `--env` on modern macOS which propagates env vars into the launched app. `Claude.app` reads `CLAUDE_CONFIG_DIR` for Claude Code state and honors the `--user-data-dir` Electron flag for Chromium state. With both set, one `Claude.app` binary boots into any identity.

Two more discoveries:
- `com.anthropic.claudefordesktop` doesn't set `LSMultipleInstancesProhibited` or `requestSingleInstanceLock`, so multiple `Claude.app` processes coexist
- The keychain item `Claude Code-credentials` is used **only by the standalone terminal CLI** (`~/.local/bin/claude`), NOT the desktop-embedded Claude Code. So a second desktop instance does not collide on the keychain

## The three artefacts per instance

Every instance has:

1. **`configDir`** (`~/.claude-<label>`) — where the desktop-embedded Claude Code writes JSONL bodies, sessions, plugins, skills. The mirror instance's `configDir` symlinks most of its subpaths at the primary's `~/.claude/` so session content is shared at file layer.
2. **`userData`** (`~/Library/Application Support/Claude-<Titlecase>`) — Chromium's per-instance store (cookies, IndexedDB, preferences, session storage). Cookies stay per-instance (per-account OAuth); IndexedDB / Local Storage / Session Storage sync one-way from the primary.
3. **A launcher pair**: a shell script at `~/.local/bin/claude-account-<label>` (uses `open -na /Applications/Claude.app --env CLAUDE_CONFIG_DIR=… --args --user-data-dir=…` for terminal invocation) and a Dock-clickable `Claude Account <Title>.app` bundle that is a full CLONE of `/Applications/Claude.app` with its `Info.plist` rewritten to a per-mirror bundle-id and its `MacOS/Claude` wrapped by a shell script that injects `CLAUDE_CONFIG_DIR` + `--user-data-dir`. See "The Dock-clone layer" below.

## The Dock-clone layer (why not a shell-launcher .app)

macOS Dock groups running processes by `CFBundleIdentifier`. A shell-launcher .app that `open`s `/Applications/Claude.app` inherits the primary bundle-id `com.anthropic.claudefordesktop` — the running mirror process ends up sharing the primary's Dock slot, invisible to the user. Only per-instance bundle-id parity between the Dock item and the running Claude process fixes this.

`lib/build-clone-app.sh` handles this per mirror:

- **`ditto`** `/Applications/Claude.app` → `~/Applications/Claude Account <Title>.app`. Preserves xattrs, resource forks, ACLs, and the codesign structure that `cp -R` would strip.
- **Rewrite** `Contents/Info.plist`: `CFBundleIdentifier=com.claude-multiacct.claude-account-<label>-desktop`, `CFBundleDisplayName=Claude Account <Title>`. **`CFBundleName` is deliberately left as "Claude"** — Chromium derives the helper .app folder name from `CFBundleName + " Helper"`, so rewriting it makes Electron fatal-exit at `electron_main_delegate_mac.mm:66` with "Unable to find helper app" before any window opens.
- **Wrap** `Contents/MacOS/Claude`: move real → `Claude.real`, write a `bash` shell script at `Claude` that `export CLAUDE_CONFIG_DIR="<cdir>"` then `exec "$(dirname "$0")/Claude.real" --user-data-dir="<udata>" "$@"`. `exec` is load-bearing — it replaces the process image so the running Claude Desktop IS the process macOS launched from the clone bundle.
- **Ad-hoc re-sign**: `codesign --force --deep --sign - <clone>`. Required because the plist mutation and executable wrap both invalidate the original signature. `--deep` re-signs every nested framework and helper .app in `Contents/Frameworks/`.
- **`lsregister -f`**: force-register the new bundle-id → clone-path mapping so the Dock doesn't cache a stale routing.
- **`xattr -rd com.apple.provenance`**: best-effort strip. Modern macOS protects the attribute, but the strip is retained for older releases and as a diagnostic marker.

Disk cost: ~745 MB per mirror. Two mirrors ≈ 1.5 GB under `~/Applications/`.

**Version drift + auto-refresh.** Claude Desktop's autoupdater (Squirrel) rewrites `/Applications/Claude.app` in place after every update. The mirror clones would then drift behind the primary until a manual `claude-multiacct refresh-clones`. Instead: `launchd/com.user.claude-clone-refresh.plist.tmpl` installs a WatchPaths agent that watches `/Applications/Claude.app/Contents/Info.plist`; on mtime change (Squirrel touches it at update-end), it invokes `bin/claude-clone-refresh.sh` which rebuilds every mirror clone against the new primary. The refresh subcommand refuses to run while any mirror is currently open (file locks would corrupt the ditto), but does NOT gate on the primary running — Squirrel restarts the primary as part of applying an update.

`claude-multiacct repair <label>` re-runs the full clone+plist+wrap+codesign+lsregister flow for one mirror; `claude-multiacct refresh-clones` runs it for every configured mirror; `claude-multiacct doctor` checks whether the codesign, bundle-id parity, Claude version parity, and LaunchServices registration are each intact.

## Layered sync (see docs/sync-model.md for detail)

Four layers of state need to move between instances, each with different sharing semantics:

1. **Session JSONL content** — Claude Code writes the full conversation log to `~/.claude/projects/<projectdir>/<sessId>.jsonl`. Account-agnostic; symlink the mirror's `projects/` at the primary's `projects/`.

2. **Desktop UI session metadata** — the sidebar (title, `isArchived`, `lastActivityAt`, `cwd`, `model`, `completedTurns`) is one JSON file per session at `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json`. The JSON body has NO `accountUuid` field, so both apps read the same file as "their own"; symlink `Claude-<label>/claude-code-sessions/<mirrorAcct>/<mirrorOrg>` at `Claude/claude-code-sessions/<primaryAcct>/<primaryOrg>`.

3. **Agent-mode subagent metadata** — same shape as (2) but only account-scoped: `<userData>/local-agent-mode-sessions/<accountUuid>/…`. Same per-account-folder symlink pattern.

4. **Chromium IndexedDB / Local Storage / Session Storage** — LevelDB stores. Exclusive-locked, cannot be symlinked between concurrent processes. `launchd` `WatchPaths` on the primary's `Local State` fires when Chromium rewrites it (app-close). Then rsync one-way primary→mirrors.

Layer 5 (Cookies / Preferences / Network Persistent State / Crashpad) is per-instance always — sharing would break OAuth or corrupt window state.

## launchd agents

Three `launchd` `LaunchAgents` back the runtime behaviour:

1. **`com.user.claude-sessions-sync`** — `WatchPaths` on the primary's `<userData>/Local State`. Chromium rewrites this file on app-close, which fires the agent; it then rsyncs layer-4 stores (IndexedDB / Local Storage / Session Storage) primary → every mirror. Refuses to run if any Claude Desktop process is still up.

2. **`com.user.claude-clone-refresh`** — `WatchPaths` on `/Applications/Claude.app/Contents/Info.plist`. Squirrel writes to this file at update-end; on mtime change the agent invokes `bin/claude-clone-refresh.sh` which rebuilds every mirror's clone.

3. **`com.user.claude-metadata-symlink`** — `WatchPaths` on every configured mirror's `<userData>/claude-code-sessions/`, `<userData>/local-agent-mode-sessions/`, AND `<userData>/config.json`. The two dirs are pre-created empty at `add-instance` time so the WatchPaths trigger is armed on paths that already exist; the file path only exists once the mirror has been launched at least once. The moment Claude Desktop writes to any of the three, the agent fires; `bin/claude-metadata-watcher.sh` then iterates every mirror and invokes `lib/metadata-symlinks.sh` on it, installing the layer-2 and layer-3 per-account-folder symlinks. UUID resolution is two-tier: `find -L` on the mirror's `<acct>/<org>` (works post-Code-first-use, when Desktop has created the per-account UUID subdir), and a parse of `<userData>/config.json` (works post-OAuth-signin, when Desktop has cached the token but no Code area has been opened yet). The config.json parser reads `lastKnownAccountUuid` and picks the org UUID whose `dxt:allowlistLastUpdated:<orgUuid>` timestamp is newest — that's the currently-active org for accounts belonging to more than one. Already-installed symlinks no-op; mirrors where neither resolution path yields all four UUIDs skip cleanly and get retried on the next fire. ThrottleInterval=15 coalesces Desktop's setup-time write bursts. Skipped entirely (agent uninstalled) when zero mirrors are configured.

`claude-multiacct doctor` reports the loaded state of all three agents. `claude-multiacct repair` re-renders and re-installs all three plists.

## Config file of record

`~/.config/claude-multiacct/instances.yaml` lists every instance and any per-instance path overrides. Every runtime action (`add-instance`, `remove-instance`, `repair`, `sync-now`, `doctor`) reads this file and never persists derived state elsewhere. Snapshot-before-write: any change to `instances.yaml` creates a backup under `~/.claude-multiacct-backups/<timestamp>-config/`.
