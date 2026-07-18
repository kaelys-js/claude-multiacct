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
		>"$HOME/.claude/.claude.json"

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
	local stub_dir
	stub_dir="$BATS_TEST_TMPDIR/pgrep-stub"
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

# ── asar-patch-clone.sh tests ───────────────────────────────────────────────
# These exercise the asar patch mechanism (docs/architecture.md "The asar
# patch layer"). The patch is what makes each mirror's Claude Desktop
# short-circuit its Squirrel auto-updater on `disableAutoUpdates=YES` from a
# per-mirror plist we bake into the clone. Without this, every mirror would
# fire an update check against Anthropic's Squirrel feed against our ad-hoc
# signature, Squirrel would reject on DR-mismatch, and the "Check for
# Updates" menu-click would surface "Failed to check for updates".
#
# Each assertion targets a specific piece of the fix per Rule 9:
#
#   - bXt() anchor gets the mirror-prefs path appended    → Claude reads
#     our plist (in addition to the two MDM-owned locations).
#   - The mirror-prefs plist has disableAutoUpdates=YES   → Oe().autoUpdate.disabled=true
#     → i_t() short-circuits (no network poll) AND NRn() menu builder
#       disables "Check for Updates…" with sublabel "Updates disabled by admin".
#   - Info.plist ElectronAsarIntegrity hash matches the   → Electron's boot-
#     computed asar header SHA-256                          time integrity
#                                                           check passes.
#   - Idempotency                                         → refresh-clones
#     firing on every Squirrel update doesn't produce spurious drift.
#
# Fixture: setup_asar_fixture() below overlays a synthetic app.asar (with the
# real anchor strings and a real ElectronAsarIntegrity Info.plist key) on
# top of the fake Claude.app the base setup() built. That way build-clone-app
# tests without asar remain untouched — asar tests get the full fixture.

setup_asar_fixture() {
	# Only rebuild if not already present (tests may share fixture state).
	# shellcheck disable=SC2031 # CMA_SOURCE_CLAUDE_APP is set in setup()'s subshell + read here in this test's subshell — see the parallel disable near build-clone-app's use-in-test.
	local resources="$CMA_SOURCE_CLAUDE_APP/Contents/Resources"
	local staging="$BATS_TEST_TMPDIR/asar-staging"
	mkdir -p "$resources"
	mkdir -p "$staging/.vite/build"
	# Locate the developer's mise-installed @electron/asar and export it as
	# CMA_ASAR_MODULE_DIR so lib/asar-patch-clone.sh (running under bats'
	# scratch $HOME) can find it. Falls back to `mise where` if the primary
	# real-HOME glob turns up nothing (e.g. a machine that installs mise
	# under a non-standard XDG root).
	local real_home_glob="/Users/*/.local/share/mise/installs/npm-electron-asar/*/lib/node_modules/@electron/asar"
	local d
	# shellcheck disable=SC2086 # deliberate glob expansion — the pattern is a real filesystem probe, not a param
	for d in $real_home_glob; do
		[ -d "$d" ] && export CMA_ASAR_MODULE_DIR="$d" && break
	done
	if [ -z "${CMA_ASAR_MODULE_DIR:-}" ] && command -v mise >/dev/null 2>&1; then
		local base
		base="$(mise where npm:@electron/asar 2>/dev/null || true)"
		[ -n "$base" ] && [ -d "$base/lib/node_modules/@electron/asar" ] &&
			export CMA_ASAR_MODULE_DIR="$base/lib/node_modules/@electron/asar"
	fi
	if [ -z "${CMA_ASAR_MODULE_DIR:-}" ]; then
		skip "@electron/asar module not found under any known prefix — run \`mise install\`"
	fi
	local mod_dir="$CMA_ASAR_MODULE_DIR"
	# The two anchor files. Only the presence + literal anchor string matter
	# for the patch script — we don't need Claude's real minified JS body.
	# Wrap the anchor in surrounding text so the .replace() sees a unique
	# occurrence (matches production shape where the anchor lives inside the
	# bXt() function definition).
	cat >"$staging/.vite/build/index.chunk-DD6nxfJK.js" <<'JS'
// Fake index.chunk file — the anchor below is what lib/asar-patch-clone.sh rewrites.
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	cat >"$staging/.vite/build/index.pre.js" <<'JS'
// Fake index.pre.js — same anchor as the chunk, distinct file.
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	local orig_asar="$resources/app.asar"
	rm -f "$orig_asar"
	# Rebuild the asar and stamp its header SHA-256 into a fresh Info.plist
	# ElectronAsarIntegrity entry so the patch script sees a realistic
	# pristine state (that it must then re-hash after rewriting the anchors).
	node --input-type=module -e "
import { createPackageWithOptions, getRawHeader } from 'file://$mod_dir/lib/asar.js';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
await createPackageWithOptions('$staging', '$orig_asar', { unpack: '{*.node,*.dylib,spawn-helper}' });
const raw = getRawHeader('$orig_asar');
const h = createHash('sha256').update(raw.headerString).digest('hex');
writeFileSync('$BATS_TEST_TMPDIR/fixture-hash', h);
"
	# Rewrite Info.plist to include ElectronAsarIntegrity with the fixture hash.
	local h
	h="$(cat "$BATS_TEST_TMPDIR/fixture-hash")"
	# shellcheck disable=SC2031 # CMA_SOURCE_CLAUDE_APP is set in setup()'s subshell + read here in this test's subshell
	cat >"$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" <<PLIST
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
	<key>ElectronAsarIntegrity</key>
	<dict>
		<key>Resources/app.asar</key>
		<dict>
			<key>algorithm</key><string>SHA256</string>
			<key>hash</key><string>${h}</string>
		</dict>
	</dict>
</dict>
</plist>
PLIST
}

