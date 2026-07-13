#!/usr/bin/env bats
# sync-worker.bats — hermetic coverage for bin/claude-sessions-sync.sh.
#
# Why this file exists: the sync worker is the highest-risk untested surface.
# It one-way rsyncs Chromium state (IndexedDB / Local Storage / Session Storage)
# primary → mirrors. A silent bug there produces divergent conversation state
# across accounts, so we pin its contract with intent-carrying tests:
#
#   (a) fresh IDB / LS / SS data reaches the mirror byte-for-byte
#   (b) sync is REFUSED whenever any Claude Desktop process is running
#       (rsyncing mid-flight LevelDB writes corrupts the mirror)
#   (c) the do-NOT-sync list (Cookies, Preferences, Network Persistent State,
#       Crashpad) is never copied — Cookies hold per-account OAuth, Preferences
#       hold window state, so sync would break auth or corrupt the mirror UI
#   (d) with zero mirrors configured, the worker exits 0 without touching disk
#   (e) empty primary source dirs are handled without crash — rsync of empty
#       trees is a legitimate first-run state
#
# Hermetic: each test runs under a scratch $HOME; `pgrep` and `sleep` are
# replaced by stubs on PATH so tests neither pick up the real host's running
# Claude nor incur the sync worker's 5-second Chromium-flush wait.

bats_require_minimum_version 1.5.0

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export REPO
  export CMA="$REPO/bin/claude-multiacct"
  export SYNC="$REPO/bin/claude-sessions-sync.sh"

  # Scratch $HOME — same layout smoke.bats uses so init/add-instance work.
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME/.config"
  mkdir -p "$HOME/.local/bin"
  mkdir -p "$HOME/Applications"
  mkdir -p "$HOME/Library/Application Support/Claude/claude-code-sessions/aaaa-bbbb-cccc/dddd-eeee-ffff"
  mkdir -p "$HOME/Library/Application Support/Claude/local-agent-mode-sessions/aaaa-bbbb-cccc"
  mkdir -p "$HOME/.claude"
  printf '%s' '{"oauthAccount":{"emailAddress":"primary@example.com"},"userID":"xxx","mcpServers":{}}' \
    > "$HOME/.claude/.claude.json"

  export XDG_CONFIG_HOME="$HOME/.config"
  export CMA_BACKUP_DIR="$HOME/.claude-multiacct-backups"
  export CMA_LOG_DIR="$HOME/Library/Logs/claude-multiacct"
  export CMA_SKIP_LAUNCHD=1

  # PATH stubs. Default posture: pgrep reports NO matching Claude process
  # (exit 1) so the worker proceeds; sleep is a no-op so the intentional
  # 5s Chromium-flush wait doesn't accumulate across the suite. Individual
  # tests override pgrep by rewriting the file in-place.
  export STUB_DIR="$BATS_TEST_TMPDIR/stubs"
  mkdir -p "$STUB_DIR"
  cat >"$STUB_DIR/pgrep" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  cat >"$STUB_DIR/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "$STUB_DIR/pgrep" "$STUB_DIR/sleep"
  export PATH="$STUB_DIR:$PATH"
}

# Helpers — the primary + default mirror-b paths are hard-coded to match the
# same defaults common.sh computes (see cma_default_userdata).
primary_udata() { printf '%s' "$HOME/Library/Application Support/Claude"; }
mirror_udata()  { printf '%s' "$HOME/Library/Application Support/Claude-B"; }

seed_primary_sync_dirs() {
  local p; p="$(primary_udata)"
  mkdir -p "$p/IndexedDB/foo" "$p/Local Storage/leveldb" "$p/Session Storage"
  printf 'idb-payload' > "$p/IndexedDB/foo/000001.log"
  printf 'ls-payload'  > "$p/Local Storage/leveldb/000002.log"
  printf 'ss-payload'  > "$p/Session Storage/000003.log"
}

