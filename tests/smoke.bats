#!/usr/bin/env bats
# smoke.bats — hermetic install/uninstall of a single mirror instance under a
# scratch $HOME. Verifies:
#   - claude-multiacct init writes ~/.config/claude-multiacct/instances.yaml
#   - add-instance appends the instance + creates configDir/userData/launcher/.app
#   - list reports the instance in the discovery output
#   - remove-instance tears everything down + updates instances.yaml
#
# Tests are hermetic: each test spins up a fresh $HOME under $BATS_TEST_TMPDIR.
# The real ~/.config/claude-multiacct is never touched.

setup() {
  # Repo root two levels up from this test file.
  REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
  export REPO
  export CMA="$REPO/bin/claude-multiacct"

  # Scratch $HOME with the minimum layout the CLI needs to discover a primary.
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME/.config"
  mkdir -p "$HOME/.local/bin"
  mkdir -p "$HOME/Applications"
  mkdir -p "$HOME/Library/Application Support/Claude/claude-code-sessions/aaaa-bbbb-cccc/dddd-eeee-ffff"
  mkdir -p "$HOME/Library/Application Support/Claude/local-agent-mode-sessions/aaaa-bbbb-cccc"
  mkdir -p "$HOME/.claude"
  # A stub .claude.json so mirror_claude_json has something to strip from.
  printf '%s' '{"oauthAccount":{"emailAddress":"primary@example.com"},"userID":"xxx","mcpServers":{}}' > "$HOME/.claude/.claude.json"

  # Point the CLI's config dir at the scratch $HOME too.
  export XDG_CONFIG_HOME="$HOME/.config"

  # Explicit backup + log dirs under the scratch $HOME.
  export CMA_BACKUP_DIR="$HOME/.claude-multiacct-backups"
  export CMA_LOG_DIR="$HOME/Library/Logs/claude-multiacct"

  # launchctl bootstrap fails in scratch $HOME ("5: Input/output error"); disable
  # the launchd install for hermetic tests. The launchd path itself is exercised
  # by the live install run (task #6 in the todo).
  export CMA_SKIP_LAUNCHD=1
}

@test "help prints usage" {
  run "$CMA" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude-multiacct — manage multiple Claude Desktop instances"* ]]
}

@test "init writes instances.yaml with primary detected" {
  run "$CMA" init
  [ "$status" -eq 0 ]
  [ -f "$HOME/.config/claude-multiacct/instances.yaml" ]
  # The primary email was in the stub .claude.json — should surface in the config.
  grep -q "primary@example.com" "$HOME/.config/claude-multiacct/instances.yaml"
}

@test "init is idempotent — second run does not overwrite" {
  "$CMA" init
  # Poke a canary line to detect overwrite.
  echo "# canary" >> "$HOME/.config/claude-multiacct/instances.yaml"
  run "$CMA" init
  [ "$status" -eq 0 ]
  grep -q "# canary" "$HOME/.config/claude-multiacct/instances.yaml"
}

@test "add-instance appends to instances.yaml + creates on-disk artifacts" {
  "$CMA" init
  run "$CMA" add-instance b --email test-b@example.com
  [ "$status" -eq 0 ]
  # instances.yaml has the new entry.
  grep -q "test-b@example.com" "$HOME/.config/claude-multiacct/instances.yaml"
  # configDir exists + has the shared symlinks.
  [ -d "$HOME/.claude-b" ]
  [ -L "$HOME/.claude-b/projects" ]
  # CLI launcher installed + executable.
  [ -x "$HOME/.local/bin/claude-account-b" ]
  # .app bundle built.
  [ -d "$HOME/Applications/Claude Account B.app" ]
  [ -x "$HOME/Applications/Claude Account B.app/Contents/MacOS/launcher" ]
  [ -f "$HOME/Applications/Claude Account B.app/Contents/Info.plist" ]
}