@test "asar-patch: appends mirror-prefs path to bXt() anchor in both files (auto-poll suppression)" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	# The patch script runs inline with build-clone-app.sh (via add-instance).
	# Extract the CLONE's asar and check the anchor files carry the mirror-prefs marker.
	local extract="$BATS_TEST_TMPDIR/clone-extract"
	rm -rf "$extract"
	node --input-type=module -e "
import { extractAll } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
extractAll('$TARGET_APP/Contents/Resources/app.asar', '$extract');
"
	# Both anchor files must contain the injected mirror-prefs path.
	grep -q 'claude-multiacct-mirror-prefs.plist' "$extract/.vite/build/index.chunk-DD6nxfJK.js"
	grep -q 'claude-multiacct-mirror-prefs.plist' "$extract/.vite/build/index.pre.js"
	# And the ORIGINAL anchor should still be present (append, not replace).
	grep -q 'com\.anthropic\.claudefordesktop\.plist' "$extract/.vite/build/index.chunk-DD6nxfJK.js"
}

@test "asar-patch: writes per-mirror plist with disableAutoUpdates=YES" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	local mirror_plist="$TARGET_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	# The per-mirror plist read by bXt()'s process.resourcesPath+"/..." append.
	# Its ONLY key must be disableAutoUpdates=true — that's the flatKey the
	# managed-config schema (index.chunk-DD6nxfJK.js: dZt.disabled) resolves.
	[ -f "$mirror_plist" ]
	local v
	v="$(/usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$mirror_plist")"
	[ "$v" = "true" ]
}

@test "asar-patch: Info.plist ElectronAsarIntegrity hash matches computed asar header hash" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	# Compute what Electron will compute at boot: SHA-256 of getRawHeader().headerString.
	local computed
	computed="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$TARGET_APP/Contents/Resources/app.asar');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	# What we wrote into Info.plist.
	local stored
	stored="$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$TARGET_APP/Contents/Info.plist")"
	# Mismatch here → Electron boot: FATAL:asar_util.cc:143 Integrity check failed.
	# The hash must not have DRIFTED from the original pristine (that would mean we forgot to rewrite it).
	[ "$computed" = "$stored" ]
	local pristine
	pristine="$(cat "$BATS_TEST_TMPDIR/fixture-hash")"
	[ "$stored" != "$pristine" ]
}

