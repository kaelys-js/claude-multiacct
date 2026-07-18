#!/usr/bin/env bats
# primary-patch.bats — Chunk Y primary-mode asar patch tests.
#
# Chunk Y patches /Applications/Claude.app in place with the propagation +
# rc-enforcer IIFEs + a managed-config plist route so the enforcer runs on
# the primary account's sessions too. Unlike the mirror-mode patch, the
# primary MUST stay Squirrel-updated — the plist deliberately omits
# `disableAutoUpdates`. And unlike mirrors, we need a way to restore the
# pristine asar bytes for `primary-unpatch` and the launchd Squirrel-refresh.
#
# Each assertion below targets a specific piece of the primary-mode contract
# per Rule 9:
#
#   - Backup file created on first patch                → primary-unpatch
#     has bytes to restore + Squirrel-refresh has a sentinel to detect
#     "fresh Squirrel pristine, replace me".
#   - Backup preserved across idempotent re-patch       → the second patch
#     doesn't corrupt the backup by re-snapshotting the ALREADY-PATCHED asar.
#   - primary plist omits disableAutoUpdates            → primary keeps
#     receiving Squirrel updates.
#   - primary plist carries remoteControlAtStartup=true → Managed-tier
#     auto-enable route is wired for the primary too.
#   - Info.plist ElectronAsarIntegrity hash matches     → primary doesn't
#     fatal-boot on the next launch.
#   - Codesign verifies on the patched primary          → macOS Gatekeeper's
#     LaunchServices path accepts the ad-hoc bundle.
#   - Unpatch restores byte-identical asar              → primary is back
#     to Anthropic's pristine bytes (Apple signature not restored — that's
#     an accepted Rule 12 disclosure).
#   - Unpatch removes the managed-config plist          → no lingering
#     multiacct-owned files after unpatch.
#   - `primary-patch` idempotent (re-runs are no-ops)   → launchd Squirrel-
#     refresh firing repeatedly doesn't churn.
#   - `primary-patch` refuses running primary           → codesign vs. mmap
#     race would corrupt a live bundle.

bats_require_minimum_version 1.5.0

setup() {
	REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
	export REPO
	export CMA="$REPO/bin/claude-multiacct"

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

	# Fake /Applications/Claude.app under the scratch dir. `primary-patch`
	# operates on CMA_SOURCE_CLAUDE_APP; we point it at the fixture. The
	# fixture needs the full .app shape (MacOS/ + Info.plist + Resources/
	# app.asar) so codesign has something to sign, plus the anchor JS bodies
	# packed into the asar so the patch script sees the same shapes it does
	# in production.
	export CMA_SOURCE_CLAUDE_APP="$BATS_TEST_TMPDIR/fake-claude.app"
	mkdir -p "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS"
	mkdir -p "$CMA_SOURCE_CLAUDE_APP/Contents/Resources"

	# Locate @electron/asar. Same probe as clone-app.bats.
	local real_home_glob="/Users/*/.local/share/mise/installs/npm-electron-asar/*/lib/node_modules/@electron/asar"
	local d
	# shellcheck disable=SC2086 # deliberate glob expansion
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

	# Anchor JS bodies (bXt() + session-manager singleton) so the patch
	# script's anchor-count checks pass. Same shape as clone-app.bats.
	local staging="$BATS_TEST_TMPDIR/primary-asar-staging"
	mkdir -p "$staging/.vite/build"
	cat >"$staging/.vite/build/index.chunk-DD6nxfJK.js" <<'JS'
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	cat >"$staging/.vite/build/index.pre.js" <<'JS'
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	# Session-manager singleton chunk with propagation + rc-enforcer anchors.
	# `handleRemoteControlCommand` present → rc-enforcer method-marker check
	# passes.
	cat >"$staging/.vite/build/index.chunk-BpZff9Dw.js" <<'JS'
// Fake index.chunk-BpZff9Dw.js — carries the anchors the injectors look for.
class G {
	async handleRemoteControlCommand(e, r) { /* fake — real body lives elsewhere */ }
}
const hs = { fake: true };
exports.claudeCodeSessionManager=hs;
//# sourceMappingURL=index.chunk-BpZff9Dw.js.map
JS
	local orig_asar="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar"
	rm -f "$orig_asar"
	node --input-type=module -e "
import { createPackageWithOptions, getRawHeader } from 'file://$mod_dir/lib/asar.js';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
await createPackageWithOptions('$staging', '$orig_asar', { unpack: '{*.node,*.dylib,spawn-helper}' });
const raw = getRawHeader('$orig_asar');
const h = createHash('sha256').update(raw.headerString).digest('hex');
writeFileSync('$BATS_TEST_TMPDIR/primary-fixture-hash', h);
"
	local pristine_hash
	pristine_hash="$(cat "$BATS_TEST_TMPDIR/primary-fixture-hash")"
	export PRIMARY_PRISTINE_HASH="$pristine_hash"

	# Info.plist with a real ElectronAsarIntegrity block.
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
			<key>hash</key><string>${pristine_hash}</string>
		</dict>
	</dict>
</dict>
</plist>
PLIST
	# Minimal MacOS/Claude so the .app shape is complete enough for codesign.
	cat >"$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude" <<'BIN'
#!/usr/bin/env bash
echo "fake claude"
BIN
	chmod +x "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude"
}

