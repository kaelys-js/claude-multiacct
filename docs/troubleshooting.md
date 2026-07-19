# Troubleshooting

Symptom → diagnosis → fix. Run `claude-multiacct doctor` first — it walks every layer and reports what's degraded before you dig manually.

## Primary Claude is patched — UPDATE-SAFELY

This tool patches `/Applications/Claude.app` in place (via `install`, `repair`, or `claude-multiacct primary-patch`) so the session-propagation + Remote-Control-enforcer IIFEs run on the primary account's sessions too. The patch is **update-safe**: after mutating the asar the bundle is re-signed **inside-out, ad-hoc, with an explicit LOOSE Designated Requirement** —

```text
designated => anchor apple generic and identifier "com.anthropic.claudefordesktop"
```

— which has **no team-id pin and no cdhash pin**. An Anthropic-signed Squirrel update satisfies that DR (`codesign --verify -R` returns 0 against the download), so Squirrel keeps validating and applying updates while the app stays patched. The `com.user.claude-primary-patch-refresh` launchd agent re-applies the patch after each Squirrel drop.

This is deliberately NOT the old broken behaviour: an earlier iteration re-signed the primary ad-hoc with `codesign --deep` and no explicit requirement, which pinned the DR to a per-build cdhash. Anthropic's next update no longer satisfied that DR, so Squirrel refused to apply it and the primary froze. The fix is the loose DR + inside-out signing (never `--deep`).

- **Restore the stock bundle:** `claude-multiacct primary-unpatch` restores both `app.asar` and `app.asar.unpacked` from the multiacct backups (the native `.node` modules are never lost) and removes the managed-config plist. Anthropic's original Developer ID signature returns on the next Squirrel drop or a manual reinstall.
- **Verify update-capability:** `claude-multiacct doctor` reports whether the primary presents the loose DR and is update-capable.
- If the primary freezes / blanks / stops updating, run `claude-multiacct doctor`; if the DR line is not the loose one, re-run `claude-multiacct primary-patch`, or `primary-unpatch` and reinstall Claude Desktop for a clean pristine bundle.

## Dock icon click does nothing (no window, no error)

Gatekeeper silently rejected the ad-hoc bundle. See [dock-icon-fix.md](dock-icon-fix.md).

Quick fix:
```sh
claude-multiacct repair <label>   # re-runs codesign + xattr + lsregister
killall Dock                      # if Dock cached the old routing
```

## Sidebar in the mirror shows no sessions

Metadata symlinks aren't in place. In the normal happy path, the `com.user.claude-metadata-symlink` launchd agent installs these automatically the moment OAuth sign-in completes — it watches the mirror's `<userData>/config.json` (which Desktop writes on token cache) and derives the required UUIDs from `lastKnownAccountUuid` + the newest `dxt:allowlistLastUpdated:<orgUuid>` timestamp. The symlink install + a per-mirror sentinel at `<userData>/.claude-multiacct/symlinks-installed` are written on every fire; sessions land on disk within seconds of sign-in with no "open Code inside Desktop first" step. Check via:
```sh
ls -la "~/Library/Application Support/Claude-<Titlecase>/claude-code-sessions/"
```

**Refreshing the sidebar.** Desktop's React sidebar reads the mirror's session dir on app-start and does NOT retroactively pick up symlinks that appeared mid-run, so after a first sign-in you quit and relaunch the mirror by hand (Cmd-Q, then click the mirror's Dock icon) to see the sessions. The watcher *can* do this quit+relaunch for you, but it is **opt-in** (`CMA_AUTO_RESTART=1`) and **off by default** — because `config.json` fires the watcher repeatedly during Desktop's sign-in write-burst, and auto-TERMing a live mirror on each of those fires is more disruptive than the one-time manual relaunch. To enable the hands-off restart, install with the env baked into the plist:
```sh
CMA_AUTO_RESTART=1 claude-multiacct repair   # re-renders the metadata-symlink plist with CMA_AUTO_RESTART=1
```

If you don't see a UUID dir at all, or see one but no symlink inside pointing at the primary's UUID dir, the agent either wasn't loaded or hasn't fired yet. Confirm the agent is loaded:
```sh
claude-multiacct doctor          # reports all three launchd agents' state
tail ~/Library/Logs/claude-multiacct/metadata-watcher.log
```
The log records whether UUIDs were resolved on-disk (post-Code-use) or derived from `config.json` (post-OAuth pre-Code-use); a line ending `(uuids derived from config.json)` confirms the derivation path fired. When `CMA_AUTO_RESTART` is off (the default) a first install logs `CMA_AUTO_RESTART!=1 — sentinel written, skipping auto quit+relaunch`; when it is on, lines `auto-restarting mirror` / `relaunched` / `mirror not running` / `sentinel present` narrate the restart branch.

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

## A launchd agent logs "Operation not permitted" (exit 126) and never runs

Background launchd agents can't exec a script from a TCC-protected container (`~/Documents`, `~/Desktop`, `~/Downloads`) — launchd runs them with no TCC grant for that container, so the exec fails with `126` / `Operation not permitted`. The repo checkout usually lives under `~/Documents`, so the agents do NOT exec from the checkout: `install`/`repair` copy the three agent scripts + their `lib/` deps into `~/.local/libexec/claude-multiacct/` (outside every TCC container) and point every plist's `ProgramArguments` there. If you see 126 in an agent's log, the plist is pointing at the checkout instead of libexec — re-render it:
```sh
claude-multiacct repair            # syncs libexec + re-renders every plist to exec from it
grep -A2 ProgramArguments ~/Library/LaunchAgents/com.user.claude-*.plist   # should show ~/.local/libexec/…
```
The libexec copy is reclaimed on `uninstall`, but only once no installed plist still references it.

## doctor warns "CONTENTION: mirror … resolves to the SAME account UUID as primary"

The mirror is signed into the SAME Anthropic account as the primary (identical `lastKnownAccountUuid`). Because the metadata symlinks resolve the mirror's account/org folder onto the primary's, the two share ONE live `~/.claude` session store and will contend over it. `doctor` only warns — it never changes the share set. Fix by signing that mirror into a DIFFERENT account (that's the whole point of a mirror), or, if the shared-account setup is intentional, ignore the warning.

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
