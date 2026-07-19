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

# ── primary /Applications/Claude.app patching (UPDATE-SAFE) ───────────────────
# WHY (Rule 9): the primary IS patched now, but update-safely — the loose-DR
# inside-out re-sign keeps Squirrel updates valid (the old cdhash-DR regression
# is what froze the primary). Full patch coverage lives in primary-patch.bats
# (which uses a fixture WITH an app.asar). These smoke tests lock in two
# lighter invariants: (1) `install` fires primary-patch but NO-OPS on a bundle
# that has no app.asar (this smoke fixture) — so the bundle is left untouched
# and install still succeeds; (2) the primary-patch / primary-unpatch
# subcommands are WIRED (dispatched, not "unknown subcommand").

@test "install fires primary-patch but no-ops on a bundle with no app.asar" {
	# This smoke fixture's fake Claude.app has no app.asar, so primary-patch's
	# asar pipeline returns early and the bundle stays byte-identical. install
	# must still succeed (the missing-asar branch is fail-soft).
	local before after
	before="$(cd "$CMA_SOURCE_CLAUDE_APP" && find . -type f -exec shasum {} + | sort)"
	run "$CMA" install
	[ "$status" -eq 0 ]
	after="$(cd "$CMA_SOURCE_CLAUDE_APP" && find . -type f -exec shasum {} + | sort)"
	[ "$before" = "$after" ]
	# No patch artifacts, because there was no asar to patch.
	[ ! -e "$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup" ]
	[ ! -e "$CMA_SOURCE_CLAUDE_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist" ]
}

@test "primary-patch and primary-unpatch subcommands are wired (not unknown)" {
	# primary-patch on a no-asar bundle is a successful no-op (dispatched, not
	# "unknown subcommand").
	run "$CMA" primary-patch
	[ "$status" -eq 0 ]
	[[ "$output" != *"unknown subcommand"* ]]
	# primary-unpatch with no backup fails with a primary-specific message —
	# again proving it is dispatched, not an unknown subcommand.
	run "$CMA" primary-unpatch
	[ "$status" -ne 0 ]
	[[ "$output" != *"unknown subcommand"* ]]
	[[ "$output" == *"no backup"* ]] || [[ "$output" == *"never patched"* ]]
}

@test "install-launchd renders exactly 4 agents (incl primary-patch-refresh)" {
	# Under a stubbed launchctl (real one fails in a scratch $HOME) with the
	# hermetic skip lifted, install-launchd must render exactly the four
	# runtime agents — sessions-sync, clone-refresh, primary-patch-refresh,
	# and metadata-symlink. The primary-patch-refresh agent re-applies the
	# primary patch after each Squirrel drop (updates now apply thanks to the
	# loose-DR re-sign), so it is load-bearing and must be present.
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	local stub="$BATS_TEST_TMPDIR/stub-bin"
	mkdir -p "$stub"
	printf '#!/usr/bin/env bash\nexit 0\n' >"$stub/launchctl"
	chmod +x "$stub/launchctl"
	run env -u CMA_SKIP_LAUNCHD PATH="$stub:$PATH" "$REPO/lib/install-launchd.sh"
	[ "$status" -eq 0 ]
	local agents="$HOME/Library/LaunchAgents"
	[ -f "$agents/com.user.claude-sessions-sync.plist" ]
	[ -f "$agents/com.user.claude-clone-refresh.plist" ]
	[ -f "$agents/com.user.claude-primary-patch-refresh.plist" ]
	[ -f "$agents/com.user.claude-metadata-symlink.plist" ]
	local count
	count="$(find "$agents" -name 'com.user.claude-*.plist' | wc -l | tr -d ' ')"
	[ "$count" = "4" ]
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

# ── doctor --json ────────────────────────────────────────────────────────────
# JSON mode is the cross-mac verification path: two Macs' outputs should be
# structurally identical (modulo repo/config/logs paths + the launchd-agent
# state) when the config is in sync. See docs/cross-mac-setup.md.

@test "doctor --json emits valid JSON with expected top-level keys" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" doctor --json
	[ "$status" -eq 0 ]
	# Use python (available on every macOS by default) to parse — proves the
	# output is real JSON, not just braces-and-strings. The doctor JSON carries
	# a top-level `primary` key (primary bundle diagnostics) alongside the
	# `instances` array of mirror objects. `primary` is an object or null.
	python3 -c "import json,sys; d=json.loads('''$output'''); assert 'repo' in d and 'config' in d and 'launchd_agents' in d and 'instances' in d and 'primary' in d, d.keys(); assert isinstance(d['instances'], list); assert d['primary'] is None or isinstance(d['primary'], dict); sys.exit(0)"
}

