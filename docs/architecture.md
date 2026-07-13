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
3. **A launcher pair**: a shell script at `~/.local/bin/claude-account-<label>` and a Dock-clickable `Claude Account <Title>.app` bundle. Both invoke:
   ```
   open -na /Applications/Claude.app --env CLAUDE_CONFIG_DIR=… --args --user-data-dir=…
   ```

## Why the .app bundle needs codesign + xattr + lsregister

Gatekeeper uses different code paths for `open` (from a shell) vs Dock-click (via LaunchServices).

- **Shell `open`**: skips the "is this signed at all" check. Ad-hoc bundles launch fine.
- **Dock LaunchServices**: enforces the check even for ad-hoc bundles. Unsigned + provenance-tagged bundles are silently rejected — no window, no error dialog, no Gatekeeper prompt. Symptom: click Dock icon, nothing happens.

The fix is a three-part dance:
1. `codesign --force --deep --sign -` — ad-hoc signature (no Developer ID needed; Gatekeeper's LaunchServices path accepts ad-hoc)
2. `xattr -d com.apple.provenance` — strip the "downloaded from browser" quarantine attribute (spuriously applied to freshly-built bundles in some cases; when present, Gatekeeper hardens further and rejects even ad-hoc signatures)
3. `lsregister -f` — force re-register the bundle-ID → path mapping so LaunchServices doesn't cache a stale entry

`claude-multiacct repair <label>` re-runs all three; `claude-multiacct doctor` checks whether each layer is intact.

## Layered sync (see docs/sync-model.md for detail)

Four layers of state need to move between instances, each with different sharing semantics:

1. **Session JSONL content** — Claude Code writes the full conversation log to `~/.claude/projects/<projectdir>/<sessId>.jsonl`. Account-agnostic; symlink the mirror's `projects/` at the primary's `projects/`.

2. **Desktop UI session metadata** — the sidebar (title, `isArchived`, `lastActivityAt`, `cwd`, `model`, `completedTurns`) is one JSON file per session at `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json`. The JSON body has NO `accountUuid` field, so both apps read the same file as "their own"; symlink `Claude-<label>/claude-code-sessions/<mirrorAcct>/<mirrorOrg>` at `Claude/claude-code-sessions/<primaryAcct>/<primaryOrg>`.

3. **Agent-mode subagent metadata** — same shape as (2) but only account-scoped: `<userData>/local-agent-mode-sessions/<accountUuid>/…`. Same per-account-folder symlink pattern.

4. **Chromium IndexedDB / Local Storage / Session Storage** — LevelDB stores. Exclusive-locked, cannot be symlinked between concurrent processes. `launchd` `WatchPaths` on the primary's `Local State` fires when Chromium rewrites it (app-close). Then rsync one-way primary→mirrors.

Layer 5 (Cookies / Preferences / Network Persistent State / Crashpad) is per-instance always — sharing would break OAuth or corrupt window state.

## Config file of record

`~/.config/claude-multiacct/instances.yaml` lists every instance and any per-instance path overrides. Every runtime action (`add-instance`, `remove-instance`, `repair`, `sync-now`, `doctor`) reads this file and never persists derived state elsewhere. Snapshot-before-write: any change to `instances.yaml` creates a backup under `~/.claude-multiacct-backups/<timestamp>-config/`.
