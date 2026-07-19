#!/usr/bin/env bats
# primary-patch.bats — primary-mode asar patch + UPDATE-SAFE re-sign tests.
#
# Primary mode patches /Applications/Claude.app in place with the propagation +
# rc-enforcer IIFEs + a managed-config plist route so the enforcer runs on the
# primary account's sessions too, then re-signs the bundle INSIDE-OUT, ad-hoc,
# with an EXPLICIT LOOSE Designated Requirement (no team pin, no cdhash). That
# loose DR is what keeps the primary Squirrel-updatable — an Anthropic-signed
# update satisfies it, so ShipIt applies updates while the app stays patched.
#
# Each assertion targets a specific piece of the primary-mode contract (Rule 9):
#
#   - Backups (app.asar + app.asar.unpacked) created on first patch → both
#     primary-unpatch has bytes to restore AND the incident where unpatch
#     deleted app.asar.unpacked (blanking the app) can never recur.
#   - primary plist omits disableAutoUpdates → primary keeps receiving updates.
#   - primary plist carries remoteControlAtStartup=true → RC auto-enable wired.
#   - Info.plist ElectronAsarIntegrity hash matches → no fatal-boot.
#   - Requirements file is EXACTLY the loose DR (NO Q6L2SF6YDW) → the update-
#     safety mechanism; a team-pin here would break Squirrel updates.
#   - Signing iterates nested components (NOT --deep) → --deep ad-hoc leaves
#     "nested code is modified or invalid"; inside-out is the fix.
#   - codesign --verify --strict passes with NO nested-code corruption.
#   - Unpatch restores app.asar.unpacked (a dummy .node survives) → the
#     native-module tree is never lost.
#   - primary-running guard matches the primary path but NOT a mirror
#     ("Claude Account B.app") path → refusal fires only on the real primary.

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

	# Fake /Applications/Claude.app under the scratch dir. primary-patch operates
	# on CMA_SOURCE_CLAUDE_APP; point it at the fixture. The fixture needs the
	# full .app shape (MacOS/ + Info.plist + Resources/app.asar) so codesign has
	# something to sign, plus the anchor JS packed into the asar AND a native
	# .node module so app.asar.unpacked is emitted (exercises the snapshot +
	# native-module survival paths).
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

	# Anchor JS bodies (bXt() + session-manager singleton) so the patch script's
	# anchor-count checks pass. Same shape as clone-app.bats.
	local staging="$BATS_TEST_TMPDIR/primary-asar-staging"
	mkdir -p "$staging/.vite/build"
	cat >"$staging/.vite/build/index.chunk-DD6nxfJK.js" <<'JS'
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	cat >"$staging/.vite/build/index.pre.js" <<'JS'
function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}
JS
	# Session-manager singleton chunk with propagation + rc-enforcer anchors.
	cat >"$staging/.vite/build/index.chunk-BpZff9Dw.js" <<'JS'
// Fake index.chunk-BpZff9Dw.js — carries the anchors the injectors look for.
class G {
	async handleRemoteControlCommand(e, r) { /* fake — real body lives elsewhere */ }
}
const hs = { fake: true };
exports.claudeCodeSessionManager=hs;
//# sourceMappingURL=index.chunk-BpZff9Dw.js.map
JS
	# A native module so the repack emits app.asar.unpacked/<...>.node. The
	# unpack glob is {*.node,*.dylib,spawn-helper}; @electron/asar matches
	# *.node at any depth, so this lands under app.asar.unpacked.
	mkdir -p "$staging/node_modules/@ant/claude-native"
	printf 'fake native module bytes\n' >"$staging/node_modules/@ant/claude-native/claude-native.node"

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

	# Info.plist with a real ElectronAsarIntegrity block. Identifier matches the
	# loose DR so the fixture re-sign presents the same DR production would.
	cat >"$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>        <string>com.anthropic.claudefordesktop</string>
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