seed_primary_no_sync_dirs() {
  local p; p="$(primary_udata)"
  mkdir -p "$p/Cookies" "$p/Crashpad"
  printf 'cookie-payload'   > "$p/Cookies/Cookies"
  printf 'pref-payload'     > "$p/Preferences"
  printf 'nps-payload'      > "$p/Network Persistent State"
  printf 'crashpad-payload' > "$p/Crashpad/settings.dat"
}

# ── Tests ───────────────────────────────────────────────────────────────────

@test "copies fresh IDB / LS / SS primary → mirror byte-for-byte" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  seed_primary_sync_dirs

  run "$SYNC"
  [ "$status" -eq 0 ]

  local m; m="$(mirror_udata)"
  [ -f "$m/IndexedDB/foo/000001.log" ]
  [ -f "$m/Local Storage/leveldb/000002.log" ]
  [ -f "$m/Session Storage/000003.log" ]
  # Content must match exactly — a partial or corrupt copy is the silent-drift
  # failure mode this test is guarding against.
  [ "$(cat "$m/IndexedDB/foo/000001.log")" = "idb-payload" ]
  [ "$(cat "$m/Local Storage/leveldb/000002.log")" = "ls-payload" ]
  [ "$(cat "$m/Session Storage/000003.log")" = "ss-payload" ]
}

@test "refuses to run when any Claude Desktop process is detected" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  seed_primary_sync_dirs

  # Rewrite the pgrep stub to report a running Claude (exit 0). The worker
  # must exit 0 (skip is expected, not an error) without touching mirrors.
  cat >"$STUB_DIR/pgrep" <<'SH'
#!/usr/bin/env bash
exit 0
SH

  run "$SYNC"
  [ "$status" -eq 0 ]

  # Mirror was NOT written to — the guard's whole point is preventing
  # mid-flight LevelDB corruption.
  local m; m="$(mirror_udata)"
  [ ! -e "$m/IndexedDB/foo/000001.log" ]
  [ ! -e "$m/Local Storage/leveldb/000002.log" ]
  [ ! -e "$m/Session Storage/000003.log" ]

  # And the skip surfaced loudly in the log (operator-visible).
  grep -q "SKIP: at least one Claude Desktop instance is running" \
    "$CMA_LOG_DIR/sessions-sync.log"
}

@test "never copies Cookies / Preferences / Network Persistent State / Crashpad" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  seed_primary_sync_dirs
  seed_primary_no_sync_dirs

  run "$SYNC"
  [ "$status" -eq 0 ]

  local m; m="$(mirror_udata)"
  # Sync targets DID land.
  [ -f "$m/IndexedDB/foo/000001.log" ]
  [ -f "$m/Local Storage/leveldb/000002.log" ]
  [ -f "$m/Session Storage/000003.log" ]
  # Do-not-sync paths did NOT land — copying them would break OAuth
  # (Cookies), corrupt window state (Preferences), or leak the primary's
  # network fingerprint (Network Persistent State).
  [ ! -e "$m/Cookies" ]
  [ ! -e "$m/Preferences" ]
  [ ! -e "$m/Network Persistent State" ]
  [ ! -e "$m/Crashpad" ]
}

@test "no-op when zero mirrors configured" {
  "$CMA" init
  seed_primary_sync_dirs

  # No add-instance ran, so the default mirror-B path must not exist.
  local m; m="$(mirror_udata)"
  [ ! -d "$m" ]

  run "$SYNC"
  [ "$status" -eq 0 ]

  # Still nothing there afterward — worker must not conjure a mirror dir.
  [ ! -d "$m" ]
}

@test "empty primary IDB / LS / SS dirs sync without crash" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  # Source dirs exist but hold no files — legitimate first-run shape.
  local p; p="$(primary_udata)"
  mkdir -p "$p/IndexedDB" "$p/Local Storage" "$p/Session Storage"

  run "$SYNC"
  [ "$status" -eq 0 ]

  local m; m="$(mirror_udata)"
  # rsync of empty source into a fresh dest produces empty dest dirs.
  [ -d "$m/IndexedDB" ]
  [ -d "$m/Local Storage" ]
  [ -d "$m/Session Storage" ]
}
