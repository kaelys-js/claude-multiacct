#!/usr/bin/env bats
# metadata-watcher.bats — hermetic coverage for bin/claude-metadata-watcher.sh
# + the pre-created watch-target dirs in lib/install-instance.sh.
#
# WHY this file exists (Rule 9 — tests verify intent, not just behaviour):
#   The metadata-symlink watcher is the fix for the "sign-in → open Code →
#   quit → repair" UX debt. Every assertion here maps to a load-bearing piece
#   of that fix:
#
#     - add-instance pre-creates the two dirs launchd's WatchPaths agent arms
#       on. Without pre-creation, the launchd arm is against a not-yet-existing
#       path and Desktop's first mutation may miss the trigger on some macOS
#       versions.
#     - The watcher, invoked after a simulated sign-in, installs the
#       per-account-folder symlink from mirror<acct>/<org> → primary<acct>/<org>.
#       This is the whole point of the watcher; without it, the mirror's UI
#       sidebar shows no sessions until the user manually runs `repair`.
#     - A second watcher run is a no-op — idempotency is what makes the
#       throttled-burst launchd fires safe (Desktop can touch the dir many
#       times during account setup; each fire must be safe).
#     - Running the watcher on a mirror that hasn't signed in yet is a clean
#       skip, NOT an error. Every fire happens BEFORE sign-in has completed
#       (mkdir of the account UUID is what fires the trigger); if the first
#       fire happens before Desktop finishes writing the org UUID, the watcher
#       must exit 0 and wait for the next fire.
#     - Private dirs (Cookies, Preferences, …) MUST NOT be symlinked; the
#       watcher only touches the two known session dirs.
#
# Hermetic: each test runs under a scratch $HOME with CMA_SKIP_LAUNCHD=1 so
# the launchd install path is bypassed; the watcher itself doesn't touch
# launchd — it only manipulates on-disk symlinks — so it's directly testable.

bats_require_minimum_version 1.5.0

# UUIDs used across tests. Real UUIDs from Desktop are 36-char hex-dash, but
# any unique-per-role string works here — metadata-symlinks.sh only cares that
# the discovered UUID matches what's on disk.
PRIMARY_ACCT_UUID="aaaa-bbbb-cccc"
PRIMARY_ORG_UUID="dddd-eeee-ffff"
MIRROR_ACCT_UUID="1111-2222-3333"
MIRROR_ORG_UUID="4444-5555-6666"

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export REPO
  export CMA="$REPO/bin/claude-multiacct"
  export WATCHER="$REPO/bin/claude-metadata-watcher.sh"

  # Scratch $HOME — same layout smoke.bats + sync-worker.bats use.
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME/.config"
  mkdir -p "$HOME/.local/bin"
  mkdir -p "$HOME/Applications"
  export PRIMARY_UDATA="$HOME/Library/Application Support/Claude"
  # Primary's session dirs seeded with a real payload so the symlink has
  # something to point at (and we can round-trip a file lookup through it).
  mkdir -p "$PRIMARY_UDATA/claude-code-sessions/$PRIMARY_ACCT_UUID/$PRIMARY_ORG_UUID"
  mkdir -p "$PRIMARY_UDATA/local-agent-mode-sessions/$PRIMARY_ACCT_UUID"
  printf '{"sessionId":"canary"}' \
    > "$PRIMARY_UDATA/claude-code-sessions/$PRIMARY_ACCT_UUID/$PRIMARY_ORG_UUID/local_canary-sid.json"
  mkdir -p "$HOME/.claude"
  printf '%s' '{"oauthAccount":{"emailAddress":"primary@example.com"},"userID":"xxx","mcpServers":{}}' \
    > "$HOME/.claude/.claude.json"

  export XDG_CONFIG_HOME="$HOME/.config"
  export CMA_BACKUP_DIR="$HOME/.claude-multiacct-backups"
  export CMA_LOG_DIR="$HOME/Library/Logs/claude-multiacct"
  export CMA_SKIP_LAUNCHD=1

  # Fake Claude.app for build-clone-app.sh (the add-instance step calls it).
  export CMA_SOURCE_CLAUDE_APP="$BATS_TEST_TMPDIR/fake-claude.app"
  mkdir -p "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS"
  cat >"$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>        <string>com.fake.claude</string>
    <key>CFBundleExecutable</key>        <string>Claude</string>
    <key>CFBundleName</key>              <string>Claude</string>
    <key>CFBundleDisplayName</key>       <string>Claude</string>
    <key>CFBundleShortVersionString</key><string>0.0.1-fake</string>
    <key>CFBundleVersion</key>           <string>1</string>
    <key>CFBundlePackageType</key>       <string>APPL</string>