@test "primary-patch: creates app.asar + app.asar.unpacked backups on first run" {
	local asar_backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	local unpacked_backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.unpacked.multiacct-backup"
	[ ! -e "$asar_backup" ]
	[ ! -e "$unpacked_backup" ]
	run "$CMA" primary-patch
	[ "$status" -eq 0 ]
	# Both snapshots captured before the patch mutated anything.
	[ -f "$asar_backup" ]
	[ -d "$unpacked_backup" ]
	# The unpacked backup holds the pristine native module.
	find "$unpacked_backup" -name '*.node' -print -quit | grep -q .
	# The asar backup matches the pristine header hash recorded in setup().
	local backup_hash
	backup_hash="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$asar_backup');
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

@test "primary-patch: patched bundle retains native .node modules under app.asar.unpacked" {
	# The whole incident this guards against: a patch that blanks the native
	# module tree. _asar_assert_primary_healthy fails loud if it's lost.
	"$CMA" primary-patch
	local unpacked="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.unpacked"
	[ -d "$unpacked" ]
	find "$unpacked" -name '*.node' -print -quit | grep -q .
}

@test "primary-patch: mirror-prefs plist has remoteControlAtStartup=true and NO disableAutoUpdates" {
	"$CMA" primary-patch
	local plist="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	[ -f "$plist" ]
	local rc
	rc="$(/usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$plist")"
	[ "$rc" = "true" ]
	# disableAutoUpdates ABSENT — PlistBuddy exits non-zero on a missing key.
	run ! /usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$plist"
}

@test "mirror mode WRITES disableAutoUpdates but primary mode OMITS it (same writer, mode-gated)" {
	# Directly exercise _asar_write_mirror_plist in both modes to prove the
	# mode gate. This is the update-safety pivot: the primary must keep Squirrel
	# enabled, the mirror must silence it.
	local mp="$BATS_TEST_TMPDIR/mirror-mode.plist"
	local pp="$BATS_TEST_TMPDIR/primary-mode.plist"
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_write_mirror_plist '$mp' mirror; _asar_write_mirror_plist '$pp' primary"
	[ "$status" -eq 0 ]
	# Mirror: disableAutoUpdates present + true.
	[ "$(/usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$mp")" = "true" ]
	# Primary: disableAutoUpdates absent.
	run ! /usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$pp"
	# Both carry remoteControlAtStartup=true.
	[ "$(/usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$mp")" = "true" ]
	[ "$(/usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$pp")" = "true" ]
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
	# And the stored hash CHANGED from pristine — proving the patch mutated it.
	[ "$stored" != "$PRIMARY_PRISTINE_HASH" ]
}

@test "requirements file is EXACTLY the loose DR (no team pin, no cdhash)" {
	# The crux of update-safety. _asar_write_dr_requirements must write the
	# anchor-apple-generic + identifier DR with NO Q6L2SF6YDW team pin and NO
	# cdhash — that's what an Anthropic-signed Squirrel update satisfies.
	local reqfile="$BATS_TEST_TMPDIR/dr.req"
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_write_dr_requirements '$reqfile'"
	[ "$status" -eq 0 ]
	local content
	content="$(cat "$reqfile")"
	[ "$content" = 'designated => anchor apple generic and identifier "com.anthropic.claudefordesktop"' ]
	# Explicit negatives — regression guards against re-introducing a pin.
	run ! grep -qF 'Q6L2SF6YDW' "$reqfile"
	run ! grep -qiF 'cdhash' "$reqfile"
	run ! grep -qF 'certificate leaf' "$reqfile"
}

@test "sign-targets order is INSIDE-OUT: nested helpers/frameworks first, outer app LAST" {
	# Build a bundle with nested Mach-O-bearing bundles under Frameworks/.
	local app="$BATS_TEST_TMPDIR/nested.app"
	mkdir -p "$app/Contents/Frameworks/Claude Helper.app"
	mkdir -p "$app/Contents/Frameworks/Claude Helper (Renderer).app"
	mkdir -p "$app/Contents/Frameworks/Electron Framework.framework"
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_primary_sign_targets '$app'"
	[ "$status" -eq 0 ]
	# The OUTER app must be the LAST line (its seal covers the already-signed
	# nested code). Nested bundles must appear BEFORE it.
	local last
	last="$(printf '%s\n' "$output" | tail -1)"
	[ "$last" = "$app" ]
	# Every nested bundle appears, and each before the outer app.
	printf '%s\n' "$output" | grep -qF 'Claude Helper.app'
	printf '%s\n' "$output" | grep -qF 'Claude Helper (Renderer).app'
	printf '%s\n' "$output" | grep -qF 'Electron Framework.framework'
	# Line count = 3 nested + 1 outer.
	[ "$(printf '%s\n' "$output" | grep -c .)" = "4" ]
}

