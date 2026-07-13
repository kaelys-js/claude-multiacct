# Troubleshooting

Symptom → diagnosis → fix. Run `claude-multiacct doctor` first — it walks every layer and reports what's degraded before you dig manually.

## Dock icon click does nothing (no window, no error)

Gatekeeper silently rejected the ad-hoc bundle. See [dock-icon-fix.md](dock-icon-fix.md).

Quick fix:
```sh
claude-multiacct repair <label>   # re-runs codesign + xattr + lsregister
killall Dock                      # if Dock cached the old routing
```

## Sidebar in the mirror shows no sessions

Metadata symlinks aren't in place. In the normal happy path, the `com.user.claude-metadata-symlink` launchd agent installs these automatically the moment OAuth sign-in completes — it watches the mirror's `<userData>/config.json` (which Desktop writes on token cache) and derives the required UUIDs from `lastKnownAccountUuid` + the newest `dxt:allowlistLastUpdated:<orgUuid>` timestamp. Sessions should appear within seconds of sign-in, with no "open Code inside Desktop first" step required. Check via:
```sh
ls -la "~/Library/Application Support/Claude-<Titlecase>/claude-code-sessions/"
```

If the symlink IS in place but the sidebar is still empty, Claude Desktop's React sidebar may have cached the pre-symlink state. Quit and relaunch the mirror (Cmd-Q, then click the mirror's Dock icon) to force it to re-read the metadata dir.

If you don't see a UUID dir at all, or see one but no symlink inside pointing at the primary's UUID dir, the agent either wasn't loaded or hasn't fired yet. Confirm the agent is loaded:
```sh
claude-multiacct doctor          # reports all three launchd agents' state
tail ~/Library/Logs/claude-multiacct/metadata-watcher.log
```
The log records whether UUIDs were resolved on-disk (post-Code-use) or derived from `config.json` (post-OAuth pre-Code-use); a line ending `(uuids derived from config.json)` confirms the derivation path fired.

Manual fallback (also fixes the edge cases where the agent hasn't been loaded — e.g. immediately after a macOS update that clears LaunchAgents):
```sh
claude-multiacct repair <label>
```

## Sync log shows "SKIP: at least one Claude Desktop instance is running"

Expected. The rsync is unsafe while any Claude Desktop is running. Quit ALL Claude Desktop instances and either wait for the next WatchPaths trigger or run:
```sh
claude-multiacct sync-now
```

## `launchctl bootstrap` fails with "Load failed: 5: input/output error"

The plist has a syntax error. Validate:
```sh
plutil -lint ~/Library/LaunchAgents/com.user.claude-sessions-sync.plist
```
Fix the offending key/value and re-run:
```sh
claude-multiacct repair   # re-renders + re-installs the plist
```

## Mirror instance's `.claude.json` carries the primary's identity

The install pass ran but did not strip the OAuth fields (older versions had this bug). Delete `~/.claude-<label>/.claude.json` and re-run:
```sh
claude-multiacct repair <label>
```
The install pass will regenerate a stripped `.claude.json` if the file is absent.

## IndexedDB drift — my mirror's web-chat cache is stale

The auto-sync is one-way primary → mirrors, and only fires on primary close. If you never close the primary the mirrors never receive updates. Force a sync:
```sh
# Quit ALL Claude Desktop instances first, then:
claude-multiacct sync-now
```

## I want to add my third account

```sh
claude-multiacct add-instance <label> --email <email>
```
Then launch that instance and sign in once. The `com.user.claude-metadata-symlink` launchd agent will install the session-metadata symlinks the moment Desktop creates the per-account UUID subdir on sign-in — no further step required. Fallback if the agent didn't fire (rare):
```sh
claude-multiacct repair <label>   # finishes the metadata symlinks after first login
```

## I want to remove an instance

```sh
claude-multiacct remove-instance <label>
```
By default this removes the mirror's `configDir` and `userData`, along with the CLI launcher and the `.app` bundle. Every path is snapshotted into `~/.claude-multiacct-backups/<timestamp>/` before deletion so you can recover. The mirror's entry is also stripped from `instances.yaml`.

The `--keep-userdata` and `--keep-configdir` flags are opt-in preserves — pass either (or both) to keep that tree in place. Preserving `userData` keeps the account's OAuth cookies, which is what you want if you plan to reinstall the same account later.

```sh
claude-multiacct remove-instance <label> --keep-userdata               # keep OAuth cookies
claude-multiacct remove-instance <label> --keep-configdir              # keep ~/.claude-<label>
claude-multiacct remove-instance <label> --keep-userdata --keep-configdir
```

## Config drift — `instances.yaml` doesn't reflect on-disk state

You edited `instances.yaml` by hand and something's out of sync. Run:
```sh
claude-multiacct doctor         # tells you exactly what drifted
claude-multiacct repair         # re-runs installs for every instance
```

## Nothing's broken but I want to see what the sync is doing

Tail the log:
```sh
tail -F ~/Library/Logs/claude-multiacct/sessions-sync.log
```
Trigger a sync manually (or just close the primary):
```sh
claude-multiacct sync-now
```

## Complete reset

```sh
# Uninstall every instance, keeping userData for safety.
for label in $(yq -r '.instances[].label' ~/.config/claude-multiacct/instances.yaml); do
  claude-multiacct remove-instance "$label" --keep-userdata --keep-configdir
done

# Remove the launchd agents.
for agent in com.user.claude-sessions-sync com.user.claude-clone-refresh com.user.claude-metadata-symlink; do
  launchctl bootout "gui/$(id -u)/$agent" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$agent.plist"
done

# Remove config.
rm -rf ~/.config/claude-multiacct

# From-scratch re-install:
claude-multiacct init
claude-multiacct add-instance b --email you@example.com
# … log in, then …
claude-multiacct repair b
```