</dict>
</plist>
PLIST
  cat >"$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude" <<'BIN'
#!/usr/bin/env bash
echo "fake claude ran with args: $*"
BIN
  chmod +x "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude"

  # Shared mirror-B paths — match cma_default_userdata (Titlecase).
  export MIRROR_UDATA="$HOME/Library/Application Support/Claude-B"
}

# Helper: simulate Desktop's on-sign-in write. Desktop creates the account
# UUID subdir + the org UUID subdir under it + a local_<sessId>.json inside.
# We reproduce that shape verbatim so metadata-symlinks.sh finds it.
simulate_mirror_signin() {
  mkdir -p "$MIRROR_UDATA/claude-code-sessions/$MIRROR_ACCT_UUID/$MIRROR_ORG_UUID"
  printf '{"sessionId":"mirror-initial"}' \
    > "$MIRROR_UDATA/claude-code-sessions/$MIRROR_ACCT_UUID/$MIRROR_ORG_UUID/local_mirror-sid.json"
  # Agent-mode dir has just the account UUID (no org partition).
  mkdir -p "$MIRROR_UDATA/local-agent-mode-sessions/$MIRROR_ACCT_UUID"
}

# ── Tests ───────────────────────────────────────────────────────────────────

@test "add-instance pre-creates the two dirs launchd's WatchPaths agent arms on" {
  # Pre-creation is what makes the launchd trigger observable across Desktop
  # versions; without these dirs, WatchPaths would be armed on non-existent
  # paths and the mkdir-on-signin event may not fire the agent on every macOS.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  [ -d "$MIRROR_UDATA/claude-code-sessions" ]
  [ -d "$MIRROR_UDATA/local-agent-mode-sessions" ]
  # Pre-created dirs are EMPTY — Desktop populates them on first sign-in.
  # A stray file here would mean install-instance.sh corrupted the mirror's
  # future account UUID assignment.
  [ -z "$(ls -A "$MIRROR_UDATA/claude-code-sessions" 2>/dev/null)" ]
  [ -z "$(ls -A "$MIRROR_UDATA/local-agent-mode-sessions" 2>/dev/null)" ]
}

@test "watcher installs the account/org symlink after simulated sign-in" {
  # The load-bearing assertion: watcher → mirror<acct>/<org> becomes a symlink
  # pointing at primary<acct>/<org>. Without this, the sidebar shows no
  # sessions until the user runs `repair` (the UX debt this fix removes).
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com

  simulate_mirror_signin

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # The mirror's <acct>/<org> is now a SYMLINK, not a plain dir. Presence of
  # the primary's canary through that symlink proves the target resolves.
  local link="$MIRROR_UDATA/claude-code-sessions/$MIRROR_ACCT_UUID/$MIRROR_ORG_UUID"
  [ -L "$link" ]
  local target; target="$(readlink "$link")"
  [ "$target" = "$PRIMARY_UDATA/claude-code-sessions/$PRIMARY_ACCT_UUID/$PRIMARY_ORG_UUID" ]
  [ -f "$link/local_canary-sid.json" ]

  # Agent-mode symlink also installed (mirror<acct> → primary<acct>).
  local lams_link="$MIRROR_UDATA/local-agent-mode-sessions/$MIRROR_ACCT_UUID"
  [ -L "$lams_link" ]
  [ "$(readlink "$lams_link")" = "$PRIMARY_UDATA/local-agent-mode-sessions/$PRIMARY_ACCT_UUID" ]
}