@test "inside-out re-sign iterates each component with loose DR + runtime, NEVER --deep" {
	# Stub codesign to record every SIGNING invocation's argv. Extraction
	# (`codesign -d ...`) returns non-zero so the routine falls back to the
	# no-entitlements sign path. Assert: one sign per target, each with
	# --requirements + --options runtime, and NO --deep anywhere.
	local app="$BATS_TEST_TMPDIR/nested2.app"
	mkdir -p "$app/Contents/Frameworks/Claude Helper.app"
	mkdir -p "$app/Contents/Frameworks/Foo.framework"
	local capture="$BATS_TEST_TMPDIR/codesign-argv.log"
	local stub="$BATS_TEST_TMPDIR/codesign-stub"
	mkdir -p "$stub"
	cat >"$stub/codesign" <<STUB
#!/usr/bin/env bash
# -d is the entitlements/DR display path — fail so the caller uses the
# no-entitlements sign branch. --sign is the actual signing invocation —
# record the full argv, one line per call.
for a in "\$@"; do
	if [ "\$a" = "-d" ]; then exit 1; fi
done
printf '%s\n' "\$*" >>"$capture"
exit 0
STUB
	chmod +x "$stub/codesign"
	run bash -c "export PATH=\"$stub:\$PATH\"; source '$REPO/lib/asar-patch-clone.sh'; _asar_resign_primary_inside_out '$app'"
	[ "$status" -eq 0 ]
	[ -f "$capture" ]
	# One sign call per target: Helper.app + Foo.framework + outer app = 3.
	[ "$(grep -c . "$capture")" = "3" ]
	# Every sign call carries the loose-DR requirements file + runtime hardening.
	local n_req n_runtime n_deep
	n_req="$(grep -c -- '--requirements' "$capture")"
	n_runtime="$(grep -c -- '--options runtime' "$capture")"
	n_deep="$(grep -c -- '--deep' "$capture" || true)"
	[ "$n_req" = "3" ]
	[ "$n_runtime" = "3" ]
	# NEVER --deep — that's what left "nested code is modified or invalid".
	[ "$n_deep" = "0" ]
	# The outer app is signed LAST (last recorded line ends with the app path).
	local last
	last="$(tail -1 "$capture")"
	[[ "$last" == *"$app" ]]
}

@test "primary-patch: codesign --verify --strict passes with NO nested-code corruption" {
	"$CMA" primary-patch
	# The real (unstubbed) codesign must accept the inside-out ad-hoc signature.
	run codesign --verify --strict "$CMA_SOURCE_CLAUDE_APP"
	[ "$status" -eq 0 ]
	# And the DR must be the loose one, not an ad-hoc cdhash pin.
	run codesign -d -r- "$CMA_SOURCE_CLAUDE_APP"
	[[ "$output" == *'anchor apple generic and identifier "com.anthropic.claudefordesktop"'* ]]
	[[ "$output" != *"Q6L2SF6YDW"* ]]
}

@test "primary-patch: idempotent — second run leaves the backup bit-identical to first run" {
	"$CMA" primary-patch
	local backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	local backup1_hash
	backup1_hash="$(shasum -a 256 "$backup" | awk '{print $1}')"

	run "$CMA" primary-patch
	[ "$status" -eq 0 ]

	local backup2_hash
	backup2_hash="$(shasum -a 256 "$backup" | awk '{print $1}')"
	# Backup preserved (holds pristine bytes; a re-snapshot of the now-patched
	# asar would lose the pristine + break primary-unpatch).
	[ "$backup1_hash" = "$backup2_hash" ]
}