@test "add-instance refuses duplicate label" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  run "$CMA" add-instance b --email another@example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"already in"* ]]
}

@test "add-instance refuses invalid label" {
  "$CMA" init
  run "$CMA" add-instance "B_uppercase" --email x@example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"invalid label"* ]]
}

@test "add-instance refuses reserved label 'primary'" {
  "$CMA" init
  run "$CMA" add-instance primary --email x@example.com
  [ "$status" -ne 0 ]
  [[ "$output" == *"reserved"* ]]
}

@test "list reports the added instance" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  run "$CMA" list
  [ "$status" -eq 0 ]
  # discover.sh emits the instance header + fields.
  [[ "$output" == *"instance: b"* ]]
}

@test "remove-instance strips config entry + tears down artifacts" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  run "$CMA" remove-instance b
  [ "$status" -eq 0 ]
  # instances.yaml no longer contains the entry.
  # NOTE: bare `!` doesn't fail a bats test (SC2314 / [[bats-vacuous-asserts]] memory);
  # use `run ! ...` so a match failure actually surfaces as $status != 0.
  run ! grep -q "test-b@example.com" "$HOME/.config/claude-multiacct/instances.yaml"
  # Artifacts removed by default (default is delete configDir + userData).
  [ ! -e "$HOME/.local/bin/claude-account-b" ]
  [ ! -d "$HOME/Applications/Claude Account B.app" ]
}

@test "remove-instance --keep-userdata preserves userData" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  # Drop a canary into userData so we can verify preservation.
  echo "canary" > "$HOME/Library/Application Support/Claude-B/canary.txt"
  run "$CMA" remove-instance b --keep-userdata
  [ "$status" -eq 0 ]
  [ -f "$HOME/Library/Application Support/Claude-B/canary.txt" ]
}

@test "sync-now is safe as a no-op when no mirrors exist" {
  "$CMA" init
  # No mirrors added — should either exit 0 (nothing to sync) or skip loudly.
  run "$CMA" sync-now
  # Accept 0 (nothing to do) or a warning-return.
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
}

@test "doctor runs to completion on a fresh install" {
  "$CMA" init
  "$CMA" add-instance b --email test-b@example.com
  run "$CMA" doctor
  # Doctor is diagnostic; it exits 0 even when it reports drift.
  [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
  [[ "$output" == *"claude-multiacct doctor"* ]]
}

@test "install symlinks CLI into ~/.local/bin (idempotent, invocable)" {
  run "$CMA" install
  [ "$status" -eq 0 ]
  [ -L "$HOME/.local/bin/claude-multiacct" ]
  target="$(readlink "$HOME/.local/bin/claude-multiacct")"
  [ "$target" = "$REPO/bin/claude-multiacct" ]
  # Second run is a safe no-op.
  run "$CMA" install
  [ "$status" -eq 0 ]
  [ -L "$HOME/.local/bin/claude-multiacct" ]
  # Symlink must be invocable — BASH_SOURCE resolution has to follow the symlink
  # back to $REPO so `. "$CMA_LIB/common.sh"` finds ../lib. Regression guard.
  run "$HOME/.local/bin/claude-multiacct" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"claude-multiacct — manage"* ]]
}

@test "uninstall removes the CLI symlink" {
  "$CMA" install
  run "$CMA" uninstall
  [ "$status" -eq 0 ]
  [ ! -e "$HOME/.local/bin/claude-multiacct" ]
  # Second run when nothing to remove is still a safe no-op.
  run "$CMA" uninstall
  [ "$status" -eq 0 ]
}

@test "install refuses to clobber a foreign symlink" {
  # Foreign symlink pre-existing — install must refuse rather than overwrite.
  ln -s /usr/bin/true "$HOME/.local/bin/claude-multiacct"
  run "$CMA" install
  [ "$status" -ne 0 ]
  # Symlink was NOT touched.
  [ "$(readlink "$HOME/.local/bin/claude-multiacct")" = "/usr/bin/true" ]
}