@test "watcher is a safe no-op when re-run after symlinks are already installed" {
  # Idempotency: launchd's ThrottleInterval=15 coalesces bursts but doesn't
  # eliminate multiple fires. Every fire must be safe. If this test regresses,
  # a burst of fires during sign-in could churn the symlink → race with
  # Desktop's own file writes → data loss.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  simulate_mirror_signin
  "$WATCHER"

  # Snapshot the on-disk state.
  local link="$MIRROR_UDATA/claude-code-sessions/$MIRROR_ACCT_UUID/$MIRROR_ORG_UUID"
  local target_before; target_before="$(readlink "$link")"

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # Still a symlink, same target — no churn, no replacement.
  [ -L "$link" ]
  local target_after; target_after="$(readlink "$link")"
  [ "$target_before" = "$target_after" ]

  # Log records both runs (proves the watcher actually ran twice, not that
  # it short-circuited).
  local log_hits
  log_hits="$(grep -c '=== metadata-watcher end' "$CMA_LOG_DIR/metadata-watcher.log")"
  [ "$log_hits" -eq 2 ]
}

@test "watcher is a safe no-op before mirror sign-in (no account UUID yet)" {
  # Every launchd fire happens BEFORE sign-in has fully completed (the mkdir
  # of the mirror's account UUID subdir is what fires the WatchPaths trigger).
  # If the first fire runs while Desktop is still writing, the watcher must
  # exit 0 (not error) and let the next fire retry.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  # No simulate_mirror_signin — the pre-created empty dirs are the shape a
  # freshly-installed but not-yet-signed-in mirror is in.

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # No symlinks were installed — nothing to symlink yet. The pre-created dirs
  # remain empty dirs, NOT symlinks.
  [ ! -L "$MIRROR_UDATA/claude-code-sessions" ]
  [ ! -L "$MIRROR_UDATA/local-agent-mode-sessions" ]
  # The "not logged in yet" skip surfaced in the log — operators can tell
  # apart a mirror that fired the trigger from one that never did.
  grep -q "not logged in yet" "$CMA_LOG_DIR/metadata-watcher.log"
}

@test "watcher does NOT symlink Cookies / Preferences / Network Persistent State" {
  # The never-symlink list from the sync-worker contract also applies here.
  # Cookies hold per-account OAuth; Preferences hold per-instance window
  # state; a stray symlink to primary would break auth or corrupt UI.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  simulate_mirror_signin

  # Seed the private dirs on the mirror so the watcher has an opportunity to
  # (mistakenly) symlink them if it iterates userData/*.
  mkdir -p "$MIRROR_UDATA/Cookies" \
           "$MIRROR_UDATA/Crashpad"
  printf 'cookie'   > "$MIRROR_UDATA/Cookies/Cookies"
  printf 'pref'     > "$MIRROR_UDATA/Preferences"
  printf 'nps'      > "$MIRROR_UDATA/Network Persistent State"

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # Private dirs remain concrete (not symlinks).
  [ ! -L "$MIRROR_UDATA/Cookies" ]
  [ ! -L "$MIRROR_UDATA/Preferences" ]
  [ ! -L "$MIRROR_UDATA/Network Persistent State" ]
  [ ! -L "$MIRROR_UDATA/Crashpad" ]
  # And their content is unchanged — the watcher didn't move them aside.
  [ "$(cat "$MIRROR_UDATA/Cookies/Cookies")" = "cookie" ]
  [ "$(cat "$MIRROR_UDATA/Preferences")" = "pref" ]
}

@test "watcher exits 0 when no config file is present (skips cleanly)" {
  # The launchd plist may be reloaded even after `remove-instance` has stripped
  # the last mirror. The watcher must not error — a non-zero exit under launchd
  # would surface as a systemic failure.
  # No `init` and no `add-instance` — the config file simply isn't there.
  [ ! -f "$HOME/.config/claude-multiacct/instances.yaml" ]

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # A single log line documents the skip.
  grep -q "SKIP: no config file" "$CMA_LOG_DIR/metadata-watcher.log"
}