@test "primary-unpatch: restores app.asar AND app.asar.unpacked (native .node survives) + removes plist" {
	"$CMA" primary-patch
	local asar="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar"
	local unpacked="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.unpacked"
	local asar_backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.multiacct-backup"
	local unpacked_backup="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/app.asar.unpacked.multiacct-backup"
	local plist="$CMA_SOURCE_CLAUDE_APP/Contents/Resources/claude-multiacct-mirror-prefs.plist"
	[ -f "$asar_backup" ]
	[ -d "$unpacked_backup" ]
	[ -f "$plist" ]

	run "$CMA" primary-unpatch
	[ "$status" -eq 0 ]

	# asar restored to pristine bytes.
	local restored_hash
	restored_hash="$(node --input-type=module -e "
import { getRawHeader } from 'file://$CMA_ASAR_MODULE_DIR/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$asar');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
")"
	[ "$restored_hash" = "$PRIMARY_PRISTINE_HASH" ]
	# CRITICAL: app.asar.unpacked restored — the native .node module survives.
	# The old unpatch deleted app.asar.unpacked and blanked the app.
	[ -d "$unpacked" ]
	find "$unpacked" -name '*.node' -print -quit | grep -q .
	# Managed-config plist gone.
	[ ! -f "$plist" ]
	# Info.plist integrity hash back to pristine.
	local stored
	stored="$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist")"
	[ "$stored" = "$PRIMARY_PRISTINE_HASH" ]
	# Both backups consumed.
	[ ! -e "$asar_backup" ]
	[ ! -e "$unpacked_backup" ]
}

@test "primary-unpatch: fails loud when no backup exists" {
	run "$CMA" primary-unpatch
	[ "$status" -ne 0 ]
	[[ "$output" == *"no backup"* ]] || [[ "$output" == *"never patched"* ]]
}

@test "primary-patch: refuses to run while primary Claude Desktop is running" {
	# Stub `ps` so it emits a line matching the primary's MacOS/Claude exec
	# path — the guard then reports "running" and primary-patch refuses.
	local stub_dir
	stub_dir="$BATS_TEST_TMPDIR/ps-stub-running"
	mkdir -p "$stub_dir"
	cat >"$stub_dir/ps" <<SH
#!/usr/bin/env bash
printf 'COMMAND\n%s\n' "$CMA_SOURCE_CLAUDE_APP/Contents/MacOS/Claude"
SH
	chmod +x "$stub_dir/ps"
	PATH="$stub_dir:$PATH" run "$CMA" primary-patch
	[ "$status" -ne 0 ]
	[[ "$output" == *"primary Claude Desktop is running"* ]]
}

@test "primary-running guard matches the primary path but NOT a mirror 'Claude Account B.app' path" {
	# Pin the needle to the canonical primary path so the mirror line shares
	# the /Applications prefix — the meaningful exclusion test.
	local stub_dir="$BATS_TEST_TMPDIR/ps-guard"
	mkdir -p "$stub_dir"

	# Case 1: a running MIRROR only → guard must report NOT running.
	cat >"$stub_dir/ps" <<'SH'
#!/usr/bin/env bash
printf 'COMMAND\n'
printf '%s\n' "/Users/x/Applications/Claude Account B.app/Contents/MacOS/Claude.real --user-data-dir=/Users/x/Library/Application Support/Claude-B"
SH
	chmod +x "$stub_dir/ps"
	run bash -c "export PATH=\"$stub_dir:\$PATH\"; source '$REPO/lib/common.sh'; CMA_SOURCE_CLAUDE_APP='/Applications/Claude.app' cma_primary_claude_running"
	[ "$status" -ne 0 ]

	# Case 2: the real PRIMARY is running → guard must report running.
	cat >"$stub_dir/ps" <<'SH'
#!/usr/bin/env bash
printf 'COMMAND\n'
printf '%s\n' "/Applications/Claude.app/Contents/MacOS/Claude"
printf '%s\n' "/Users/x/Applications/Claude Account B.app/Contents/MacOS/Claude.real"
SH
	chmod +x "$stub_dir/ps"
	run bash -c "export PATH=\"$stub_dir:\$PATH\"; source '$REPO/lib/common.sh'; CMA_SOURCE_CLAUDE_APP='/Applications/Claude.app' cma_primary_claude_running"
	[ "$status" -eq 0 ]
}

@test "doctor reports primary drift before primary-patch runs" {
	"$CMA" init
	run "$CMA" doctor
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" == *"primary asar-patch backup MISSING"* ]]
	[[ "$output" == *"propagation IIFE MISSING"* ]]
	[[ "$output" == *"rc-enforcer IIFE MISSING"* ]]
}