@test "doctor --json includes each configured instance" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	run "$CMA" doctor --json
	[ "$status" -eq 0 ]
	# Instance labels + emails must round-trip through JSON.
	run python3 -c "
import json
d = json.loads('''$output''')
labels = [i['label'] for i in d['instances']]
emails = [i['email'] for i in d['instances']]
assert 'b' in labels, f'missing b: {labels}'
assert 'test-b@example.com' in emails, f'missing email: {emails}'
print('OK')
"
	[ "$status" -eq 0 ]
	[[ "$output" == *"OK"* ]]
}

@test "doctor --json produces empty instances array when no config" {
	# No `init` — CMA_CONFIG_FILE won't exist.
	run "$CMA" doctor --json
	[ "$status" -eq 0 ]
	# Should still produce valid JSON with an empty instances array.
	run python3 -c "
import json
d = json.loads('''$output''')
assert d['instances'] == [], f'expected empty instances: {d[\"instances\"]}'
print('OK')
"
	[ "$status" -eq 0 ]
	[[ "$output" == *"OK"* ]]
}

# ── remoteControlAtStartup enforcement (Chunk X-A Part 1b) ───────────────────
#
# WHY this block exists (Rule 9): auto-enabling Remote Control at session
# startup is the load-bearing outcome the User-tier settings.json write is
# for. SettingsResolver's j$n() reads the flag off either the User tier or
# the Managed tier and returns it; without the User-tier write, an operator
# who hasn't got the asar-patch mirror-prefs plist (or a stale one) sees
# Remote Control stay off. Every assertion here maps to a piece of that fix:
#
#     - Fresh install writes the key                → auto-enable ships out of
#                                                     the box on every new
#                                                     mirror instance.
#     - Repair re-enables when a user has flipped it → doctor + repair form a
#                                                     healing loop; a slip to
#                                                     false on manual edit is
#                                                     transient.
#     - Existing keys are preserved on merge         → a user with permissions
#                                                     tuned in settings.json
#                                                     does not lose that on
#                                                     first install / repair.
#     - Doctor detects a missing key                 → operator can find drift
#                                                     without opening the file.
#     - Idempotent (second run makes no changes)     → repair fires on every
#                                                     launchd trigger; a stray
#                                                     rewrite would churn the
#                                                     file's mtime + trigger
#                                                     Claude Desktop's own
#                                                     settings watcher.

@test "install writes remoteControlAtStartup=true into fresh mirror settings.json" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	local val
	val="$(python3 -c "
import json
print(json.load(open('$HOME/.claude-b/settings.json')).get('remoteControlAtStartup'))
")"
	[ "$val" = "True" ]
}

@test "repair re-enables remoteControlAtStartup after a manual flip to false" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# User (or a rogue script) toggles the key off. The next repair run must
	# heal it back to true — that's the guarantee.
	python3 -c "
import json
p='$HOME/.claude-b/settings.json'
d=json.load(open(p))
d['remoteControlAtStartup']=False
json.dump(d, open(p, 'w'), indent=2)
"
	"$CMA" repair b
	local val
	val="$(python3 -c "
