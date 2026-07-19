# Sync model

Session state moves between instances in four layers, each with different sharing semantics. Understanding which layer holds what is how you avoid the two failure modes: (a) syncing something that shouldn't move (breaks OAuth or corrupts window state), and (b) not syncing something that should (silent drift + confusing UI).

## Layer 1 — Session JSONL content

**Location.** `~/.claude/projects/<projectdirEncoded>/<sessionId>.jsonl` — one JSONL file per session with every message, tool call, and timestamp.

**Sharing.** File-layer symlink. On install we point:
```
~/.claude-<label>/projects → ~/.claude/projects
```

Both instances literally read and write the same inode. Real-time — no agent, no polling.

**Why safe.** Session IDs are UUIDs so two instances never pick the same ID. Claude Code appends line-by-line, and JSONL append is safe as long as writers don't race the same line. In practice only one Claude Code process owns a given session's bridge at a time (Claude Code enforces this), so concurrent writes to the same JSONL never happen.

**What about the OTHER config-dir subpaths?**

We also symlink `sessions`, `todos`, `shell-snapshots`, `plugins`, `skills` at the same layer for the same reason (session-id keyed, single writer, account-agnostic).

**Pre-create the primary target (C2).** Some of these subdirs are created lazily by Claude Code on first use — `todos`, `plugins`, and `skills` in particular appear later than `projects`/`sessions`. A mirror installed before the primary has created a given subdir would otherwise get a symlink pointing at a nonexistent target (`-L` true but `-e` false — a dangling link). `lib/metadata-symlinks.sh` therefore `mkdir -p`'s each primary target before linking, so every installed shared link both is a symlink AND resolves.

`.claude.json` and `settings.json` are per-instance — the mirror keeps its own copy (stripped of `oauthAccount` / `userID`) so identity doesn't leak.

## Layer 2 — Desktop UI session metadata

**Location.** `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json` — one JSON per session, sidebar-driving metadata (title, `isArchived`, `lastActivityAt`, `cwd`, `model`, `completedTurns`).

The primary's path might look like:
```
~/Library/Application Support/Claude/claude-code-sessions/87b5cd86…/c5e0ad3e…/local_<sessId>.json
```

**Sharing.** Per-account-folder symlink at userData level:
```
Claude-B/claude-code-sessions/<mirrorAcctUUID>/<mirrorOrgUUID>
  → Claude/claude-code-sessions/<primaryAcctUUID>/<primaryOrgUUID>
```

The key observation: the JSON files THEMSELVES have no `accountUuid` field. The account partition is encoded only in the FOLDER PATH. Symlinking at the folder layer makes both apps read the same `local_<sessId>.json` files as if they were "their own" account's sessions.

**Sidebar refresh.** The file layer is real-time (same inode). But the sidebar's React state is per-app; a change made in Claude B doesn't live-tail into Claude A's chat view. Switch sessions (or switch apps + return) to re-read from disk.

**Chicken-and-egg.** The mirror's account+org UUIDs are only assigned AFTER the mirror has logged in at least once. So this symlink is a POST-LOGIN install step. `install-instance.sh` skips it with a warning if the mirror hasn't logged in yet; run `claude-multiacct repair <label>` after the first login to finish the wiring.

## Layer 3 — Agent-mode subagent metadata

**Location.** `<userData>/local-agent-mode-sessions/<accountUuid>/…` — plan / explore / judge subagent state.

**Sharing.** Same per-account-folder symlink pattern as layer 2, but only account-scoped (no org partition below):
```
Claude-B/local-agent-mode-sessions/<mirrorAcctUUID>
  → Claude/local-agent-mode-sessions/<primaryAcctUUID>
```

Same "post-login install step" caveat.

## Layer 4 — Chromium IndexedDB / Local Storage / Session Storage

**Location.** `<userData>/{IndexedDB,Local Storage,Session Storage}/` — LevelDB stores. These hold:
- The claude.ai web-chat side of the app (drafts, chat cache, feature flags)
- Some UI state (theme preferences that Anthropic sync-serves, etc.)
- Artifact drafts

**Sharing.** `launchd` `WatchPaths` on the primary's `Local State` file (Chromium rewrites it on app close), triggering `bin/claude-sessions-sync.sh` which one-way rsyncs primary → every mirror.

**Why not symlink.** LevelDB opens are exclusive locks. If Claude A and Claude B both open the same LevelDB dir concurrently, one of them fails to acquire the lock and the store partially reads back a stale snapshot. Symlinking would guarantee this race.

**Why safe to rsync ON CLOSE.** Chromium flushes LevelDB to disk on `SIGTERM` / on `beforeunload`. `Local State` is the file it rewrites LAST as part of shutdown — using it as the WatchPaths trigger guarantees the rest has flushed. A 5-second grace inside the script covers any lag.

**Direction is primary → mirrors, always.** Bidirectional / last-writer-wins was tried and abandoned — the destination's IndexedDB would re-sync to the Anthropic server within seconds and drift back. Primary is source of truth.

**What if the primary is running while a sync fires?** The script hard-skips with `SKIP: at least one Claude Desktop instance is running (would rsync mid-flight state)` and logs it. Next trigger picks up where we left off.

## Layer 5 — Per-instance, NEVER SHARED

These stay per-instance. Sharing them would break auth or corrupt state:

- **`Cookies`** — per-account OAuth session cookies. Sharing them would give the mirror the primary's session and vice versa.
- **`Preferences`** — window state, zoom, per-instance UI settings.
- **`Network Persistent State`** — DNS-over-HTTPS cache, HSTS pins. Per-process.
- **`Crashpad`** — crash reports. Per-process.

## Wrong approaches that were tried and abandoned

- **Bidirectional IndexedDB rsync** (touched claude.ai web-chat's IndexedDB, which is server-backed). Destination would re-sync to Anthropic within seconds; drift crept in. Removed.
- **One-shot IndexedDB copy** at install. B re-synced its own state from the server within seconds — `a92a728f → 7d3af5ce` drift, 1 of 2 conversation blobs dropped. Removed.
- **Symlinking Cookies** — breaks OAuth; both apps would think they were the primary account.
- **Symlinking IndexedDB** — LevelDB lock contention as described above.

The mistake in the wrong approaches was conflating "claude.ai web-chat IndexedDB" (server-backed, per-account) with "Claude Code session metadata" (file-backed, account-agnostic). They live in different places and need different sharing mechanisms.