@test "doctor reports primary healthy + update-capable AFTER primary-patch runs" {
	"$CMA" init
	"$CMA" primary-patch
	run "$CMA" doctor
	[ "$status" -eq 0 ] || [ "$status" -eq 1 ]
	[[ "$output" == *"primary asar-patch backup present"* ]]
	[[ "$output" == *"propagation IIFE injected"* ]]
	[[ "$output" == *"rc-enforcer IIFE injected"* ]]
	[[ "$output" == *"primary managed-config plist: remoteControlAtStartup=true"* ]]
	[[ "$output" == *"primary Info.plist ElectronAsarIntegrity hash matches on-disk asar"* ]]
	# The update-safety report line: presents the loose DR + is update-capable.
	[[ "$output" == *"LOOSE Designated Requirement"* ]]
	[[ "$output" == *"update-capable"* ]]
	# No primary drift slugs.
	[[ "$output" != *"primary-asar-patch-missing"* ]]
	[[ "$output" != *"primary-dr-not-loose"* ]]
	[[ "$output" != *"primary-plist-auto-updates-disabled"* ]]
}

# ── Content-based anchor discovery (survives esbuild's per-build chunk renames)
#
# esbuild renames its .vite/build chunks on EVERY Claude Desktop build, so the
# patch never hardcodes chunk filenames — it discovers targets by CONTENT.
# These tests build an extract tree with DELIBERATELY renamed chunks (names no
# hardcode could ever match) and drive the discovery + patch helpers directly:
#
#   - Route anchor discovery finds BOTH files carrying it, whatever they're
#     named — Intent: a chunk rename can't silently drop one of the two bXt()
#     route patches (which would leave one managed-config path unpatched).
#   - Singleton discovery finds THE chunk by content and the sourceMappingURL
#     insertion anchor is DERIVED from that chunk's own terminal line, not a
#     constant — Intent: the propagation + rc-enforcer IIFEs land in the right
#     file and keep the sourcemap link terminal after a rename.
#   - Adversarial: singleton marker in ZERO files, or in TWO files, must die
#     loud — Intent: a genuine internals change (module removed or split) must
#     never silently inject into the wrong site or ship dead code.

# Build a fresh .vite/build extract tree with caller-named chunks. Args:
#   $1 = extract root ; $2 = singleton chunk basename (or "" to skip it) ;
#   $3 = number of extra files that carry the route anchor (0..2) ;
#   $4 = "with-sourcemap" | "no-sourcemap" for the singleton chunk.
# The route anchor also lives inside the singleton chunk in production? No — in
# production it's separate files, so we keep them separate here too.
_mk_discovery_tree() {
	local root="$1" singleton="$2" n_route="$3" smap="$4"
	local build="$root/.vite/build"
	rm -rf "$root"
	mkdir -p "$build"
	# The bXt() route anchor body — the terminal join is followed by `]`, so the
	# OLD anchor `…plist")]` occurs exactly once (the earlier join ends `plist"),`).
	local anchor_body='function bXt(){return[Kt.join("/Library/Managed Preferences","com.anthropic.claudefordesktop.plist"),Kt.join("/Library/Managed Preferences",Lle.userInfo().username,"com.anthropic.claudefordesktop.plist")]}'
	# Deliberately alien names — no hardcode in lib/ could match these. Proper
	# `if` (not `[ ] && …`) so the helper always returns 0 even when a branch
	# is skipped (a trailing false `&&` would fail the caller under bats).
	if [ "$n_route" -ge 1 ]; then printf '%s\n' "$anchor_body" >"$build/index.chunk-ROUTE1renamed.js"; fi
	if [ "$n_route" -ge 2 ]; then printf '%s\n' "$anchor_body" >"$build/index.chunk-ROUTE2renamed.js"; fi
	if [ -n "$singleton" ]; then
		{
			printf '// %s — session-manager singleton chunk, alien name.\n' "$singleton"
			printf 'class G { async handleRemoteControlCommand(e, r) { } }\n'
			printf 'const hs = { fake: true };\n'
			printf 'exports.claudeCodeSessionManager=hs;\n'
			if [ "$smap" = "with-sourcemap" ]; then printf '//# sourceMappingURL=%s.map\n' "$singleton"; fi
		} >"$build/$singleton"
	fi
	return 0
}