import json
print(json.load(open('$HOME/.claude-b/settings.json')).get('remoteControlAtStartup'))
")"
	[ "$val" = "True" ]
}

@test "install merges remoteControlAtStartup into a settings.json with existing keys (preserved)" {
	"$CMA" init
	# Simulate a user who has pre-seeded a settings.json with their own tuning
	# BEFORE add-instance runs — install-instance.sh's "skip if exists" branch
	# leaves the file alone but the ensure-key step MUST still merge without
	# clobbering.
	mkdir -p "$HOME/.claude-b"
	cat >"$HOME/.claude-b/settings.json" <<'JSON'
{
  "permissions": {
    "allow": ["Bash(*)", "WebFetch"]
  },
  "customUserKey": "preserve-me"
}
JSON
	"$CMA" add-instance b --email test-b@example.com

	# Every existing key must survive.
	local perms custom rc
	perms="$(python3 -c "
import json
d=json.load(open('$HOME/.claude-b/settings.json'))
print(','.join(d['permissions']['allow']))
")"
	custom="$(python3 -c "
import json
print(json.load(open('$HOME/.claude-b/settings.json'))['customUserKey'])
")"
	rc="$(python3 -c "
import json
print(json.load(open('$HOME/.claude-b/settings.json'))['remoteControlAtStartup'])
")"
	[ "$perms" = "Bash(*),WebFetch" ]
	[ "$custom" = "preserve-me" ]
	[ "$rc" = "True" ]
}

@test "doctor detects missing remoteControlAtStartup in mirror settings.json" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# Delete the key so doctor sees drift.
	python3 -c "
import json
p='$HOME/.claude-b/settings.json'
d=json.load(open(p))
d.pop('remoteControlAtStartup', None)
json.dump(d, open(p, 'w'), indent=2)
"
	run "$CMA" doctor
	# Doctor is diagnostic — exits 0 even when it surfaces drift.
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" == *"remoteControlAtStartup MISSING"* ]]
}

@test "install of remoteControlAtStartup is idempotent — second repair leaves settings.json byte-identical" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	local hash1
	hash1="$(shasum -a 256 "$HOME/.claude-b/settings.json" | awk '{print $1}')"
	"$CMA" repair b
	local hash2
	hash2="$(shasum -a 256 "$HOME/.claude-b/settings.json" | awk '{print $1}')"
	# Byte-identical: the cma_ensure_setting_bool "already correct → no write"
	# short-circuit is what makes this safe under a launchd-triggered repair
	# storm (Claude Desktop's own settings watcher would otherwise churn on
	# every fire).
	[ "$hash1" = "$hash2" ]
}

@test "repair enforces remoteControlAtStartup on the PRIMARY configDir settings.json" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	# The scratch primary configDir under $HOME/.claude has been created by
	# setup(); repair must now merge remoteControlAtStartup into its settings.json
	# too. This covers the primary-writeback branch cmd_repair added.
	run "$CMA" repair
	[ "$status" -eq 0 ]
	local val
	val="$(python3 -c "
import json
print(json.load(open('$HOME/.claude/settings.json')).get('remoteControlAtStartup'))
")"
	[ "$val" = "True" ]
}

# ── C4: shared-account contention doctor warning ──────────────────────────
#
# The metadata symlinks point mirror<acct>/<org> → primary<acct>/<org>. If a
# mirror is signed into the SAME Anthropic account as the primary (identical
# lastKnownAccountUuid), the two resolve to ONE live ~/.claude session store
# and contend over it. Doctor must WARN (never mutate the share set).