# ── config.json UUID derivation ─────────────────────────────────────────────
#
# WHY this block exists (Rule 9): OAuth sign-in on a mirror creates
# <userData>/config.json but NOT <userData>/claude-code-sessions/<acctUuid>/;
# the latter only appears on Code first-use inside Desktop. The user
# considers "you must click into Code once per mirror" unacceptable UX. These
# assertions cover the derivation path that lets us install the symlinks the
# moment OAuth sign-in completes, without any Code-area interaction.
#
# Real UUIDs from the machine that seeded this fix (kept concrete so the
# tests exercise the ACTUAL regex + newest-timestamp logic, not stub values):
#   Mirror b account : 918f32f7-44c2-442e-8d5d-48ca3792ea95
#   Mirror b org     : b3bf40ff-0e9b-4a5d-b1c1-c701f1eff98a
#   Primary account  : 87b5cd86-210b-4e03-bb0b-92ec8ba52a85
#   Primary org      : c5e0ad3e-823c-415e-8094-5cb12a817f06 (newer of two)
#   Primary org (old): b3bf40ff-0e9b-4a5d-b1c1-c701f1eff98a (older of two)

# Real-UUID constants for the derivation tests. Kept upper-scope so multiple
# tests below can share them without re-declaring inside each.
DERIV_MIRROR_ACCT="918f32f7-44c2-442e-8d5d-48ca3792ea95"
DERIV_MIRROR_ORG="b3bf40ff-0e9b-4a5d-b1c1-c701f1eff98a"
DERIV_PRIMARY_ACCT="87b5cd86-210b-4e03-bb0b-92ec8ba52a85"
DERIV_PRIMARY_ORG_NEW="c5e0ad3e-823c-415e-8094-5cb12a817f06"
DERIV_PRIMARY_ORG_OLD="b3bf40ff-0e9b-4a5d-b1c1-c701f1eff98a"

# Seed primary + mirror config.json with the shape Desktop writes on OAuth
# sign-in. Primary gets TWO dxt:allowlistLastUpdated:* keys so the "newer of
# two" logic is tested end-to-end. The primary's PATH-BACKED session dirs are
# also seeded here so the derived symlink target resolves — without a target
# path, `symlink_atomic` still creates the dangling symlink but downstream
# assertions on target content would fail.
#
# CRITICAL: this replaces setup()'s stub primary session dirs (which use the
# "aaaa-bbbb-cccc / dddd-eeee-ffff" filler UUIDs). If we left those in place,
# a subsequent find-based resolution on the primary side (after our first
# config-derived install created the mirror's <acct>/) could return the stub
# UUIDs instead of the ones the config.json refers to — the symlink target
# would then flip between runs and idempotency-checks would fail. Real
# machines never carry two account UUIDs simultaneously; the stub is a
# fixture artefact only, so remove it before seeding.
seed_derivation_fixtures() {
  rm -rf "$PRIMARY_UDATA/claude-code-sessions" "$PRIMARY_UDATA/local-agent-mode-sessions"

  # Primary config.json — two orgs, newer + older. Also install the primary's
  # on-disk session dirs so the derived symlink target resolves to a real path.
  cat >"$PRIMARY_UDATA/config.json" <<JSON
{
  "locale": "en-US",
  "lastKnownAccountUuid": "$DERIV_PRIMARY_ACCT",
  "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_OLD": "2026-06-23T03:16:31.912Z",
  "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_NEW": "2026-07-13T16:39:02.920Z",
  "dxt:allowlistEnabled:$DERIV_PRIMARY_ORG_NEW": false
}
JSON
  mkdir -p "$PRIMARY_UDATA/claude-code-sessions/$DERIV_PRIMARY_ACCT/$DERIV_PRIMARY_ORG_NEW"
  mkdir -p "$PRIMARY_UDATA/local-agent-mode-sessions/$DERIV_PRIMARY_ACCT"
  # Canary in the primary's newer-org dir — a resolved symlink can round-trip it.
  printf '{"sessionId":"primary-canary"}' \
    > "$PRIMARY_UDATA/claude-code-sessions/$DERIV_PRIMARY_ACCT/$DERIV_PRIMARY_ORG_NEW/local_primary-canary.json"

  # Mirror config.json — single-org (this is a fresh mirror sign-in). The
  # mirror's claude-code-sessions/<acct>/<org>/ dir is DELIBERATELY NOT
  # created — that's the whole test premise.
  cat >"$MIRROR_UDATA/config.json" <<JSON
{
  "locale": "en-US",
  "lastKnownAccountUuid": "$DERIV_MIRROR_ACCT",
  "dxt:allowlistLastUpdated:$DERIV_MIRROR_ORG": "2026-07-13T09:10:00.000Z",
  "dxt:allowlistEnabled:$DERIV_MIRROR_ORG": false
}
JSON
}

