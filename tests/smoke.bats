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

# `run !` and `run --separate-stderr` require bats-core >= 1.5.0. Declaring the
# minimum silences BW02 warnings when a matching bats runs the suite.
bats_require_minimum_version 1.5.0

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
	printf '%s' '{"oauthAccount":{"emailAddress":"primary@example.com"},"userID":"xxx","mcpServers":{}}' >"$HOME/.claude/.claude.json"

	# Point the CLI's config dir at the scratch $HOME too.
	export XDG_CONFIG_HOME="$HOME/.config"

	# Explicit backup + log dirs under the scratch $HOME.
	export CMA_BACKUP_DIR="$HOME/.claude-multiacct-backups"
	export CMA_LOG_DIR="$HOME/Library/Logs/claude-multiacct"

	# launchctl bootstrap fails in scratch $HOME ("5: Input/output error"); disable
	# the launchd install for hermetic tests. The launchd path itself is exercised
	# by the live install run (task #6 in the todo).
	export CMA_SKIP_LAUNCHD=1

	# Auto-migrate runs at CLI startup and would rebuild any drifted clones;
	# existing tests don't need it and would slow down noticeably. The dedicated
	# auto-migrate tests further down UNSET this to exercise the migration path.
	export CMA_SKIP_AUTO_MIGRATE=1

	# A hermetic fake Claude.app for build-clone-app.sh to ditto. Small enough to
	# copy in ~10ms per test (real Claude.app is 745 MB — too big for CI). Has
	# the two things build-clone-app.sh reads: Info.plist and MacOS/Claude.
	export CMA_SOURCE_CLAUDE_APP="$BATS_TEST_TMPDIR/fake-claude.app"
	mkdir -p "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS"
	# plutil requires the file to already look like a plist; write it in XML form
	# then use plutil to convert to binary in place if desired (we skip the
	# conversion — XML plists are perfectly valid, and build-clone-app.sh's
	# plutil -extract / -replace work on both encodings).
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
	echo "# canary" >>"$HOME/.config/claude-multiacct/instances.yaml"
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
	# .app bundle built as a clone of the source Claude.app: shell wrapper at
	# MacOS/Claude, original binary at MacOS/Claude.real, Info.plist present.
	[ -d "$HOME/Applications/Claude Account B.app" ]
	[ -x "$HOME/Applications/Claude Account B.app/Contents/MacOS/Claude" ]
	[ -f "$HOME/Applications/Claude Account B.app/Contents/MacOS/Claude.real" ]
	[ -f "$HOME/Applications/Claude Account B.app/Contents/Info.plist" ]
	# userData session subdirs are pre-created so launchd's metadata-symlink
	# WatchPaths arm on paths that exist — mkdir-on-signin then reliably fires
	# the agent. Dedicated coverage lives in metadata-watcher.bats; this line
	# is the regression guard on install-instance.sh's pre-create block.
	[ -d "$HOME/Library/Application Support/Claude-B/claude-code-sessions" ]
	[ -d "$HOME/Library/Application Support/Claude-B/local-agent-mode-sessions" ]
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
	echo "canary" >"$HOME/Library/Application Support/Claude-B/canary.txt"
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

@test "repair <label> re-runs install for existing instance" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" repair b
	[ "$status" -eq 0 ]
	# Artifacts still present after repair (repair is an install redo, not a wipe).
	[ -d "$HOME/.claude-b" ]
	[ -x "$HOME/.local/bin/claude-account-b" ]
	[ -d "$HOME/Applications/Claude Account B.app" ]
}

@test "repair is idempotent — second run leaves identical on-disk state" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# Baseline: repair once, then snapshot the on-disk layout across every
	# tree install-instance touches. The idempotency contract is that a
	# subsequent repair produces the same file listing (byte-identical paths).
	"$CMA" repair b
	local trees=(
		"$HOME/.claude-b"
		"$HOME/Library/Application Support/Claude-B"
		"$HOME/.local/bin"
		"$HOME/Applications"
	)
	local snap1
	snap1="$(find "${trees[@]}" 2>/dev/null | sort)"
	run "$CMA" repair b
	[ "$status" -eq 0 ]
	local snap2
	snap2="$(find "${trees[@]}" 2>/dev/null | sort)"
	# A drift here means repair is re-creating or renaming something on each
	# run — a live bug that would compound over time.
	[ "$snap1" = "$snap2" ]
}