@test "discovery: route-anchor grep finds BOTH renamed files by content (not by name)" {
	local extract="$BATS_TEST_TMPDIR/disc-route"
	_mk_discovery_tree "$extract" "index.chunk-ZZsingletonZZ.js" 2 with-sourcemap
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_grep_anchor_files '$extract' \"\$CMA_ASAR_ANCHOR_OLD\""
	[ "$status" -eq 0 ]
	# Both alien-named route files appear; neither is a hardcoded name.
	[[ "$output" == *".vite/build/index.chunk-ROUTE1renamed.js"* ]]
	[[ "$output" == *".vite/build/index.chunk-ROUTE2renamed.js"* ]]
	# The singleton chunk does NOT carry the route anchor, so it is NOT listed.
	[[ "$output" != *"ZZsingletonZZ"* ]]
	# Exactly two matches.
	[ "$(printf '%s\n' "$output" | grep -c .)" = "2" ]
}

@test "discovery: singleton locate finds the renamed chunk by content" {
	local extract="$BATS_TEST_TMPDIR/disc-single"
	_mk_discovery_tree "$extract" "index.chunk-ZZsingletonZZ.js" 2 with-sourcemap
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_locate_propagate_file '$extract'"
	[ "$status" -eq 0 ]
	[ "$output" = ".vite/build/index.chunk-ZZsingletonZZ.js" ]
}

@test "discovery: full patch+inject succeeds on renamed chunks, deriving the sourceMappingURL anchor" {
	local extract="$BATS_TEST_TMPDIR/disc-full"
	_mk_discovery_tree "$extract" "index.chunk-ZZsingletonZZ.js" 2 with-sourcemap
	local singleton="$extract/.vite/build/index.chunk-ZZsingletonZZ.js"
	run bash -c "
source '$REPO/lib/asar-patch-clone.sh'
_asar_apply_patches '$extract'
rel=\"\$(_asar_locate_propagate_file '$extract')\"
_asar_inject_session_propagation '$extract' \"\$rel\"
_asar_inject_rc_enforcer '$extract' \"\$rel\"
"
	[ "$status" -eq 0 ]
	# Route patch landed in BOTH renamed route files.
	grep -qF 'claude-multiacct-mirror-prefs.plist' "$extract/.vite/build/index.chunk-ROUTE1renamed.js"
	grep -qF 'claude-multiacct-mirror-prefs.plist' "$extract/.vite/build/index.chunk-ROUTE2renamed.js"
	# Both IIFEs landed in the discovered singleton chunk.
	grep -qF 'claude-multiacct-session-propagation' "$singleton"
	grep -qF 'claude-multiacct-rc-enforcer' "$singleton"
	# DERIVATION correctness: the chunk's OWN terminal sourceMappingURL line
	# (named after the ALIEN chunk basename) is still the LAST line — proving
	# both IIFEs were inserted ABOVE the derived anchor, not appended after it.
	local last
	last="$(tail -n 1 "$singleton")"
	[ "$last" = "//# sourceMappingURL=index.chunk-ZZsingletonZZ.js.map" ]
	# And the injected markers sit ABOVE that sourcemap line.
	local smap_line prop_line
	smap_line="$(grep -n 'sourceMappingURL' "$singleton" | tail -1 | cut -d: -f1)"
	prop_line="$(grep -n 'claude-multiacct-session-propagation' "$singleton" | head -1 | cut -d: -f1)"
	[ "$prop_line" -lt "$smap_line" ]
	# The result is still valid JS.
	node --check "$singleton"
}

