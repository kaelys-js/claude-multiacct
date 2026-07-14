#!/usr/bin/env bats
# clone-app.bats — hermetic coverage of lib/build-clone-app.sh + the CLI's
# `refresh-clones` subcommand.
#
# WHY this file exists (Rule 9 — tests verify intent, not just behaviour):
#   The clone-bundle mechanism is the load-bearing fix for the Dock-icon bug
#   (docs/dock-icon-fix.md). Every assertion here maps to a piece of the fix
#   that MUST hold or the Dock grouping breaks:
#
#     - Info.plist bundle-id is rewritten to the per-instance value  → Dock
#       groups the mirror separately from the primary.
#     - Info.plist display-name is rewritten                         → Dock
#       label reads "Claude Account <Title>".
#     - Contents/MacOS/<exe>.real holds the ORIGINAL binary          → the
#       clone actually runs Claude Desktop (not a stub).
#     - Contents/MacOS/<exe> is a shell wrapper that exports         → the
#       CLAUDE_CONFIG_DIR and passes --user-data-dir                    mirror
#       instance uses its own identity, not the primary's.
#     - _CodeSignature/ exists                                       → the
#       ad-hoc codesign happened; without it, Gatekeeper's LaunchServices
#       path silently rejects the Dock click.
#     - Idempotency                                                  → a
#       WatchPaths-triggered refresh doesn't produce spurious drift.
#
# Hermetic: each test builds a fake /Applications/Claude.app under
# $BATS_TEST_TMPDIR and points CMA_SOURCE_CLAUDE_APP at it. The real
# /Applications/Claude.app is never touched.

bats_require_minimum_version 1.5.0

setup() {
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export REPO
  export CMA="$REPO/bin/claude-multiacct"
  export BUILD_CLONE="$REPO/lib/build-clone-app.sh"

  # Scratch $HOME with the minimum layout the CLI needs.
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
  export CMA_SKIP_AUTO_MIGRATE=1

  # Fake /Applications/Claude.app under the scratch dir. Includes a canary
  # payload in MacOS/Claude so we can prove the ditto copied the original
  # binary content (not something we generated post-hoc).
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
# FAKE-CLAUDE-CANARY-Z3K7 — this string proves the ditto copied the source
# binary rather than the wrapper regenerating something. If build-clone-app.sh
# ever accidentally overwrites MacOS/Claude.real, this canary disappears.
echo "fake claude ran with args: $*"
BIN
  chmod +x "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude"

  # Shorthand for the clone target and the label we build under.
  export LABEL="b"
  export TARGET_APP="$HOME/Applications/Claude Account B.app"
  export TARGET_BID="com.claude-multiacct.claude-account-b-desktop"
  export TARGET_CDIR="$HOME/.claude-b"
  export TARGET_UDATA="$HOME/Library/Application Support/Claude-B"
}

# ── Direct build-clone-app.sh tests ─────────────────────────────────────────
# These exercise the builder in isolation, bypassing the CLI, so a failure
# points at the builder rather than at plumbing above it.

@test "build-clone-app: creates clone dir at target path" {
  run "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ "$status" -eq 0 ]
  [ -d "$TARGET_APP" ]
  [ -d "$TARGET_APP/Contents" ]
  [ -d "$TARGET_APP/Contents/MacOS" ]
}

@test "build-clone-app: Info.plist has the per-instance bundle-id (Dock-grouping fix)" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  local actual
  actual="$(plutil -extract CFBundleIdentifier raw "$TARGET_APP/Contents/Info.plist")"
  # The load-bearing assertion: the CLONE's bundle-id must NOT be
  # com.anthropic.claudefordesktop (which would collide with the primary in
  # the Dock — the whole bug this repo fixes).
  [ "$actual" = "$TARGET_BID" ]
  [ "$actual" != "com.fake.claude" ]
}

@test "build-clone-app: Info.plist has the per-instance display name (Dock label fix)" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  local name display
  name="$(plutil -extract CFBundleName raw "$TARGET_APP/Contents/Info.plist")"
  display="$(plutil -extract CFBundleDisplayName raw "$TARGET_APP/Contents/Info.plist")"
  # CFBundleDisplayName drives the Dock label + app-switcher entry — must be the per-mirror value.
  [ "$display" = "Claude Account B" ]
  # CFBundleName MUST stay "Claude" (the source's original value). Chromium/Electron
  # derives the helper .app folder name from CFBundleName + " Helper" — rewriting it
  # to "Claude Account B" makes Electron look for a non-existent
  # "Contents/Frameworks/Claude Account B Helper.app" and fatal-exit with
  # "Unable to find helper app" (electron_main_delegate_mac.mm:66). Verified live 2026-07-13.
  [ "$name" = "Claude" ]
}

