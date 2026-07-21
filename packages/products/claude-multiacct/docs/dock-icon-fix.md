# The Dock icon fix

## Symptom

You click the "Claude Account B.app" icon in the Dock. Nothing highlights on B's Dock slot — instead, the PRIMARY Claude icon lights up and the primary's window gets focus. Your mirror instance is nowhere to be found in the Dock. If you run `pgrep -f 'Claude'` you can see the mirror process IS running (with the right `--user-data-dir` etc.) — macOS just refuses to give it a distinct Dock slot.

## Root cause: bundle-id grouping

macOS's Dock groups running processes by their `CFBundleIdentifier`. The Dock shows ONE icon per unique bundle-id; clicks on that icon activate any process (or fresh launch, if none is running) sharing that bundle-id.

The old shell-launcher approach:

- `~/Applications/Claude Account B.app` was a tiny .app whose `Contents/MacOS/launcher` was a shell script.
- The launcher did `exec open -na /Applications/Claude.app --env "CLAUDE_CONFIG_DIR=…" --args --user-data-dir="…"`.
- The spawned process was `/Applications/Claude.app/Contents/MacOS/Claude` — same binary AND same enclosing bundle as the primary.
- macOS asked "what bundle-id?" → read `/Applications/Claude.app/Contents/Info.plist` → got `com.anthropic.claudefordesktop`.
- Both the primary and every mirror had the same bundle-id → the Dock coalesced them into ONE slot (the primary's).

So the mirror ran, but you couldn't tell — its Dock icon was invisible because it was fused with the primary's icon.

## The fix: per-instance clone with rewritten bundle-id

To give the Dock a distinct icon per mirror, the mirror must be a bundle whose `Info.plist` declares its own `CFBundleIdentifier` AND whose executable, when the OS reads the enclosing bundle for identity, IS the mirror bundle (not `/Applications/Claude.app`).

`lib/build-clone-app.sh` builds each mirror as:

1. **Clone** `/Applications/Claude.app` (~745 MB) via `ditto` (preserves xattrs / resource forks / codesign structure) into `~/Applications/Claude Account <Title>.app`.
2. **Rewrite** the clone's `Contents/Info.plist`:
   - `CFBundleIdentifier` → `com.claude-multiacct.claude-account-<label>-desktop` (unique per mirror; the actual Dock-grouping fix)
   - `CFBundleDisplayName` → `Claude Account <Title>` (drives the Dock label + app switcher entry)
   - `CFBundleName` is DELIBERATELY LEFT AS "Claude". Chromium/Electron derives the helper .app folder name from `CFBundleName + " Helper"` (see `electron_main_delegate_mac.mm:66`). If we rewrite `CFBundleName` to "Claude Account <Title>", Electron looks for `Contents/Frameworks/Claude Account <Title> Helper.app` — which doesn't exist — and fatal-exits with "Unable to find helper app" before any window opens. Verified live 2026-07-13.
3. **Wrap** `Contents/MacOS/Claude`:
   - Move the real binary to `Contents/MacOS/Claude.real`.
   - Write a new `Contents/MacOS/Claude` shell script that exports `CLAUDE_CONFIG_DIR="<cdir>"` then `exec`s `Claude.real --user-data-dir=<udata> "$@"`.
   - The `exec` is load-bearing: it replaces the wrapper process image with `Claude.real` so the process macOS launched (and whose enclosing bundle it identified) IS the running Claude Desktop process. No `open` re-entrance into `/Applications/Claude.app`.
4. **Ad-hoc re-sign** the clone: `codesign --force --deep --sign - "$app"`. Required because mutating `Info.plist` breaks the original signature's plist hash and wrapping `MacOS/Claude` breaks the executable's code hash.
5. **Re-register** with LaunchServices: `lsregister -f`. Force-registers the new bundle-id → path mapping so the Dock doesn't cache a stale routing.
6. **xattr strip** on `com.apple.provenance`, best-effort (informational no-op on modern macOS — the attribute is now SIP-protected but Dock launch works regardless of its presence).

Because each mirror's clone has a distinct `CFBundleIdentifier` AND the running process reads its identity from that clone's bundle, the Dock now gives each mirror its own slot — with its own icon, its own click-to-activate behavior, and its own app-switcher entry.

## Disk cost

Each mirror is a full clone of Claude Desktop, so the cost per mirror is ~745 MB (currently, for Claude Desktop 1.20186.1). Two mirrors ≈ 1.5 GB under `~/Applications/`. Update the clone via `claude-multiacct refresh-clones` — the WatchPaths agent below already does this automatically on Squirrel autoupdate.

## Auto-refresh on Claude Desktop update

Claude Desktop's autoupdater (Squirrel) rewrites `/Applications/Claude.app` in place on every update. Without an auto-refresh, the mirror clones would stay pinned to the OLD Claude Desktop version until the user manually ran `claude-multiacct refresh-clones` — a silent drift trap.

`launchd/com.user.claude-clone-refresh.plist.tmpl` installs a WatchPaths agent that fires on `/Applications/Claude.app/Contents/Info.plist` mtime changes (Squirrel touches Info.plist at the end of every update). The agent invokes `bin/claude-clone-refresh.sh`, which calls `claude-multiacct refresh-clones`. The CLI subcommand rebuilds every mirror clone from the new primary bundle, preserving the per-instance bundle-id, wrapper script, and codesign.

The refresh subcommand refuses to run while any mirror clone is currently running — a live process holds file locks that `ditto` and `codesign` would fail on. Quit all mirrors first, then re-run (or wait for the next Squirrel update to re-trigger).

The refresh is deliberately NOT gated on the primary Claude Desktop being closed: Squirrel restarts the primary as part of applying an update, and blocking on it would defeat the entire point of the WatchPaths trigger.

## Verifying the fix

`claude-multiacct doctor` runs these checks per instance:

| Check                     | Command                                                                                                                                | Failure mode reported |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Codesign valid            | `codesign -v "<app>"`                                                                                                                  | `codesign-broken`     |
| Bundle-id parity          | `plutil -extract CFBundleIdentifier raw "<app>/Contents/Info.plist"` compared to `com.claude-multiacct.claude-account-<label>-desktop` | `bundle-id-drift`     |
| Claude version parity     | `plutil -extract CFBundleShortVersionString raw` on clone vs primary                                                                   | `version-drift`       |
| LaunchServices registered | `lsregister -dump \| grep -F "<app>"`                                                                                                  | `ls-not-registered`   |

A `bundle-id-drift` here means the clone was built by an OLD version of this repo (before the fix) or the plist got manually mutated. `version-drift` means the WatchPaths agent hasn't caught up to a recent Squirrel update. Both are fixed by:

```sh
claude-multiacct refresh-clones
```

Or, per-instance:

```sh
claude-multiacct repair <label>
```

## Confirming with a running mirror

After the fix, this is the load-bearing check that the Dock grouping is now correct:

```sh
# Launch the mirror.
open -gna "$HOME/Applications/Claude Account B.app"
sleep 5

# Find the mirror's main process.
MIRROR_PID="$(pgrep -f 'Claude Account B.app/Contents/MacOS/Claude' | head -1)"

# lsappinfo reports the bundle-id macOS assigned to that PID.
lsappinfo info -only bundleID "$MIRROR_PID"
#   → "CFBundleIdentifier"="com.claude-multiacct.claude-account-b-desktop"
```

If the bundle-id reported by `lsappinfo` matches the clone's rewritten value (`com.claude-multiacct.claude-account-<label>-desktop`), the fix is working. If it reports `com.anthropic.claudefordesktop`, something is wrong — the clone bundle didn't take effect. Re-run `claude-multiacct repair <label>` and re-check.

## Manual diagnosis when repair doesn't stick

If `claude-multiacct repair <label>` reports success but the Dock still coalesces the mirror with the primary:

```sh
# 1. Full xattr dump on the bundle.
xattr -lr ~/Applications/Claude\ Account\ B.app

# 2. Deep codesign detail — look for CodeDirectory version + team identifier.
codesign -dvvv ~/Applications/Claude\ Account\ B.app

# 3. LaunchServices dump for the bundle-ID.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -A5 "com.claude-multiacct.claude-account-b-desktop"

# 4. Try open via bundle-ID explicitly (the same path Dock uses internally).
open -b com.claude-multiacct.claude-account-b-desktop
# If this fails but `open <app path>` succeeds, the LaunchServices registration is broken.

# 5. Nuclear option: force LaunchServices to rescan every bundle on disk.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain system -domain user
killall Dock
```

If step 4 works but Dock still fails, the Dock has cached an old routing. `killall Dock` clears it (no user data loss — the Dock just rebuilds from LaunchServices state).

If step 4 fails with a codesign / provenance error, capture the exact error message and open an issue — that's a new failure mode we haven't seen yet.