@test "discovery: singleton chunk with NO sourceMappingURL line — IIFEs append at EOF, still valid JS" {
	local extract="$BATS_TEST_TMPDIR/disc-nosmap"
	_mk_discovery_tree "$extract" "index.chunk-ZZnosmapZZ.js" 2 no-sourcemap
	local singleton="$extract/.vite/build/index.chunk-ZZnosmapZZ.js"
	# Sanity: the fixture truly has no sourcemap line.
	run ! grep -qF 'sourceMappingURL' "$singleton"
	run bash -c "
source '$REPO/lib/asar-patch-clone.sh'
rel=\"\$(_asar_locate_propagate_file '$extract')\"
_asar_inject_session_propagation '$extract' \"\$rel\"
_asar_inject_rc_enforcer '$extract' \"\$rel\"
"
	[ "$status" -eq 0 ]
	grep -qF 'claude-multiacct-session-propagation' "$singleton"
	grep -qF 'claude-multiacct-rc-enforcer' "$singleton"
	# EOF-append path produces valid JS (fallback contract of step 3).
	node --check "$singleton"
}

@test "discovery: idempotent re-inject on renamed chunk leaves it bit-identical (single IIFE)" {
	local extract="$BATS_TEST_TMPDIR/disc-idem"
	_mk_discovery_tree "$extract" "index.chunk-ZZidemZZ.js" 2 with-sourcemap
	local singleton="$extract/.vite/build/index.chunk-ZZidemZZ.js"
	run bash -c "
source '$REPO/lib/asar-patch-clone.sh'
rel=\"\$(_asar_locate_propagate_file '$extract')\"
_asar_inject_session_propagation '$extract' \"\$rel\"
_asar_inject_rc_enforcer '$extract' \"\$rel\"
"
	[ "$status" -eq 0 ]
	local h1
	h1="$(shasum -a 256 "$singleton" | awk '{print $1}')"
	# Second pass must be a no-op (idempotency guard fires on the injected marker).
	run bash -c "
source '$REPO/lib/asar-patch-clone.sh'
rel=\"\$(_asar_locate_propagate_file '$extract')\"
_asar_inject_session_propagation '$extract' \"\$rel\"
_asar_inject_rc_enforcer '$extract' \"\$rel\"
"
	[ "$status" -eq 0 ]
	local h2
	h2="$(shasum -a 256 "$singleton" | awk '{print $1}')"
	[ "$h1" = "$h2" ]
	# Exactly one of each IIFE — a naive re-inject would double them. Count the
	# UNIQUE version marker (the rc-enforcer payload legitimately mentions its
	# own log-tag string on several lines, so the bare slug would over-count).
	[ "$(grep -cF '/* claude-multiacct-session-propagation v1 */' "$singleton")" = "1" ]
	[ "$(grep -cF '/* claude-multiacct-rc-enforcer v1 */' "$singleton")" = "1" ]
}

@test "discovery (adversarial): singleton marker in ZERO files makes the patch die loud" {
	local extract="$BATS_TEST_TMPDIR/disc-zero"
	# Route anchors present, but NO singleton chunk at all.
	_mk_discovery_tree "$extract" "" 2 with-sourcemap
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_locate_propagate_file '$extract'"
	[ "$status" -ne 0 ]
	[[ "$output" == *"found 0"* ]]
	[[ "$output" == *"internals changed"* ]]
}

@test "discovery (adversarial): singleton marker in TWO files makes the patch die loud" {
	local extract="$BATS_TEST_TMPDIR/disc-two"
	_mk_discovery_tree "$extract" "index.chunk-ZZoneZZ.js" 2 with-sourcemap
	# Plant a SECOND file carrying the singleton marker — an ambiguous split.
	cp "$extract/.vite/build/index.chunk-ZZoneZZ.js" "$extract/.vite/build/index.chunk-ZZtwoZZ.js"
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_locate_propagate_file '$extract'"
	[ "$status" -ne 0 ]
	[[ "$output" == *"found 2"* ]]
	[[ "$output" == *"internals changed"* ]]
}

@test "discovery (adversarial): route anchor in ZERO files makes _asar_apply_patches die loud" {
	local extract="$BATS_TEST_TMPDIR/disc-noroute"
	# A singleton chunk exists, but NO file carries the bXt() route anchor.
	_mk_discovery_tree "$extract" "index.chunk-ZZsingletonZZ.js" 0 with-sourcemap
	run bash -c "source '$REPO/lib/asar-patch-clone.sh'; _asar_apply_patches '$extract'"
	[ "$status" -ne 0 ]
	[[ "$output" == *"route anchor not found"* ]]
}
