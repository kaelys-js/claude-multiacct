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

Metadata symlinks aren't in place. Check via:
```sh
ls -la "~/Library/Application Support/Claude-<Titlecase>/claude-code-sessions/"
```

If you see a UUID dir but no symlink inside pointing at the primary's UUID dir, the mirror wasn't logged in when we installed. Log in via the mirror once, quit, then:
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
Then launch that instance and sign in once. Then:
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

# Remove the launchd agent.
launchctl bootout "gui/$(id -u)/com.user.claude-sessions-sync" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.user.claude-sessions-sync.plist

# Remove config.
rm -rf ~/.config/claude-multiacct

# From-scratch re-install:
claude-multiacct init
claude-multiacct add-instance b --email you@example.com
# … log in, then …
claude-multiacct repair b
```