@test "primary-patch: creates the app.asar backup on first run" {
	local backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	[ ! -f "$backup" ]
	# `primary-patch` is a CLI-level command that also fires cma_ensure_setting_bool
	# on the primary config-dir. Run it directly against the fixture.
	run "$CMA" primary-patch
	[ "$status" -eq 0 ]
	# Backup was captured before the patch. Bytes must match the pristine
	# hash we recorded in setup().
	[ -f "$backup" ]
	local backup_hash
	backup_hash="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$backup');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	[ "$backup_hash" = "$PRIMARY_PRISTINE_HASH" ]
}

@test "primary-patch: markers byte-visible in patched asar (propagation + rc-enforcer)" {
	"$CMA" primary-patch
	local asar="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar"
	grep -qF 'claude-multiacct-mirror-prefs.plist' "$asar"
	grep -qF 'claude-multiacct-session-propagation' "$asar"
	grep -qF 'claude-multiacct-rc-enforcer' "$asar"
}

@test "primary-patch: mirror-prefs plist has remoteControlAtStartup=true and NO disableAutoUpdates" {
	"$CMA" primary-patch
	local plist="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	[ -f "$plist" ]
	# remoteControlAtStartup present + true.
	local rc
	rc="$(/usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$plist")"
	[ "$rc" = "true" ]
	# disableAutoUpdates ABSENT — PlistBuddy exits non-zero on missing key.
	# `run !` semantics require bats 1.5+ (declared at top of file).
	run ! /usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$plist"
}

@test "primary-patch: Info.plist ElectronAsarIntegrity hash matches computed patched asar hash" {
	"$CMA" primary-patch
	local computed
	computed="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	local stored
	stored="$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist")"
	[ "$computed" = "$stored" ]
	# And the stored hash CHANGED from the pristine one — proving the patch
	# actually mutated the archive.
	[ "$stored" != "$PRIMARY_PRISTINE_HASH" ]
}

@test "primary-patch: codesign --verify --deep passes on the patched primary" {
	"$CMA" primary-patch
	run codesign --verify --deep "$CMA_SOURCE_CLAUDE_APP"
	[ "$status" -eq 0 ]
}

@test "primary-patch: idempotent — second run leaves the backup bit-identical to first run" {
	"$CMA" primary-patch
	local backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	local backup1_hash
	backup1_hash="$(shasum -a 256 "$backup" | awk '{print $1}')"
	local asar1_hash
	asar1_hash="$(shasum -a 256 "$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar" | awk '{print $1}')"

	# Second patch — must NOT re-capture the (now-patched) asar as the backup.
	run "$CMA" primary-patch
	[ "$status" -eq 0 ]

	local backup2_hash asar2_hash
	backup2_hash="$(shasum -a 256 "$backup" | awk '{print $1}')"
	asar2_hash="$(shasum -a 256 "$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar" | awk '{print $1}')"
	# Load-bearing: backup preserved (holds pristine bytes; a re-snapshot
	# here would lose the pristine + break primary-unpatch).
	[ "$backup1_hash" = "$backup2_hash" ]
	# And the patched asar is bit-identical (both idempotency shape from
	# the mirror asar tests + a defense against codesign churn).
	[ "$asar1_hash" = "$asar2_hash" ]
}