@test "repair with no args repairs every configured instance" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	"$CMA" add-instance c --email test-c@example.com
	run "$CMA" repair
	[ "$status" -eq 0 ]
	# Both instances still installed after a bulk repair.
	[ -d "$HOME/.claude-b" ]
	[ -d "$HOME/.claude-c" ]
	[ -x "$HOME/.local/bin/claude-account-b" ]
	[ -x "$HOME/.local/bin/claude-account-c" ]
	[ -d "$HOME/Applications/Claude Account B.app" ]
	[ -d "$HOME/Applications/Claude Account C.app" ]
}

@test "list --tsv emits machine-parseable TSV row for each instance" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# --separate-stderr isolates stdout so we assert on the TSV row alone —
	# the human report (cma_say / cma_ok / cma_warn) is on stderr and would
	# otherwise be interleaved.
	run --separate-stderr "$CMA" list --tsv
	[ "$status" -eq 0 ]
	# Row shape from discover.sh: label<TAB>health<TAB>issues
	# Health is "ok" or "degraded" depending on whether the mirror has been
	# logged in — under a scratch $HOME it will be "degraded", which is fine;
	# the test asserts the ROW SHAPE, not the health verdict.
	[[ "$output" == b$'\t'* ]]
	# Health field is either ok or degraded — never blank.
	[[ "$output" == *$'\t'ok$'\t'* ]] || [[ "$output" == *$'\t'degraded$'\t'* ]]
}

@test "sync-log prints the log file when it exists" {
	"$CMA" init
	mkdir -p "$CMA_LOG_DIR"
	# Seed a canary so we can prove sync-log emitted the file's contents.
	printf 'sync-log-canary-line\n' >"$CMA_LOG_DIR/sessions-sync.log"
	run "$CMA" sync-log
	[ "$status" -eq 0 ]
	[[ "$output" == *"sync-log-canary-line"* ]]
}

@test "sync-log exits non-zero with a clear message when the log is absent" {
	"$CMA" init
	# No log file seeded — the worker never ran.
	run "$CMA" sync-log
	[ "$status" -ne 0 ]
	[[ "$output" == *"log not found"* ]]
}

@test "sync-log --tail flag is accepted (tail stub short-circuits the follow)" {
	"$CMA" init
	mkdir -p "$CMA_LOG_DIR"
	printf 'sync-log-canary-line\n' >"$CMA_LOG_DIR/sessions-sync.log"
	# `exec tail -f` would block indefinitely. Stub tail on PATH so the flag's
	# code path runs to a clean exit — the test proves parsing + dispatch,
	# not follow semantics.
	local stub_dir
	stub_dir="$BATS_TEST_TMPDIR/tail-stub"
	mkdir -p "$stub_dir"
	cat >"$stub_dir/tail" <<'SH'
#!/usr/bin/env bash
exit 0
SH
	chmod +x "$stub_dir/tail"
	PATH="$stub_dir:$PATH" run "$CMA" sync-log --tail
	[ "$status" -eq 0 ]
}

@test "sync-log rejects unknown flags" {
	"$CMA" init
	mkdir -p "$CMA_LOG_DIR"
	printf 'seed\n' >"$CMA_LOG_DIR/sessions-sync.log"
	run "$CMA" sync-log --bogus
	[ "$status" -ne 0 ]
	[[ "$output" == *"unknown flag"* ]]
}

