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

`claude-multiacct repair <label>` re-runs the full clone+plist+wrap+codesign+lsregister flow for one mirror; `claude-multiacct refresh-clones` runs it for every configured mirror; `claude-multiacct doctor` checks whether the codesign, bundle-id parity, Claude version parity, LaunchServices registration, and asar-patch state (see below) are each intact.

## The asar patch layer

Squirrel (Claude Desktop's auto-updater) verifies each downloaded update against the primary bundle's Developer ID Designated Requirement. A mirror is ad-hoc signed — Squirrel rejects any download it attempts against DR mismatch — and the running Claude Desktop surfaces the failure to the user as "Failed to check for updates" on the Claude menu → Check for Updates click, plus recurring `[updater] Update check failed` lines in `~/Library/Logs/Claude/main.log` while the app is open (auto-poll runs every 15 min, gated behind a GrowthBook flag). None of that is actionable — the mirror can't be updated in-place because we OWN the bundle-id rewrites Squirrel's DR check would break. `lib/asar-patch-clone.sh` short-circuits Squirrel on both the auto-poll and menu-click paths.

The patch operates on `Contents/Resources/app.asar` (Anthropic's bundled JS + assets, packed into an ~40 MB Electron asar archive) via `@electron/asar` — the same npm package used to build the archive:

1. **Extract** the asar into a working dir under `~/Library/Logs/claude-multiacct/asar-patch-<label>/extracted/`.
2. **Append** a per-mirror plist path to the managed-preferences list. Claude Desktop's managed-config reader (function `bXt()` in `.vite/build/index.chunk-DD6nxfJK.js` AND `.vite/build/index.pre.js`) returns a hard-coded list of two plist paths under `/Library/Managed Preferences/` — the standard macOS MDM locations that are always empty on a personal Mac. We append `process.resourcesPath + "/claude-multiacct-mirror-prefs.plist"` — a per-mirror plist at `Contents/Resources/claude-multiacct-mirror-prefs.plist` inside the clone bundle — as a third entry. When Claude iterates the list it now finds our plist and reads `disableAutoUpdates=YES` (the flat-key alias for `autoUpdate.disabled`, per the managed-config schema in the same JS chunk). Effect:
   - **Auto-poll path.** `i_t()` — the periodic auto-update check — short-circuits on `Oe().autoUpdate.disabled` and logs `[updater] Auto-updates disabled by enterprise policy` instead of firing a Squirrel round-trip. No network call, no failure.
   - **Menu-click path.** `NRn()` — the "Check for Updates…" menu builder — sees the same `disabled=true`, sets `enabled:false` on the menu item, and swaps the sublabel to Anthropic's own "Updates disabled by admin" string (defaultMessageId `fALugGmt33`). Clicking the disabled item does nothing; the old "Failed to check for updates" dialog is never reachable.
3. **Repack** the asar with the same `--unpack "{*.node,*.dylib,spawn-helper}"` glob that `/Applications/Claude.app` was built with (verified against `/Applications/Claude.app/Contents/Resources/app.asar.unpacked/` — `@ant/claude-native/*.node`, `node-pty/prebuilds/*/spawn-helper`, `office365-mcp/libmsalruntime_arm64.dylib`).
4. **Update** `Contents/Info.plist`'s `ElectronAsarIntegrity → "Resources/app.asar" → hash` value to the SHA-256 of the new asar's `getRawHeader().headerString`. This is the value Electron computes at boot (`electron/asar/asar_util.cc:143`); any drift and the mirror fatal-exits with `FATAL:asar_util.cc:143 Integrity check failed` before any window opens. `plutil` can't handle the `/` inside the key `"Resources/app.asar"` (its `.`-separated key path has no escape), so the update uses `/usr/libexec/PlistBuddy`'s `:`-separated syntax instead.
5. **Write** the per-mirror plist itself: `plutil -create xml1` + `plutil -insert disableAutoUpdates -bool true`. `plutil` because it produces a validated binary/XML plist Electron's native reader will accept; a hand-rolled string would silently fail the managed-tier read.

The order in `lib/build-clone-app.sh` is load-bearing: `ditto` copies the primary bundle → `Info.plist` bundle-id/display-name rewrite → wrapper script → asar patch → codesign. The patch happens BEFORE codesign so the asar+plist mutations invalidate exactly one signature (the original Anthropic one, which we discard anyway) and the single `codesign --force --deep --sign -` at the end re-signs the whole clone in one pass.

The patch is idempotent. `lib/asar-patch-clone.sh` detects the "already patched" state (the marker string `claude-multiacct-mirror-prefs.plist` present inside the anchor file) and skips the anchor rewrite — repeat `refresh-clones` runs against a Squirrel-updated primary produce bit-identical clones. Fail-loud invariants: an anchor count of anything but 1 in the pristine anchor file, a missing `ElectronAsarIntegrity.Resources/app.asar.hash` key, or an empty computed header hash each abort the patch with a message pointing at the specific file — Claude Desktop internal changes get surfaced rather than silently producing a clone that boots but never suppresses auto-poll.

`claude-multiacct doctor` checks three signals per mirror: (a) `claude-multiacct-mirror-prefs.plist` exists under `Contents/Resources/`, (b) it has `disableAutoUpdates=true`, (c) the marker string is byte-visible inside `Contents/Resources/app.asar` (the asar stores raw JS bodies concatenated after a JSON header, so `grep -F` on the archive suffices). Header-hash integrity is enforced at Electron boot — if the rewrite left the plist hash stale, the mirror fatal-exits before its window opens, which is a stronger signal than any doctor check we could run.

## Real-time session-state propagation

Session metadata (`local_<sessId>.json` under `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/`) is shared between primary and mirror via a per-account-folder symlink — a mutation on either side is IMMEDIATELY visible on disk under the other side's path. The mirror's UI reflects those mutations within seconds via an fs.watch installed by the asar-patch layer's session-propagation injection (Chunk X-B, 2026-07-18). No manual quit+relaunch cycle is required.

### The gap the injection closes

Claude Desktop's `LocalSessionManager` reads the sessions dir once at account-resolve time (the main.log line `Loaded N persisted sessions from <userData>/claude-code-sessions/…` marks the initial fill) and thereafter keeps every session in an in-memory `Map<sessionId, activeSessionRecord>` (defined in `index.chunk-BpZff9Dw.js` as `class G extends SessionAccountManager`). Its own mutations — `archiveSession`, `deleteSession`, `saveSession`, `updateSession` etc. — write to disk AND update the Map AND emit `event` records (`{type:"session_updated"|"archived"|"deleted", sessionId, ...}`) that every renderer subscription reacts to (sidebar included). Mutations from a peer Claude Desktop process (primary writing while mirror is up) only reach the disk half. The bundled JS registers no `fs.watch` / `chokidar` / `FSEvents` subscription on the sessions dir, so the mirror's in-memory Map (and by extension, its sidebar) stays frozen at the pre-mutation state until the mirror is quit and relaunched.

### The mechanism

`lib/asar-patch-clone.sh` injects a self-contained IIFE (`lib/asar-session-propagation.inject.js`) into `/.vite/build/index.chunk-BpZff9Dw.js` — the chunk that instantiates the singleton (`hs = new vt(o.CCD_SESSIONS_BASE_DIR)`) and re-exports it as `exports.claudeCodeSessionManager`. The injection point sits just above the sourceMappingURL comment. The IIFE closes lexically over `hs`, `E` (`node:fs`), `b` (`node:path`), `o` (which exports `LOCAL_SESSION_PREFIX`, `SESSION_FILE_MAX_BYTES`, `logger`) and `k` (which exports `persistedToActive` and `makeRemoteMcpServersIntern`) — all in scope where the IIFE runs.

Runtime flow:

0. **Main-process guard (H4).** The singleton chunk is evaluated in EVERY Electron process that imports it — the main (browser) process plus every renderer and utility process — but only the main process owns the real `LocalSessionManager` `hs` with a session store. The IIFE therefore bails immediately unless `process.type === "browser"`, and sets a `globalThis.__cma_session_propagation_installed` sentinel so a double-eval within one process installs at most one watcher + one timer. Both checks sit inside the outer try/catch (a missing `process`/`globalThis` can't throw). Without this guard, renderer/utility processes each spun up their own FSEvents watcher + 15 s poll against a session store they don't own — a watcher/timer leak (observed on a live machine as 11 concurrent "watching" installs across session-count=0 processes). The rc-enforcer IIFE carries the identical guard (`globalThis.__cma_rc_enforcer_installed`).
1. **Watcher install.** After the account is resolved (the manager's `initialized` event fires OR a boot-poll `setInterval` finds `getStorageDir()` returning non-null), the IIFE calls `E.realpathSync(hs.getStorageDir())` to normalise the mirror's Layer-2 symlink target and starts an `E.watch(realDir, {recursive:true}, ...)` — macOS resolves the `recursive:true` option via FSEvents which fires on writes made through EITHER path (proven separately in the fs.watch-through-symlink runtime harness that ships as a bats test).
2. **Own-write suppression.** Every write `hs` makes goes through `hs.saveSession(session)`, which the injection wraps to timestamp `session.sessionId` in a local `ownWrites` Map. A subsequent watcher fire that names the same sessionId within `CMA_OWN_WRITE_WINDOW_MS` (3 s) is treated as our own writeback and skipped — otherwise the debounced rescan would re-read our own writes and emit duplicate `session_updated` events for local edits.
3. **Debounce.** The watcher callback schedules a rescan via `setTimeout(..., CMA_DEBOUNCE_MS)` with a coalescing flag. macOS FSEvents batches file mutations into 300-800 ms windows; `CMA_DEBOUNCE_MS=500` collapses a burst (e.g. Claude Code writing 74 sessions during initial sync) into a single rescan pass.
4. **Rescan.** The scan iterates every `local_<sessId>.json` under the storage dir, `JSON.parse`s each, runs `k.persistedToActive(parsed, intern)` (the SAME transform `loadSessions` uses for the initial fill), and compares the resulting `activeSessionRecord` against the in-memory Map:
   - Not-in-map or field-different → write to Map + `hs.emitSessionUpdated(sessionId)` (which is a method the manager already defines: `emit("event", {type:"session_updated", sessionId, session: formatSessionForEvent(record)})`).
   - Field-identical → skip (cheap change detection on `lastActivityAt`, `isArchived`, `title`, `cwd`).
   - In-map but not on disk after the scan → delete from Map + `emit("event", {type:"deleted", sessionId})`. Sessions with `isRunning:true` are exempted (the user is actively driving them; their `saveSession` cycle races the scan and would otherwise flag a live session as deleted for the brief interval between temp-file deletion and rename). `deletingSessionIds` (owned by the manager) is also honoured so mid-flight teardowns don't double-emit deletions.
5. **Re-emit reaches the renderer.** Every renderer subscription that already listens on the singleton — the sidebar, the auto-fix engine (`index.chunk-n8uEXcf4.js`'s `handleSessionEvent`), the tool-permission dispatcher, the stealth-update guard — reacts to these events without any renderer-side patching. `session_updated` triggers `syncTitle` + sidebar re-render; `deleted` triggers evict-from-list. Both are the EXACT event shapes the manager already emits for its own mutations, so multi-process visibility rides the pre-existing single-process reactive plumbing.

### Failure modes

- No storage dir yet (user hasn't signed in): `installWatcher()` no-ops and the boot poll retries every 2 s. Once the metadata-symlink agent finishes wiring the Layer-2 symlink post-OAuth (§ launchd agents), the poll fires and the watcher installs.
- `fs.watch` throws (e.g. ENOSPC on the FSEvents descriptor): logged via `o.logger.warn` and the boot poll retries.
- `persistedToActive` throws on a corrupt JSON blob: the offending file is skipped for THIS scan; the next fs mutation retries.
- The whole IIFE throws before any watcher is installed: the outer try/catch surfaces via `console.error` (visible in main.log) and the mirror continues to run in stale-cache mode — the pre-Chunk-X-B behaviour, so no regression against the prior state.
- Claude Desktop restructures the singleton chunk in a future release: the injector's content-anchor check (`exports.claudeCodeSessionManager=hs;` must occur exactly once in the target file) fails loud at build-clone-app time, refusing to ship an un-patched mirror. Same fail-loud shape as the bXt() anchor.

### Idempotency + doctor

The injection is idempotent. `lib/asar-patch-clone.sh`'s `_asar_inject_session_propagation` detects the already-patched state (the marker `/* claude-multiacct-session-propagation v1 */` present inside the target chunk) and skips the rewrite — repeated `refresh-clones` runs against a Squirrel-updated primary produce bit-identical clones. `claude-multiacct doctor` reports the marker as a per-mirror signal alongside the bXt() and mirror-prefs plist checks: absence surfaces as `asar-patch-propagation-missing` in the issues list, which points the operator at `claude-multiacct repair <label>`.

### What still requires a quit+relaunch

- **Layer-4 (Chromium IndexedDB / Local Storage / Session Storage).** These are LevelDB stores. Each Claude Desktop process holds an EXCLUSIVE lock on its own LevelDB, so two processes cannot concurrently open the same store — that's why layer-4 rsync only fires on primary CLOSE. Sharing session-metadata dirs via SYMLINK works because those are plain-JSON files with no exclusive-lock semantic; sharing the derived LevelDB cache would deadlock. The session-metadata propagation described in this section is INDEPENDENT of the layer-4 sync and does not touch LevelDB.
- **Config-file mutations.** `<userData>/config.json` (OAuth cache) is watched by the metadata-symlink agent for OAuth-triggered symlink installation, not by the propagation IIFE. A first symlink install can optionally quit+relaunch the mirror so its React sidebar re-reads the metadata dir, but that auto-restart is OPT-IN (`CMA_AUTO_RESTART=1`, default off — see § "launchd agents" / C1) and sentinel-gated to fire at most once. By default the operator relaunches the mirror by hand after a first sign-in; the symlink install + sentinel still happen automatically on every fire.

## Remote-access toggle (undocumented in this repo)

The Chunk W task brief referenced auto-enabling a "remote access" toggle on each mirror. An exhaustive grep of the bundled JS (all `.vite/build/*.js` chunks in `/Applications/Claude.app/Contents/Resources/app.asar`) turned up no `RemoteAccess`, `remoteAccess`, or `remote_access` identifier, and no user-visible setting title matching those words. The closest candidates are all unrelated to a "let claude.ai control this Mac" toggle:

- `remoteControlAtStartup` / `remoteControlAvailable` — controls whether Claude Desktop connects OUT to a remote host it drives.
- `Load Remote Claude.ai` — a menu item that switches the desktop shell to a claude.ai-hosted view.
- `bridgeSessionUrl` / `bridge_*` — the session bridge that lets claude.ai (web) coordinate handoffs to Claude Desktop.
- `coworkTabEnabled` / `chatTabEnabled` / `isClaudeCodeForDesktopEnabled` — surface visibility toggles.
- Managed-config schema flat keys (grepped from `flatKey:"…"`): `disableAutoUpdates`, `coworkTabEnabled`, `chatTabEnabled`, `hardwareBuddyEnabled`, `isClaudeCodeForDesktopEnabled`, `isDesktopExtensionEnabled`, `disableEssentialTelemetry`, and 40+ others — none named for remote access.

Auto-enabling a toggle whose name isn't confirmed would risk flipping the wrong one (e.g. `disableAutoUpdates` OFF, which we JUST enabled). This piece is parked pending user confirmation of the exact toggle name and its UI location — Settings tab? Session menu? Account menu? The infrastructure to enforce a per-mirror boolean is in place (the asar-patch layer + per-mirror plist pattern) and can be extended once the target toggle is identified.

### Chunk X-A — `remoteControlAtStartup` auto-enable (2026-07-18)

The above parking is resolved: `remoteControlAtStartup` — schema-defined as `f.boolean().optional().describe("Start Remote Control bridge automatically each session")` in `index.chunk-DqiH2czz.js` — IS the correct toggle. The SettingsResolver's `j$n(e)` walks the tier list and returns `settings.remoteControlAtStartup` from either the User tier (`<configDir>/settings.json`) or the Managed tier (the per-mirror `Contents/Resources/claude-multiacct-mirror-prefs.plist`), rejecting only Project and ProjectLocal tiers (`M$n = new Set([Ei.Project, Ei.ProjectLocal])`). The Managed tier's macOS-path bypass (`Nht(r)` returns true on darwin) means the mirror-prefs plist is honoured directly.

We wire BOTH tiers, belt-and-braces:

- **User tier** — `lib/install-instance.sh` calls `cma_ensure_setting_bool "<configDir>/settings.json" remoteControlAtStartup true` on every install + repair. The helper merges into an existing settings.json (preserving every other key) and no-ops when the value is already correct. `bin/claude-multiacct cmd_repair` also runs the same helper on the primary's `~/.claude/settings.json`.
- **Managed tier** — `lib/asar-patch-clone.sh`'s `_asar_write_mirror_plist` inserts both `disableAutoUpdates=YES` and `remoteControlAtStartup=YES` into the per-mirror plist. **No JS anchor patch is needed for the new key**: the managed-tier reader `$Xt()` iterates every schema key (via `SXt() = [...IW.keys()]`, and `IW` is built from `Object.keys(hu.shape)` — every top-level key of the settings schema `Nl`), so a top-level `f.boolean()` field like `remoteControlAtStartup` appears in the read list unpatched. The Chunk W `bXt()` anchor patch is still required (it's what routes `readPlistValue` to our mirror-prefs plist in the first place); the new key just piggybacks on that plumbing.

`claude-multiacct doctor` reports both signals per mirror: the User-tier `remoteControlAtStartup` in `settings.json`, and the Managed-tier `remoteControlAtStartup` in the mirror-prefs plist. Both routes are independent; either alone is sufficient to auto-enable Remote Control at session startup.

## Remote Control runtime enforcement (Chunk Y — 2026-07-18)

Chunk X-A wires Remote Control ON at each session's CREATE event. That leaves a gap: if `remoteControlEnabled` on an already-live session drifts to false — the user hits `/remote-control` off, the deployment mode flaps and the bridge transiently declines, a session is loaded from disk in a pre-Chunk-X-A state — the flag stays drifted until the next quit + relaunch. The user constraint is stronger: Remote Control STAYS ENABLED ALWAYS FOR ALL NON-ARCHIVED SESSIONS ACROSS ALL CLAUDE APPS. Chunk Y closes that gap with a runtime enforcer that polls every 15 seconds and re-flips any non-archived session whose `remoteControlEnabled` is false.

### The IIFE

`lib/asar-patch-clone.sh` injects a second self-contained IIFE (`lib/asar-remote-control-enforcer.inject.js`) into `/.vite/build/index.chunk-BpZff9Dw.js` — the same chunk that hosts the propagation IIFE (§ "Real-time session-state propagation"). Both IIFEs land immediately above the `sourceMappingURL` comment; the injector's anchor invariants require `handleRemoteControlCommand` to occur at least once in the chunk (`_asar_inject_rc_enforcer` fails loud otherwise — a future Claude Desktop restructuring of the class gets surfaced rather than silently shipping a payload that never fires). The IIFE closes lexically over `hs` (the LocalSessionManager singleton) and `o.logger` (electron-log's shared logger writing to `~/Library/Logs/Claude/main.log`).

### Runtime loop

1. **Boot delay.** `CMA_INITIAL_DELAY_MS=5000` — the first pass fires 5 seconds after the IIFE runs. That lets the session-manager finish its `Loaded N persisted sessions from …` initial fill AND lets Chunk X-A's `maybeAutoEnableRemoteControl` fire on any auto-created session before the enforcer touches it, avoiding a redundant duplicate flip.
2. **Log line on arm.** `o.logger.info("[claude-multiacct-rc-enforcer] armed (poll_ms=15000)")` — visible in `~/Library/Logs/Claude/main.log`.
3. **Enumerate.** `Array.from(hs.sessions.values())` snapshots the map so a concurrent mutation during an await doesn't invalidate the iterator.
4. **Per-session logic.** For each session:
   - `isArchived === true` → skip (archived sessions are user-hidden; enforcing on them would spawn UI-invisible bridge sessions).
   - `remoteControlEnabled === true` → skip (already correct; clear failure count).
   - `!session.query` → info-log-once and skip. The session exists on disk but has no active Query — the enforcer cannot send a `subtype:"remote_control"` control-request without one. Chunk X-A's auto-enable path fires when the user sends the first message and creates the Query, so the enforcer waits.
   - Otherwise → `await hs.handleRemoteControlCommand(session, {auto:true})`. The `auto:true` flag suppresses every synthetic user/assistant/result message, so background enforcement produces no UI chrome. Post-await, re-read `session.remoteControlEnabled`:
     - `true` → success. Log `re-enabled <sessionId>`, clear failure count.
     - Still `false` → the internal try/catch in `handleRemoteControlCommand` swallowed a failure (bridge outage, revoked token, deployment mode denial) and reverted state. Increment failure count.
5. **Backoff.** After 3 consecutive failures for a given sessionId, the enforcer backs off polling that ID for 5 minutes. Logs `backoff <sessionId> for 5min (attempt 3)`. Protects `sessions.anthropic.com` from the enforcer hammering during a genuine service-side degradation.
6. **Repeat.** `setInterval(..., 15000)` polls indefinitely. `unref()` on the interval handle lets the process exit cleanly if nothing else is holding it open — the enforcer never keeps the main window alive.

### Log shape

Visible in `~/Library/Logs/Claude/main.log` under the `[claude-multiacct-rc-enforcer]` tag:

```
[info] [claude-multiacct-rc-enforcer] armed (poll_ms=15000)
[info] [claude-multiacct-rc-enforcer] re-enabled 019721a3-…
[info] [claude-multiacct-rc-enforcer] skip 019721a3-…: no active query
[warn] [claude-multiacct-rc-enforcer] no-op 019721a3-… (attempt 1)
[warn] [claude-multiacct-rc-enforcer] failed 019721a3-…: <err message>
[warn] [claude-multiacct-rc-enforcer] backoff 019721a3-… for 5min (attempt 3)
```

### Scope: mirror clones only

Remote-Control enforcement and session-propagation ship ONLY on the per-instance mirror clones (`lib/asar-patch-clone.sh`, invoked by `build-clone-app.sh`). The primary `/Applications/Claude.app` is deliberately NEVER patched — it stays stock, Apple-signed, and Squirrel-updatable. An earlier iteration patched the primary in place (ad-hoc re-sign + in-place asar rewrite behind a `primary-patch` subcommand); that broke the primary — freeze / blank content / dead auto-updates, because an ad-hoc signature fails Squirrel's validation — so the primary path was removed entirely. `install` and `repair` never touch the primary bundle. Sessions under the primary account rely on Claude Desktop's own Remote-Control behaviour; only the mirror sidebars get the propagation + enforcer IIFEs.

### Rule 12 disclosures (loud)

- **Backoff on server-side denial.** The enforcer backs off 5 minutes per session after 3 consecutive failures. During a `sessions.anthropic.com` outage, all active sessions get their 3-strike window then quiesce for 5 minutes before retrying — the outage is not amplified.

### Doctor coverage

`claude-multiacct doctor` reports mirror-patch + share state in two places:

- **Per-mirror asar-patch block.** Each mirror's report gains an `rc-enforcer marker NOT present` warning + `rc-enforcer-missing` issue slug when the injected marker is absent from the packed asar. `doctor` never inspects `/Applications/Claude.app` for patch state — the primary is not ours to patch.
- **Shared-account contention (C4).** After the per-mirror rows, `doctor` compares each mirror's `lastKnownAccountUuid` (from `<userData>/config.json`) with the primary's. An identical UUID means the mirror is signed into the SAME Anthropic account and resolves onto the primary's live `~/.claude` store; `doctor` emits a `CONTENTION: … LIVE:` warning and never changes the share set.

## Layered sync (see docs/sync-model.md for detail)

Four layers of state need to move between instances, each with different sharing semantics:

1. **Session JSONL content** — Claude Code writes the full conversation log to `~/.claude/projects/<projectdir>/<sessId>.jsonl`. Account-agnostic; symlink the mirror's `projects/` at the primary's `projects/`.

2. **Desktop UI session metadata** — the sidebar (title, `isArchived`, `lastActivityAt`, `cwd`, `model`, `completedTurns`) is one JSON file per session at `<userData>/claude-code-sessions/<accountUuid>/<orgUuid>/local_<sessId>.json`. The JSON body has NO `accountUuid` field, so both apps read the same file as "their own"; symlink `Claude-<label>/claude-code-sessions/<mirrorAcct>/<mirrorOrg>` at `Claude/claude-code-sessions/<primaryAcct>/<primaryOrg>`.

3. **Agent-mode subagent metadata** — same shape as (2) but only account-scoped: `<userData>/local-agent-mode-sessions/<accountUuid>/…`. Same per-account-folder symlink pattern.

4. **Chromium IndexedDB / Local Storage / Session Storage** — LevelDB stores. Exclusive-locked, cannot be symlinked between concurrent processes. `launchd` `WatchPaths` on the primary's `Local State` fires when Chromium rewrites it (app-close). Then rsync one-way primary→mirrors.

Layer 5 (Cookies / Preferences / Network Persistent State / Crashpad) is per-instance always — sharing would break OAuth or corrupt window state.

## launchd agents

Three `launchd` `LaunchAgents` back the runtime behaviour.

**Exec path — libexec, not the checkout (H3).** A background launchd agent cannot exec a script that lives under a TCC-protected container (`~/Documents`, `~/Desktop`, `~/Downloads`) — launchd runs it with no TCC grant for that container, so the exec fails with `126` / "Operation not permitted" and the agent silently never runs. The repo checkout usually sits under `~/Documents`, so `install`/`repair` copy the agent scripts + their `lib/` deps into `~/.local/libexec/claude-multiacct/` (outside every TCC container; `CMA_LIBEXEC_DIR`) and render every plist's `ProgramArguments` to exec from there. The copy is idempotent (`diff -r` gates it, snapshot-before-replace) and self-contained — each copied script's `../lib/common.sh` source and the `clone-refresh` re-invocation of `claude-multiacct` all resolve WITHIN libexec. `uninstall` reclaims the copy, but only once no installed plist still references it.

The three agents:

1. **`com.user.claude-sessions-sync`** — `WatchPaths` on the primary's `<userData>/Local State`. Chromium rewrites this file on app-close, which fires the agent; it then rsyncs layer-4 stores (IndexedDB / Local Storage / Session Storage) primary → every mirror. Refuses to run if any Claude Desktop process is still up.

2. **`com.user.claude-clone-refresh`** — `WatchPaths` on `/Applications/Claude.app/Contents/Info.plist`. Squirrel writes to this file at update-end; on mtime change the agent invokes `bin/claude-clone-refresh.sh` which rebuilds every mirror's clone. A `/tmp/claude-multiacct-refresh.lock` flock (or mkdir fallback) self-serializes overlapping fires so two ditto passes never race over the same clone bundle.

3. **`com.user.claude-metadata-symlink`** — `WatchPaths` on every configured mirror's `<userData>/claude-code-sessions/`, `<userData>/local-agent-mode-sessions/`, AND `<userData>/config.json`. The two dirs are pre-created empty at `add-instance` time so the WatchPaths trigger is armed on paths that already exist; the file path only exists once the mirror has been launched at least once. The moment Claude Desktop writes to any of the three, the agent fires; `bin/claude-metadata-watcher.sh` then iterates every mirror and invokes `lib/metadata-symlinks.sh` on it, installing the layer-2 and layer-3 per-account-folder symlinks. UUID resolution is two-tier: `find -L` on the mirror's `<acct>/<org>` (works post-Code-first-use, when Desktop has created the per-account UUID subdir), and a parse of `<userData>/config.json` (works post-OAuth-signin, when Desktop has cached the token but no Code area has been opened yet). The config.json parser reads `lastKnownAccountUuid` and picks the org UUID whose `dxt:allowlistLastUpdated:<orgUuid>` timestamp is newest — that's the currently-active org for accounts belonging to more than one. Already-installed symlinks no-op; mirrors where neither resolution path yields all four UUIDs skip cleanly and get retried on the next fire. ThrottleInterval=15 coalesces Desktop's setup-time write bursts. Skipped entirely (agent uninstalled) when zero mirrors are configured. On a first symlink install the watcher can quit+relaunch a running mirror so its React sidebar reloads with the symlinked content, but that is OPT-IN via the plist's `EnvironmentVariables → CMA_AUTO_RESTART` (default `0`/off, C1): the symlink install + the `<userData>/.claude-multiacct/symlinks-installed` sentinel are written on every fire, and only the disruptive TERM+relaunch of a live mirror is gated — because `config.json` fires this agent repeatedly during Desktop's sign-in write-burst, and auto-TERMing the user's live mirror on each of those fires is worse than a one-time manual relaunch. Install with `CMA_AUTO_RESTART=1 claude-multiacct repair` to bake the opt-in into the plist.

   On the first pass whose symlinks land on disk for a given mirror, the watcher also writes a sentinel at `<mirror_userData>/.claude-multiacct/symlinks-installed` and — if the mirror process is currently running — quits it via `pkill -TERM -f '--user-data-dir=<mirror_userData>'` (a pattern the primary's argv structurally can't match) and re-launches its `.app` bundle with `open`. Desktop's React sidebar loads the mirror's session dir on app-start and doesn't retroactively pick up symlinks that appear mid-run, so the auto-restart is what makes sessions appear within seconds of OAuth sign-in with no manual quit/relaunch step. Subsequent fires observe the sentinel and skip the restart branch. The graceful-shutdown wait caps at 5s and the watcher explicitly refuses to SIGKILL — Desktop is mid-writing SQLite / LevelDB and a KILL there risks corruption. `lib/uninstall-instance.sh` clears the sentinel dir even under `--keep-userdata` so a re-add + sign-in triggers a fresh auto-restart.

`claude-multiacct doctor` reports the loaded state of all three agents. `claude-multiacct repair` re-renders and re-installs all three plists.

## Config file of record

`~/.config/claude-multiacct/instances.yaml` lists every instance and any per-instance path overrides. Every runtime action (`add-instance`, `remove-instance`, `repair`, `sync-now`, `doctor`, `exec`) reads this file and never persists derived state elsewhere. Snapshot-before-write: any change to `instances.yaml` creates a backup under `~/.claude-multiacct-backups/<timestamp>-config/`.

## `exec` — running a command as a mirror instance

`claude-multiacct exec <label> [--] <cmd> [args…]` resolves `<label>` against
`instances.yaml` (dying loud if it isn't there), then `exec env`s the child with
two env vars set:

- `CLAUDE_CONFIG_DIR` — the mirror's `configDir` (`~/.claude-<label>` by default)
- `CHROMIUM_USER_DATA_DIR` — the mirror's `userData` (`~/Library/Application Support/Claude-<Title>` by default), for any nested Electron/Chromium tool that respects it

The child's stdin/stdout/stderr pass through unchanged and its exit code becomes ours (via `exec`, so this shell is replaced). With no command after `<label>`, prints the two `export` assignments and exits — a dry-run form suitable for `eval` or manual inspection.

Architecturally, `exec` is the terminal-side counterpart to the Dock-clone launcher: the same `CLAUDE_CONFIG_DIR` that the Dock clone injects via its `MacOS/Claude` shell wrapper (see "The Dock-clone layer" above) is exactly what `exec` `export`s to its child. Anthropic's standalone CLI, Claude Code SDK, and any other Electron/Chromium child that respects `CHROMIUM_USER_DATA_DIR` therefore boot into the mirror's identity — no separate mirror-aware code path in the child, just the env vars it already reads.

`exec` is a read-only wrapper: it never touches instances.yaml, launchd plists, or on-disk clone bundles. It's the intended way for scripts, editors, and one-off command-line invocations to target a specific mirror without shelling into the mirror's `.app`.
