# Architecture

The **single, unmodified `/Applications/Claude.app`** principle is
non-negotiable. Every subsystem here is either read-only against the
app bundle, or targets a per-user filesystem location outside of it.
Getting this wrong is why the old bash tool needed constant repair.

## Layer diagram

```text
┌───────────────────────────────────────────────────────────────────┐
│ /Applications/Claude.app  (pristine, Apple-signed, auto-updates)  │
└──┬──────────────────────────┬─────────────────────────────────────┘
   │                          │
   │ Chrome extension         │ spawns CLI:
   │ loaded via RDT anchor    │   ~/Library/Application Support/
   │ (electron-devtools       │     Claude/claude-code/<v>/claude.app/
   │  -installer fallback)    │       Contents/MacOS/claude
   │                          │           ↓
   ▼                          ▼        [PR2 shim]
[PR5b extension]         [claude.real]  swaps CLAUDE_CODE_OAUTH_TOKEN
   │                                    per session, then execs claude.real
   │
   │ shadow-DOM picker + usage widget
   ▼
[PR5a bridge daemon]  ← launchctl-managed at ~/Library/LaunchAgents/
   │                    com.claude-multiacct.bridge-daemon.plist
   │
   │ shared-secret channel (bridge.json)
   ▼
[PR3 watcher]  ← WatchPaths on ~/Library/Application Support/Claude/
                 claude-code/, re-applies PR2 shim on every version bump
```

## Per-PR contribution

| PR   | Layer                   | What it lands                                                     |
| ---- | ----------------------- | ----------------------------------------------------------------- |
| PR0  | Fork                    | Move code into `packages/products/claude-multiacct/`; toolchain   |
| PR1  | Domain models           | `AccountRegistry`, `Account`, verify-token schema, ports          |
| PR2  | CLI shim                | Swaps `claude` → `claude.real` + tiny shim; flag-gated            |
| PR3  | Watcher                 | Launchd `WatchPaths` agent that re-applies PR2 on version bumps   |
| PR4  | OAuth provisioning      | `provisionAccount`, `refreshAccount`, Keychain-backed token store |
| PR5a | Bridge daemon           | Long-lived HTTP daemon + `launchClaude` wrapper                   |
| PR5b | Code-tab extension      | Picker + usage widget in shadow DOM; loaded via RDT anchor        |
| PR6a | `cma` CLI foundation    | `init`, `account`, `status`, `doctor` (read-only + config only)   |
| PR6b | Orchestration + migrate | `install`, `uninstall`, `launch`, `migrate` + docs (this PR)      |

## Invariants

1. `/Applications/Claude.app` is **never modified**. Every mutating
   subsystem writes under `~/`.
2. Every installer is **flag-gated**. Default off. `cma install` is the
   sole opt-in that flips the flag on.
3. Every mutating op **snapshots first** into
   `~/.claude-multiacct-backups/<iso-timestamp>/`, so any change is
   reversible from that dir.
4. Ports are **injected** everywhere. Tests never touch the real fs,
   real `launchctl`, or the real network.

## What lives on disk after `cma install`

```text
~/.config/claude-multiacct/
    config.json                 # enable flag + paths
    registry.json               # pooled accounts, primary marker
    bridge.json                 # daemon's shared-secret snapshot (symlinked
                                # into the extension's install dir)

~/Library/LaunchAgents/
    com.claude-multiacct.watcher.plist         # PR3
    com.claude-multiacct.bridge-daemon.plist   # PR5a

~/Library/Application Support/Google/Chrome/Default/Extensions/
    fmkadmapgofadopljbjfkapdkoienihi/<version>/
        manifest.json                          # PR5b
        content.js
        bridge.json → ~/.config/claude-multiacct/bridge.json

~/Library/Application Support/Claude/claude-code/<version>/claude.app/
    Contents/MacOS/
        claude                                 # PR2 shim
        claude.real                            # original binary preserved
```