@test "primary-unpatch: restores byte-identical pristine asar + removes plist" {
	"$CMA" primary-patch
	local asar="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar"
	local backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	local plist="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	[ -f "$backup" ]
	[ -f "$plist" ]
	# Snapshot the pristine header hash we know is under $backup right now.
	local pristine_hash_from_backup
	pristine_hash_from_backup="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$backup');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	[ "$pristine_hash_from_backup" = "$PRIMARY_PRISTINE_HASH" ]

	run "$CMA" primary-unpatch
	[ "$status" -eq 0 ]
	# The asar bytes must now match the pristine we captured pre-patch.
	local restored_hash
	restored_hash="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$asar');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	[ "$restored_hash" = "$PRIMARY_PRISTINE_HASH" ]
	# Managed-config plist gone.
	[ ! -f "$plist" ]
	# Info.plist integrity hash updated to match the restored pristine.
	local stored
	stored="$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist")"
	[ "$stored" = "$PRIMARY_PRISTINE_HASH" ]
	# Backup itself consumed (moved back into place, not copied).
	[ ! -f "$backup" ]
}

@test "primary-unpatch: fails loud when no backup exists" {
	# Skip the primary-patch step — no backup on disk.
	run "$CMA" primary-unpatch
	[ "$status" -ne 0 ]
	[[ "$output" == *"no backup"* ]] || [[ "$output" == *"never patched"* ]]
}

@test "primary-patch: refuses to run while primary Claude Desktop is running" {
	# `cma_primary_claude_running` uses `ps -A -o command` + grep. Stub `ps` so
	# it emits a line matching `<CMA_SOURCE_CLAUDE_APP>/Contents/MacOS/Claude`
	# — the guard then reports "running" and primary-patch refuses.
	local stub_dir
	stub_dir="$BATS_TEST_TMPDIR/ps-stub-running"
	mkdir -p "$stub_dir"
	cat >"$stub_dir/ps" <<SH
#!/usr/bin/env bash
# Emit a header + one line matching the pattern cma_primary_claude_running
# looks for. Any additional arg forms passed to ps get ignored here — the
# predicate only calls \`ps -A -o command\`.
printf 'COMMAND\n%s\n' "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude"
SH
	chmod +x "$stub_dir/ps"
	PATH="$stub_dir:$PATH" run "$CMA" primary-patch
	[ "$status" -ne 0 ]
	[[ "$output" == *"primary Claude Desktop is running"* ]]
}

@test "doctor reports primary-asar-patch-missing before primary-patch runs" {
	# Pre-patch: doctor's check_primary MUST flag the missing backup + missing
	# markers as issues on the primary row.
	"$CMA" init
	run "$CMA" doctor
	# Doctor exits 0 even when it surfaces drift.
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" == *"primary asar-patch backup MISSING"* ]] ||
		[[ "$output" == *"primary-asar-patch-missing"* ]]
	[[ "$output" == *"propagation IIFE MISSING"* ]] ||
		[[ "$output" == *"primary-asar-propagation-missing"* ]]
	[[ "$output" == *"rc-enforcer IIFE MISSING"* ]] ||
		[[ "$output" == *"primary-rc-enforcer-missing"* ]]
}

@test "doctor reports primary healthy AFTER primary-patch runs" {
	"$CMA" init
	"$CMA" primary-patch
	run "$CMA" doctor
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	# All three markers must be present.
	[[ "$output" == *"primary asar-patch backup present"* ]]
	[[ "$output" == *"propagation IIFE injected"* ]]
	[[ "$output" == *"rc-enforcer IIFE injected"* ]]
	# Managed-config plist reports remoteControlAtStartup=true.
	[[ "$output" == *"primary managed-config plist: remoteControlAtStartup=true"* ]]
	# And primary Info.plist integrity hash matches on-disk asar.
	[[ "$output" == *"primary Info.plist ElectronAsarIntegrity hash matches on-disk asar"* ]]
	# No known primary-* issue slugs surfacing in the report.
	[[ "$output" != *"primary-asar-patch-missing"* ]]
	[[ "$output" != *"primary-asar-propagation-missing"* ]]
	[[ "$output" != *"primary-rc-enforcer-missing"* ]]
	[[ "$output" != *"primary-asar-integrity-drift"* ]]
	[[ "$output" != *"primary-plist-auto-updates-disabled"* ]]
}