@test "watcher installs symlinks via config.json derivation when no <acct>/ dir exists yet" {
  # The load-bearing assertion for the whole "no manual Code-click" fix: the
  # mirror has only OAuth-signed-in — no Code area open — so the ONLY UUID
  # source is config.json. Watcher must still install the correct symlink
  # chain and pick the NEWER of primary's two org UUIDs.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  seed_derivation_fixtures

  # Pre-condition: the mirror's <acct>/ dir does NOT exist yet. If this
  # regresses (something starts pre-creating it) the derivation path
  # wouldn't be exercised and the test would trivially pass via find.
  [ ! -d "$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT" ]

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # Symlink installed at the DERIVED UUIDs.
  local ccs_link="$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT/$DERIV_MIRROR_ORG"
  [ -L "$ccs_link" ]
  # Target uses the NEWER-timestamp primary org (c5e0ad3e-…), NOT the older
  # (b3bf40ff-…). Regression here means the newest-timestamp picker broke.
  local target; target="$(readlink "$ccs_link")"
  [ "$target" = "$PRIMARY_UDATA/claude-code-sessions/$DERIV_PRIMARY_ACCT/$DERIV_PRIMARY_ORG_NEW" ]
  # Round-trip: primary's canary is reachable through the symlink.
  [ -f "$ccs_link/local_primary-canary.json" ]

  # Agent-mode symlink installed at account level too.
  local lams_link="$MIRROR_UDATA/local-agent-mode-sessions/$DERIV_MIRROR_ACCT"
  [ -L "$lams_link" ]
  [ "$(readlink "$lams_link")" = "$PRIMARY_UDATA/local-agent-mode-sessions/$DERIV_PRIMARY_ACCT" ]

  # Log records the "uuids derived from config.json" note — operators can
  # tell apart a find-based resolve from a derived one, useful when
  # triaging a mirror where sign-in completed but Code first-use hasn't yet.
  grep -q "uuids derived from config.json" "$CMA_LOG_DIR/metadata-watcher.log"
}

@test "config.json derivation is idempotent (second watcher run is a no-op)" {
  # ThrottleInterval=15 in the plist coalesces but does not eliminate multiple
  # fires during Desktop's setup writes to config.json. Every fire must be
  # safe. First fire installs via derivation; second fire finds the on-disk
  # symlink chain (via `find -L`) and observes "= already correct" — no churn.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  seed_derivation_fixtures
  "$WATCHER"

  local ccs_link="$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT/$DERIV_MIRROR_ORG"
  local target_before; target_before="$(readlink "$ccs_link")"

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # Same symlink, same target — no re-creation, no target flip.
  [ -L "$ccs_link" ]
  [ "$(readlink "$ccs_link")" = "$target_before" ]

  # Both runs went through — proves this is real idempotency, not a
  # short-circuit before we get to the symlink code.
  local end_hits
  end_hits="$(grep -c '=== metadata-watcher end' "$CMA_LOG_DIR/metadata-watcher.log")"
  [ "$end_hits" -eq 2 ]
}