@test "asar-patch: idempotent — second refresh-clones produces the same asar hash + plist state" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	local hash1 plist1_hash mirror_plist1_hash
	hash1="$(shasum -a 256 "$TARGET_APP/Contents/Resources/app.asar" | awk '{print $1}')"
	plist1_hash="$(shasum -a 256 "$TARGET_APP/Contents/Info.plist" | awk '{print $1}')"
	mirror_plist1_hash="$(shasum -a 256 "$TARGET_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist" | awk '{print $1}')"

	# Re-run the patch (as WatchPaths would fire after a Squirrel-triggered refresh).
	run "$CMA" refresh-clones
	[ "$status" -eq 0 ]

	local hash2 plist2_hash mirror_plist2_hash
	hash2="$(shasum -a 256 "$TARGET_APP/Contents/Resources/app.asar" | awk '{print $1}')"
	plist2_hash="$(shasum -a 256 "$TARGET_APP/Contents/Info.plist" | awk '{print $1}')"
	mirror_plist2_hash="$(shasum -a 256 "$TARGET_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist" | awk '{print $1}')"

	# Every file must be bit-identical after the re-run — spurious drift here
	# would show up as bundle-id drift or codesign churn on every Squirrel update.
	[ "$hash1" = "$hash2" ]
	[ "$plist1_hash" = "$plist2_hash" ]
	[ "$mirror_plist1_hash" = "$mirror_plist2_hash" ]
}

@test "asar-patch: codesign --verify --deep passes on the patched clone" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	# Ad-hoc signature after the asar+plist rewrite must be internally consistent.
	# Any mismatch here means codesign ran BEFORE the asar patch (wrong order in
	# build-clone-app.sh) or PlistBuddy left the plist malformed.
	run codesign --verify --deep "$TARGET_APP"
	[ "$status" -eq 0 ]
}

@test "asar-patch: mirror-prefs plist has remoteControlAtStartup=YES (Managed-tier auto-enable — Chunk X-A Part 1c)" {
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	local mirror_plist="$TARGET_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	# The Managed-tier auto-enable route. SettingsResolver's j$n() iterates
	# tiers and picks up remoteControlAtStartup from the plist because it's a
	# top-level f.boolean().optional() field in the schema (index.chunk-DqiH2czz.js)
	# and thus appears in SXt()'s key list unpatched — no JS anchor patch
	# needed. The ONLY moving piece here is the plist carrying the extra key.
	[ -f "$mirror_plist" ]
	local v
	v="$(/usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$mirror_plist")"
	[ "$v" = "true" ]
	# `defaults read` is the same command an operator would use to sanity-check
	# the plist by hand — verifying it also surfaces the key proves the plist
	# is in a shape Electron's readPlistValue path can consume.
	local d
	d="$(defaults read "${mirror_plist%.plist}" remoteControlAtStartup 2>/dev/null)"
	[ "$d" = "1" ]
}

@test "asar-patch: mirror-prefs plist still has disableAutoUpdates=YES (belt-and-braces regression guard)" {
	# The remoteControlAtStartup addition must not disturb the disableAutoUpdates
	# insert already shipped in Chunk W. A regression here would resurface the
	# "Failed to check for updates" dialog on every mirror menu-click.
	setup_asar_fixture
	"$CMA" init
	"$CMA" add-instance "$LABEL" --email test-b@example.com
	local mirror_plist="$TARGET_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	local v
	v="$(/usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$mirror_plist")"
	[ "$v" = "true" ]
}

@test "asar-patch: fails loud when the bXt() anchor appears zero times (Claude Desktop internals moved)" {
	setup_asar_fixture
	# Corrupt the source asar so the anchor is missing. Rebuild it from a staging
	# tree that has NO anchor — the patch script must refuse rather than silently
	# ship an un-patched mirror.
	local staging="$BATS_TEST_TMPDIR/no-anchor-staging"
	mkdir -p "$staging/.vite/build"
	echo "// no bXt() here" >"$staging/.vite/build/index.chunk-DD6nxfJK.js"
	echo "// no bXt() here" >"$staging/.vite/build/index.pre.js"
	# shellcheck disable=SC2031 # CMA_SOURCE_CLAUDE_APP is set in setup()'s subshell + read here in this test's subshell
	rm -f "$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar"
	# shellcheck disable=SC2031 # same subshell inheritance as above
	node --input-type=module -e "
import { createPackageWithOptions, getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
await createPackageWithOptions('$staging', '$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar', { unpack: '{*.node,*.dylib,spawn-helper}' });
"
	# Rewrite Info.plist ElectronAsarIntegrity for the new hash so the fixture is otherwise valid.
	local new_hash
	# shellcheck disable=SC2031 # same subshell inheritance as above
	new_hash="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	# shellcheck disable=SC2031 # same subshell inheritance as above
	/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $new_hash" "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist"

	"$CMA" init
	run "$CMA" add-instance "$LABEL" --email test-b@example.com
	# add-instance must have failed loud because the patch script errored out.
	[ "$status" -ne 0 ]
	[[ "$output" == *"expected 1 occurrence of anchor"* ]]
}