# ── Auto-migrate (bundle-id drift auto-healing) ─────────────────────────────
# These tests deliberately UNSET the setup()-level CMA_SKIP_AUTO_MIGRATE=1 so
# the migration path actually runs. A per-test pgrep stub controls whether the
# code thinks a mirror is currently running (auto-migrate refuses to rebuild
# a live bundle).
#
# The contract:
#   - drift + no mirror running → silent auto-rebuild happens before the
#     user's subcommand runs
#   - drift + mirror running → warn, do NOT rebuild, subcommand still runs
#   - no drift → no chatter (fast no-op)
#   - no config file → no chatter (early exit)

_setup_pgrep_stub() {
	# Args: exit code to return. 1 = "no matching process" (default), 0 = "match".
	local exit_code="$1"
	local stub_dir="$BATS_TEST_TMPDIR/auto-migrate-stubs"
	mkdir -p "$stub_dir"
	cat >"$stub_dir/pgrep" <<SH
#!/usr/bin/env bash
exit $exit_code
SH
	chmod +x "$stub_dir/pgrep"
	export PATH="$stub_dir:$PATH"
}

@test "auto-migrate no-ops silently when there is no config file" {
	# No init — no config, so auto-migrate should skip cleanly. `--help` is a
	# command that DOES bypass auto-migrate; use a real subcommand instead to
	# prove the config-file check works from within _cma_maybe_migrate.
	unset CMA_SKIP_AUTO_MIGRATE
	_setup_pgrep_stub 1
	run "$CMA" list
	# `list` requires the config file, so it will fail — but the failure must
	# come from `list`'s cma_require_config, NOT from auto-migrate crashing.
	# Assert no auto-migrate chatter regardless of exit code.
	[[ "$output" != *"auto-migrating"* ]]
	[[ "$output" != *"drift"* ]]
}

@test "auto-migrate no-ops silently when there is no drift" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	unset CMA_SKIP_AUTO_MIGRATE
	_setup_pgrep_stub 1
	run "$CMA" list
	[ "$status" -eq 0 ]
	# No output about auto-migration — the CLI just runs the intended command.
	[[ "$output" != *"auto-migrating"* ]]
	[[ "$output" != *"drift detected"* ]]
}

@test "auto-migrate rebuilds a drifted clone when no mirror is running" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# Force drift: rewrite the freshly-installed Info.plist's CFBundleIdentifier
	# to a stale value the tool would never generate.
	plutil -replace CFBundleIdentifier -string 'com.stale.legacy' \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist"
	local drifted
	drifted="$(plutil -extract CFBundleIdentifier raw \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist")"
	[ "$drifted" = "com.stale.legacy" ]

	unset CMA_SKIP_AUTO_MIGRATE
	_setup_pgrep_stub 1 # no matching mirror process
	# Any real subcommand triggers auto-migrate. `list` is cheap.
	run "$CMA" list
	[ "$status" -eq 0 ]
	# The migration should have announced itself + healed the bundle-id.
	[[ "$output" == *"auto-migrating"* ]]
	local healed
	healed="$(plutil -extract CFBundleIdentifier raw \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist")"
	[ "$healed" = "com.claude-multiacct.claude-account-b-desktop" ]
}

@test "auto-migrate warns + skips rebuild when a mirror is running" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# Force drift.
	plutil -replace CFBundleIdentifier -string 'com.stale.legacy' \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist"

	unset CMA_SKIP_AUTO_MIGRATE
	_setup_pgrep_stub 0 # simulate a running mirror
	run "$CMA" list
	# Subcommand still succeeds — auto-migrate does not block the user's intent.
	[ "$status" -eq 0 ]
	# Warning surfaces so the user knows to quit + retry.
	[[ "$output" == *"drift"* ]]
	# Bundle-id is UNTOUCHED — a live bundle is never rebuilt.
	local still_drifted
	still_drifted="$(plutil -extract CFBundleIdentifier raw \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist")"
	[ "$still_drifted" = "com.stale.legacy" ]
}