@test "build-clone-app: MacOS/Claude.real holds the ORIGINAL binary content" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ -f "$TARGET_APP/Contents/MacOS/Claude.real" ]
  # The canary from setup() must survive the clone. If build-clone-app.sh ever
  # accidentally overwrites Claude.real (e.g. by re-wrapping post-move), this
  # assertion fails.
  grep -q "FAKE-CLAUDE-CANARY-Z3K7" "$TARGET_APP/Contents/MacOS/Claude.real"
}

@test "build-clone-app: MacOS/Claude is a shell wrapper injecting the per-instance env" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ -f "$TARGET_APP/Contents/MacOS/Claude" ]
  # Shebang.
  head -1 "$TARGET_APP/Contents/MacOS/Claude" | grep -q '^#!/usr/bin/env bash'
  # Must set CLAUDE_CONFIG_DIR — otherwise the mirror boots into the primary's
  # config-dir and metadata symlinks resolve wrong. Load-bearing.
  grep -q 'CLAUDE_CONFIG_DIR' "$TARGET_APP/Contents/MacOS/Claude"
  grep -q "$TARGET_CDIR" "$TARGET_APP/Contents/MacOS/Claude"
  # Must pass --user-data-dir — otherwise the mirror shares Chromium state with
  # the primary and OAuth cookies collide.
  grep -q -- '--user-data-dir=' "$TARGET_APP/Contents/MacOS/Claude"
  grep -q "$TARGET_UDATA" "$TARGET_APP/Contents/MacOS/Claude"
  # Must exec Claude.real, not spawn a new shell. exec preserves the process
  # identity that macOS assigned via LaunchServices — the whole point of the
  # per-bundle-id clone.
  grep -q 'exec ' "$TARGET_APP/Contents/MacOS/Claude"
  grep -q 'Claude.real' "$TARGET_APP/Contents/MacOS/Claude"
  # Must use `exec -a "Claude"` to restore argv[0]. Without it, Electron's
  # helper-app lookup uses `Claude.real` as the basename and fatally exits
  # with "Unable to find helper app" (electron_main_delegate_mac.mm:66).
  # 2026-07-13 verified this fatal by omitting `-a` and direct-exec'ing.
  grep -qE 'exec +-a +"?Claude"?' "$TARGET_APP/Contents/MacOS/Claude"
}

@test "build-clone-app: MacOS/Claude is executable" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ -x "$TARGET_APP/Contents/MacOS/Claude" ]
}

@test "build-clone-app: _CodeSignature/ present (ad-hoc sign happened)" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  # `codesign --force --deep --sign -` writes _CodeSignature/CodeResources
  # and CodeDirectory/embedded plists. Absence means Gatekeeper will silently
  # reject the Dock click.
  [ -d "$TARGET_APP/Contents/_CodeSignature" ]
  [ -f "$TARGET_APP/Contents/_CodeSignature/CodeResources" ]
}

@test "build-clone-app: idempotent — two runs leave the same on-disk shape" {
  "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  # Snapshot the file tree + the executable's content.
  local tree1 exe1 real1 plist1
  tree1="$(find "$TARGET_APP" | sort)"
  exe1="$(shasum -a 256 "$TARGET_APP/Contents/MacOS/Claude" | awk '{print $1}')"
  real1="$(shasum -a 256 "$TARGET_APP/Contents/MacOS/Claude.real" | awk '{print $1}')"
  plist1="$(plutil -extract CFBundleIdentifier raw "$TARGET_APP/Contents/Info.plist")"

  run "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ "$status" -eq 0 ]

  local tree2 exe2 real2 plist2
  tree2="$(find "$TARGET_APP" | sort)"
  exe2="$(shasum -a 256 "$TARGET_APP/Contents/MacOS/Claude" | awk '{print $1}')"
  real2="$(shasum -a 256 "$TARGET_APP/Contents/MacOS/Claude.real" | awk '{print $1}')"
  plist2="$(plutil -extract CFBundleIdentifier raw "$TARGET_APP/Contents/Info.plist")"

  # Tree shape identical.
  [ "$tree1" = "$tree2" ]
  # Wrapper + real binary bit-identical after re-build.
  [ "$exe1" = "$exe2" ]
  [ "$real1" = "$real2" ]
  # Bundle-id survived the rebuild.
  [ "$plist1" = "$plist2" ]
  [ "$plist2" = "$TARGET_BID" ]
}