@test "C4 doctor: warns CONTENTION when a mirror shares the primary's account UUID" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	mkdir -p "$HOME/Library/Application Support/Claude" "$HOME/Library/Application Support/Claude-B"
	# Primary AND mirror both carry the SAME account UUID.
	printf '{"lastKnownAccountUuid":"11111111-1111-1111-1111-111111111111"}' \
		>"$HOME/Library/Application Support/Claude/config.json"
	printf '{"lastKnownAccountUuid":"11111111-1111-1111-1111-111111111111"}' \
		>"$HOME/Library/Application Support/Claude-B/config.json"
	run "$CMA" doctor
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" == *"CONTENTION"* ]]
	[[ "$output" == *"LIVE"* ]]
}

@test "C4 doctor: quiet when mirror + primary have DISTINCT account UUIDs" {
	"$CMA" init
	"$CMA" add-instance b --email test-b@example.com
	mkdir -p "$HOME/Library/Application Support/Claude" "$HOME/Library/Application Support/Claude-B"
	printf '{"lastKnownAccountUuid":"11111111-1111-1111-1111-111111111111"}' \
		>"$HOME/Library/Application Support/Claude/config.json"
	printf '{"lastKnownAccountUuid":"22222222-2222-2222-2222-222222222222"}' \
		>"$HOME/Library/Application Support/Claude-B/config.json"
	run "$CMA" doctor
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" != *"CONTENTION"* ]]
}

# ── H3: libexec TCC escape for launchd agents ─────────────────────────────
#
# Background launchd agents can't exec from a TCC-protected container
# (~/Documents → 126 / "Operation not permitted"). install-launchd copies the
# agent scripts + lib/ deps into ~/.local/libexec/claude-multiacct and points
# every plist there. The copy runs even under CMA_SKIP_LAUNCHD.

@test "H3 libexec: init copies bin+lib into libexec and the copied lib/common.sh sources cleanly" {
	"$CMA" init
	local libexec="$HOME/.local/libexec/claude-multiacct"
	[ -d "$libexec/bin" ]
	[ -d "$libexec/lib" ]
	[ -f "$libexec/bin/claude-metadata-watcher.sh" ]
	[ -f "$libexec/bin/claude-sessions-sync.sh" ]
	[ -f "$libexec/bin/claude-clone-refresh.sh" ]
	[ -f "$libexec/bin/claude-multiacct" ]
	[ -f "$libexec/lib/common.sh" ]
	# The copied agent's `../lib/common.sh` source path must resolve WITHIN
	# libexec (self-contained — never reaches back into the ~/Documents checkout).
	run bash -c 'set -euo pipefail; . "'"$libexec"'/lib/common.sh"; printf "%s" "$CMA_LIBEXEC_DIR"'
	[ "$status" -eq 0 ]
	[ -n "$output" ]
}

@test "H3 libexec reclaim: removed when no launchd plist references it" {
	local libexec="$HOME/.local/libexec/claude-multiacct"
	mkdir -p "$libexec/bin"
	printf 'x' >"$libexec/bin/marker"
	mkdir -p "$HOME/Library/LaunchAgents"
	# No plist references libexec → reclaim removes it.
	run bash -c 'set -euo pipefail; . "'"$REPO"'/lib/common.sh"; cma_reclaim_libexec_if_unreferenced'
	[ "$status" -eq 0 ]
	[ ! -d "$libexec" ]
}

@test "H3 libexec reclaim: preserved while a launchd plist still references it" {
	local libexec="$HOME/.local/libexec/claude-multiacct"
	mkdir -p "$libexec/bin"
	printf 'x' >"$libexec/bin/marker"
	mkdir -p "$HOME/Library/LaunchAgents"
	# A still-installed plist points ProgramArguments at libexec → keep it.
	printf '<plist>%s/bin/claude-sessions-sync.sh</plist>' "$libexec" \
		>"$HOME/Library/LaunchAgents/com.user.claude-sessions-sync.plist"
	run bash -c 'set -euo pipefail; . "'"$REPO"'/lib/common.sh"; cma_reclaim_libexec_if_unreferenced'
	[ "$status" -eq 0 ]
	[ -d "$libexec" ]
}