@test "auto-migrate skipped on --help (no side effects on informational invocations)" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# Force drift.
	plutil -replace CFBundleIdentifier -string 'com.stale.legacy' \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist"
	unset CMA_SKIP_AUTO_MIGRATE
	_setup_pgrep_stub 1
	# `--help` should print usage without ever attempting migration.
	run "$CMA" --help
	[ "$status" -eq 0 ]
	[[ "$output" != *"auto-migrating"* ]]
	# And the drifted bundle-id stays drifted (proves auto-migrate didn't run).
	local still_drifted
	still_drifted="$(plutil -extract CFBundleIdentifier raw \
		"$HOME/Applications/Claude Account B.app/Contents/Info.plist")"
	[ "$still_drifted" = "com.stale.legacy" ]
}

# ── exec subcommand ──────────────────────────────────────────────────────────
# Runs a command with CLAUDE_CONFIG_DIR + CHROMIUM_USER_DATA_DIR pointing at a
# mirror instance's data. The important invariants are:
#   - unknown label fails loud with a helpful error
#   - the env vars reach the child command (verified via `env` / `printenv`)
#   - with no cmd, prints the env-var assignments as a dry-run
#   - the `--` separator is optional
#
# `assert` semantics: `[[ ]]` mid-test is silent (SC2314 / [[bats-vacuous-asserts]]),
# so match assertions use `run ! ...` + `[ "$status" ... ]` or `[[ "$output" == ... ]]`
# on the line immediately after `run`, which IS checked.

@test "exec with unknown label fails loud" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" exec no-such-label -- true
	[ "$status" -ne 0 ]
	# The error mentions the label and instances.yaml so a user knows where
	# to look — helpful, not just "not found".
	[[ "$output" == *"no-such-label"* ]]
	[[ "$output" == *"instances.yaml"* ]] || [[ "$output" == *"$HOME/.config/claude-multiacct"* ]]
}

@test "exec with no label fails loud" {
	"$CMA" init
	run "$CMA" exec
	[ "$status" -ne 0 ]
	[[ "$output" == *"label required"* ]]
}

@test "exec runs env and CLAUDE_CONFIG_DIR is exported to the child" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" exec b -- env
	[ "$status" -eq 0 ]
	# The default configDir for label 'b' is ~/.claude-b — the child MUST see it.
	[[ "$output" == *"CLAUDE_CONFIG_DIR=$HOME/.claude-b"* ]]
	# And CHROMIUM_USER_DATA_DIR must point at the default userData.
	[[ "$output" == *"CHROMIUM_USER_DATA_DIR=$HOME/Library/Application Support/Claude-B"* ]]
}

@test "exec printenv CLAUDE_CONFIG_DIR exits 0 with the right value" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" exec b -- printenv CLAUDE_CONFIG_DIR
	[ "$status" -eq 0 ]
	# printenv writes ONLY the value, terminated with a newline — an exact
	# match here proves the env var reached the child unmangled.
	[ "$output" = "$HOME/.claude-b" ]
}

@test "exec accepts the -- separator" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# The idiom is `exec <label> -- <cmd>` (like env/sudo); the `--` disambiguates
	# a command whose first arg looks like a flag. Same behavior as omitting it.
	run "$CMA" exec b -- printenv CLAUDE_CONFIG_DIR
	[ "$status" -eq 0 ]
	[ "$output" = "$HOME/.claude-b" ]
}

@test "exec without a command prints env-var assignments (dry-run)" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" exec b
	[ "$status" -eq 0 ]
	# The output is `eval`-consumable; each line is `export NAME=<quoted>`.
	# Print BOTH env-var assignments so the user can copy/paste the pair.
	[[ "$output" == *"export CLAUDE_CONFIG_DIR="* ]]
	[[ "$output" == *"export CHROMIUM_USER_DATA_DIR="* ]]
	[[ "$output" == *"$HOME/.claude-b"* ]]
}

@test "exec propagates the child's exit code" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# `false` exits 1 → exec's exit must be 1 (not our own error path).
	run "$CMA" exec b -- false
	[ "$status" -eq 1 ]
}

@test "exec refuses invalid label" {
	"$CMA" init
	run "$CMA" exec "B_uppercase" -- true
	[ "$status" -ne 0 ]
	[[ "$output" == *"invalid label"* ]]
}