@test "build-clone-app: fails loud when source Claude.app is missing" {
  # Point CMA_SOURCE_CLAUDE_APP at nothing — Rule 12, fail loud.
  # shellcheck disable=SC2030 # bats runs each @test in a subshell; export is intentional per-test scope
  export CMA_SOURCE_CLAUDE_APP="$BATS_TEST_TMPDIR/does-not-exist.app"
  run "$BUILD_CLONE" "$LABEL" "$TARGET_BID" "$TARGET_CDIR" "$TARGET_UDATA" "$TARGET_APP"
  [ "$status" -ne 0 ]
  [[ "$output" == *"source Claude Desktop bundle missing"* ]]
}

# ── CLI `refresh-clones` tests ──────────────────────────────────────────────

@test "refresh-clones: rebuilds every mirror's clone" {
  "$CMA" init
  "$CMA" add-instance "$LABEL" --email test-b@example.com
  # The add-instance run built the clone; capture its bundle-id for the survives-rebuild assertion.
  local bid_before
  bid_before="$(plutil -extract CFBundleIdentifier raw "$TARGET_APP/Contents/Info.plist")"
  [ "$bid_before" = "$TARGET_BID" ]

  # Mutate the source: bump the version so the rebuild has an observable
  # difference we can verify. plutil replaces the value in place.
  # shellcheck disable=SC2031 # CMA_SOURCE_CLAUDE_APP is set in setup()'s subshell + read here in this test's subshell
  plutil -replace CFBundleShortVersionString -string "0.0.2-fake" \
    "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist"

  run "$CMA" refresh-clones
  [ "$status" -eq 0 ]

  # Bundle-id must survive the rebuild (drift here is the exact bug the
  # discover.sh bundle-id-parity check catches).
  local bid_after
  bid_after="$(plutil -extract CFBundleIdentifier raw "$TARGET_APP/Contents/Info.plist")"
  [ "$bid_after" = "$TARGET_BID" ]

  # And the version tracks the new source (the whole point of the
  # WatchPaths-triggered refresh).
  local ver_after
  ver_after="$(plutil -extract CFBundleShortVersionString raw "$TARGET_APP/Contents/Info.plist")"
  [ "$ver_after" = "0.0.2-fake" ]

  # Log file was written.
  [ -f "$CMA_LOG_DIR/clone-refresh.log" ]
  grep -q "refresh-clones begin" "$CMA_LOG_DIR/clone-refresh.log"
  grep -q "refresh-clones end" "$CMA_LOG_DIR/clone-refresh.log"
}

@test "refresh-clones: refuses to run while a mirror clone is running" {
  "$CMA" init
  "$CMA" add-instance "$LABEL" --email test-b@example.com

  # Stub pgrep so it reports a running mirror. The CLI's mirror-running guard
  # invokes `pgrep -f 'Claude Account .*\.app/Contents/MacOS'` — stub returns
  # exit 0 (match found) so refresh-clones must bail out.
  local stub_dir; stub_dir="$BATS_TEST_TMPDIR/pgrep-stub"
  mkdir -p "$stub_dir"
  cat >"$stub_dir/pgrep" <<'SH'
#!/usr/bin/env bash
# Return 0 for any query — simulates a running Claude Account clone.
exit 0
SH
  chmod +x "$stub_dir/pgrep"

  PATH="$stub_dir:$PATH" run "$CMA" refresh-clones
  # Must fail loud (Rule 12) rather than silently proceeding into a corrupted
  # ditto over a locked file tree.
  [ "$status" -ne 0 ]
  [[ "$output" == *"mirror clone is running"* ]]
}

@test "refresh-clones: no-op when no mirrors configured" {
  "$CMA" init
  # No add-instance — instances.yaml has zero mirrors.
  run "$CMA" refresh-clones
  [ "$status" -eq 0 ]
  # Log has the begin/end markers but no per-clone entries.
  [ -f "$CMA_LOG_DIR/clone-refresh.log" ]
  grep -q "refresh-clones begin" "$CMA_LOG_DIR/clone-refresh.log"
  grep -q "refresh-clones end" "$CMA_LOG_DIR/clone-refresh.log"
}