@test "watcher falls back to retry-later when mirror config.json is missing" {
  # OAuth sign-in hasn't happened yet: config.json isn't written. Watcher
  # must exit 0 (a non-zero would inhibit further launchd fires) and
  # install nothing. The find path already fails, the config.json path
  # can't open the file, so the whole thing gracefully skips.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  # Seed only PRIMARY config.json, not mirror.
  cat >"$PRIMARY_UDATA/config.json" <<JSON
{"lastKnownAccountUuid": "$DERIV_PRIMARY_ACCT",
 "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_NEW": "2026-07-13T16:39:02.920Z"}
JSON
  # And NO mirror config.json — this is the "OAuth sign-in hasn't happened" state.
  [ ! -f "$MIRROR_UDATA/config.json" ]

  run "$WATCHER"
  [ "$status" -eq 0 ]

  # No symlink chain installed under the mirror.
  [ ! -d "$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT" ]
  # Retry-later message surfaced in the log so operators can tell.
  grep -q "not logged in yet" "$CMA_LOG_DIR/metadata-watcher.log"
}

@test "watcher falls back to retry-later when mirror config.json is malformed JSON" {
  # Half-written config.json during Desktop's initial write — a rare race
  # but possible. Watcher must exit 0 and skip (not error, not partial-install).
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  cat >"$PRIMARY_UDATA/config.json" <<JSON
{"lastKnownAccountUuid": "$DERIV_PRIMARY_ACCT",
 "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_NEW": "2026-07-13T16:39:02.920Z"}
JSON
  # Truncated JSON — closing brace missing.
  printf '{"lastKnownAccountUuid": "%s",' "$DERIV_MIRROR_ACCT" \
    > "$MIRROR_UDATA/config.json"

  run "$WATCHER"
  [ "$status" -eq 0 ]

  [ ! -d "$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT" ]
  grep -q "not logged in yet" "$CMA_LOG_DIR/metadata-watcher.log"
}

@test "watcher falls back to retry-later when config.json has no lastKnownAccountUuid" {
  # Desktop wrote SOMETHING to config.json (e.g. initial locale from first
  # app-open) but the user hasn't OAuth-signed-in yet, so
  # lastKnownAccountUuid is absent. Derivation must refuse; watcher must skip.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  cat >"$PRIMARY_UDATA/config.json" <<JSON
{"lastKnownAccountUuid": "$DERIV_PRIMARY_ACCT",
 "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_NEW": "2026-07-13T16:39:02.920Z"}
JSON
  # Mirror config.json exists but has NO lastKnownAccountUuid key — the
  # user hasn't OAuth-signed-in on this mirror yet.
  cat >"$MIRROR_UDATA/config.json" <<'JSON'
{"locale": "en-US", "userThemeMode": "system"}
JSON

  run "$WATCHER"
  [ "$status" -eq 0 ]

  [ ! -d "$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT" ]
  grep -q "not logged in yet" "$CMA_LOG_DIR/metadata-watcher.log"
}

@test "watcher falls back to retry-later when config.json has no dxt:allowlistLastUpdated key" {
  # OAuth partially completed — lastKnownAccountUuid is written but the
  # per-org allowlist entries haven't been synced yet (or Desktop's schema
  # shifts). Derivation must refuse the incomplete data rather than symlink
  # to an invalid org UUID.
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  cat >"$PRIMARY_UDATA/config.json" <<JSON
{"lastKnownAccountUuid": "$DERIV_PRIMARY_ACCT",
 "dxt:allowlistLastUpdated:$DERIV_PRIMARY_ORG_NEW": "2026-07-13T16:39:02.920Z"}
JSON
  cat >"$MIRROR_UDATA/config.json" <<JSON
{"lastKnownAccountUuid": "$DERIV_MIRROR_ACCT",
 "locale": "en-US"}
JSON

  run "$WATCHER"
  [ "$status" -eq 0 ]

  [ ! -d "$MIRROR_UDATA/claude-code-sessions/$DERIV_MIRROR_ACCT" ]
  grep -q "not logged in yet" "$CMA_LOG_DIR/metadata-watcher.log"
}
