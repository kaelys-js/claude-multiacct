#!/usr/bin/env bash
# lib/asar-patch-clone.sh — patch a Claude Desktop bundle's app.asar so the
# managed-config reader picks up a per-bundle plist AND so runtime IIFEs
# inject session-propagation (Chunk X-B) + Remote-Control enforcement
# (Chunk Y) — plus, in mirror mode, so Squirrel treats the bundle as
# "auto-updates disabled by admin" instead of firing an update check that
# fails Designated-Requirement verification against a bundle Anthropic didn't
# sign.
#
# Modes (--mode):
#   - mirror (default) — per-instance mirror clone (invoked by
#                        build-clone-app.sh). Writes `disableAutoUpdates=YES`
#                        into the per-bundle plist so Squirrel is silenced (a
#                        mirror is not Anthropic-signed; an update check would
#                        fail DR verification). build-clone-app.sh ad-hoc
#                        re-signs the whole clone afterwards.
#   - primary          — the primary /Applications/Claude.app, patched IN
#                        PLACE and re-signed UPDATE-SAFELY (see below). OMITS
#                        `disableAutoUpdates` from the plist so Squirrel keeps
#                        running and applying upstream updates.
#
# UPDATE-SAFE primary re-sign (the mechanism, empirically validated on-device):
#   Squirrel/ShipIt validates a downloaded update against the RUNNING app's
#   Designated Requirement (DR). The stock DR pins Anthropic's team
#   (Q6L2SF6YDW). An ad-hoc cdhash DR (the old broken behaviour, `codesign
#   --sign -` with no explicit requirement) makes the DR a per-build cdhash
#   pin — an Anthropic-signed update no longer satisfies it, so Squirrel
#   refuses to apply updates and the primary froze.
#
#   The fix: re-sign with an EXPLICIT LOOSE DR that has NO team pin:
#       designated => anchor apple generic and identifier "com.anthropic.claudefordesktop"
#   An Anthropic-signed update (Developer ID, anchor apple generic, same
#   identifier) SATISFIES that DR, so `codesign --verify -R <dr>` returns 0 and
#   Squirrel applies the update while the patched app keeps running. Ad-hoc
#   signing (`--sign -`) can set this DR with no cert.
#
#   CAVEAT: `codesign --deep` ad-hoc leaves "nested code is modified or
#   invalid". We therefore sign INSIDE-OUT — each nested Mach-O bundle
#   (Squirrel/Electron frameworks, every Helper .app incl. (Renderer)/(GPU)/
#   (Plugin)) first, then the outer app LAST — each with `--options runtime`,
#   the loose DR via `--requirements`, and its own preserved entitlements.
#   NOT `--deep`. See _asar_resign_primary_inside_out below.
#
# SCOPE: mirror mode is invoked by build-clone-app.sh on every clone build.
# Primary mode is invoked only via `claude-multiacct primary-patch` (+ the
# primary-patch-refresh launchd agent after each Squirrel update). Rule 12
# disclosure: primary mode replaces Anthropic's Developer ID signature with an
# ad-hoc loose-DR one — the app stays update-capable (its DR is satisfied by
# any anchor-apple-generic + identifier build), and each Squirrel drop restores
# a fresh Anthropic-signed bundle which the refresh agent then re-patches.
#
# The mechanism (design docs/architecture.md):
#   1. Claude Desktop's managed-config reader iterates a list of plist paths
#      (bXt() in the bundled JS) looking for `disableAutoUpdates=YES` etc.
#      The pristine list is:
#        /Library/Managed Preferences/com.anthropic.claudefordesktop.plist
#        /Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist
#      Both are MDM-owned and empty on a personal Mac.
#   2. We APPEND process.resourcesPath+"/claude-multiacct-mirror-prefs.plist"
#      to that list AND write a per-bundle plist at
#      <bundle>/Contents/Resources/claude-multiacct-mirror-prefs.plist with
#      `remoteControlAtStartup=YES` (always) and `disableAutoUpdates=YES`
#      (mirror-only — the primary MUST stay Squirrel-updated to keep pace
#      with upstream). Claude then reads the flags via its Managed-tier
#      reader; on mirrors:
#        - i_t() short-circuits: "[updater] Auto-updates disabled by
#          enterprise policy" log line, no network call.
#        - NRn() menu builder sees `Oe().autoUpdate.disabled=true` and
#          disables the "Check for Updates…" item with sublabel "Updates
#          disabled by admin". The old "Failed to check for updates" dialog
#          is never reachable.
#   3. Inject the Chunk X-B session-propagation IIFE into
#      `.vite/build/index.chunk-BpZff9Dw.js` so cross-process mutations of
#      the shared session store fire `hs.emitSessionUpdated` on this
#      instance's LocalSessionManager singleton — sidebar reflects mirror /
#      primary edits without a quit + relaunch. See
#      lib/asar-session-propagation.inject.js for the full contract.
#   4. Inject the Chunk Y Remote-Control enforcer IIFE into the SAME chunk
#      so any non-archived session that drifts to `remoteControlEnabled:
#      false` gets re-flipped via `hs.handleRemoteControlCommand(session,
#      {auto:true})` on a 15-second poll. See
#      lib/asar-remote-control-enforcer.inject.js for the full contract.
#   5. Repack asar, recompute the SHA-256 of `getRawHeader().headerString`,
#      write it into <bundle>/Contents/Info.plist under
#      ElectronAsarIntegrity.Resources/app.asar.hash. Electron verifies this
#      hash at boot (electron/asar_util.cc:143) and refuses to boot with
#      "FATAL:asar_util.cc:143 Integrity check failed" on any mismatch.
#
# Idempotent: if the extracted files already contain the patched-in string,
# we re-derive the patched anchor (locates the neighbouring pristine text and
# re-applies the append) so repeated runs produce the same on-disk bytes.
#
# Fail-loud (Rule 12): every step returns non-zero on any error. On a bare
# `set -e` failure inside main() the caller (build-clone-app.sh) rolls back
# by rm -rf'ing the half-written clone.
#
# Usage:
#   asar-patch-clone.sh <label> <appBundle>              # mirror (default)
#   asar-patch-clone.sh --mode=mirror  <label> <appBundle>
#   asar-patch-clone.sh --mode=primary primary <appBundle>
#   asar-patch-clone.sh --mode=primary --unpatch primary <appBundle>

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# bXt() route anchor patched inside app.asar. esbuild renames its output
# chunks on EVERY Claude build (e.g. index.chunk-DD6nxfJK.js → -rKZpGjtP.js),
# so we NEVER hardcode chunk filenames — we DISCOVER at patch-time which
# .vite/build/*.js files carry the anchor CONTENT (see _asar_grep_anchor_files
# + _asar_apply_patches). The route anchor legitimately lives in TWO files
# (an eager index.pre.js and a lazy chunk); both get the append. The OLD
# anchor's terminal `)]` array-close is consumed by the append, so a patched
# file no longer contains CMA_ASAR_ANCHOR_OLD — that's what makes discovery-by-
# OLD find only the still-pristine files and skip already-patched ones.
CMA_ASAR_ANCHOR_OLD='"com.anthropic.claudefordesktop.plist")]'
CMA_ASAR_ANCHOR_NEW='"com.anthropic.claudefordesktop.plist"),process.resourcesPath+"/claude-multiacct-mirror-prefs.plist"]'
# The marker the append leaves behind — used both as the idempotent "already
# patched" signal per file and (in discovery) to tell a genuinely-changed
# layout (die) from an already-patched rerun (no-op).
CMA_ASAR_PATCHED_MARKER='claude-multiacct-mirror-prefs.plist'

# Path inside the clone where the per-mirror managed-prefs plist lives. Read
# by the bXt() append via `process.resourcesPath+"/..."`.
CMA_MIRROR_PLIST_BASENAME="claude-multiacct-mirror-prefs.plist"

# ── Primary update-safe re-sign (loose DR) ─────────────────────────────────
#
# The EXACT Designated Requirement text written to the requirements file and
# passed to `codesign --requirements`. It pins ONLY Anthropic's bundle
# identifier under an Apple-anchored generic chain — NO team-id (Q6L2SF6YDW)
# and NO cdhash. An Anthropic-signed Squirrel update (Developer ID: anchor
# apple generic, identifier com.anthropic.claudefordesktop) SATISFIES this DR,
# so `codesign --verify -R` returns 0 against the update and ShipIt applies it.
# This string is asserted verbatim by tests/primary-patch.bats — do NOT add a
# team pin or a cdhash here or update-capability is lost.
CMA_PRIMARY_LOOSE_DR='designated => anchor apple generic and identifier "com.anthropic.claudefordesktop"'

# Primary-mode pristine snapshots. The FULL patch surface Squirrel restores to
# pristine on an update is app.asar + app.asar.unpacked (the native-module
# tree Electron dlopens .node from). unpatch MUST restore BOTH — restoring
# only app.asar (the old broken behaviour) deleted app.asar.unpacked and
# blanked the app. Both live under Contents/Resources next to the originals.
CMA_PRIMARY_ASAR_BACKUP="app.asar.multiacct-backup"
CMA_PRIMARY_UNPACKED_BACKUP="app.asar.unpacked.multiacct-backup"

# ── Session-propagation anchor (Chunk X-B) ────────────────────────────────
#
# In addition to the bXt() route anchor above we ALSO inject a self-contained
# IIFE into the chunk that instantiates the LocalSessionManager singleton
# (`hs = new vt(o.CCD_SESSIONS_BASE_DIR)`) and re-exports it as
# `exports.claudeCodeSessionManager`. That chunk's filename churns every build
# (was index.chunk-BpZff9Dw.js, now index.chunk-BpE94K1E.js, …), so we DISCOVER
# it by content via _asar_locate_propagate_file: the ONE .vite/build/*.js file
# carrying CMA_ASAR_PROPAGATE_SINGLETON_MARKER. Zero or many matches fail loud.
# The injection sets up an fs.watch on the mirror's claude-code-sessions
# storage dir; on any cross-process file mutation (primary or peer mirrors
# writing through the Layer-2 symlink) it rescans the changed files, updates
# the in-memory Map, and calls `hs.emitSessionUpdated(sessionId)` — the SAME
# emit path the manager uses for its own mutations, so every renderer
# subscription (sidebar included) updates without a process restart. See
# docs/architecture.md § "Real-time session-state propagation" for the trace.
#
# Anchor markers:
#   - CMA_ASAR_PROPAGATE_SINGLETON_MARKER: the exact string that identifies the
#     target chunk (discovery key) AND must be present exactly once pre-inject.
#   - CMA_ASAR_PROPAGATE_INJECTED_MARKER: the on-disk sentinel that both doctor
#     (grep) and the injector's idempotency check look for post-inject.
# The sourceMappingURL insertion anchor is NOT a constant — esbuild names it
# after the chunk's own basename, so both injectors DERIVE it at inject-time
# from the discovered file's terminal `//# sourceMappingURL=…` line (falling
# back to an EOF append when the file has no sourcemap line).
CMA_ASAR_PROPAGATE_SINGLETON_MARKER='exports.claudeCodeSessionManager=hs;'
CMA_ASAR_PROPAGATE_INJECTED_MARKER='/* claude-multiacct-session-propagation v1 */'

# ── Remote-Control enforcer anchor (Chunk Y) ──────────────────────────────
#
# The enforcer IIFE goes into the SAME chunk as the propagation IIFE (both
# close over the LocalSessionManager singleton `hs`). It calls
# `hs.handleRemoteControlCommand(session, {auto:true})` on every non-archived
# session whose `remoteControlEnabled` drifts to false — see
# lib/asar-remote-control-enforcer.inject.js for the runtime contract.
#
# Anchor invariants (all fail loud on drift):
#   - CMA_ASAR_ENFORCER_METHOD_MARKER: the runtime method the enforcer calls
#     into. Must occur AT LEAST ONCE in the chunk (the method definition +
#     any call sites). Absence would mean the enforcer can't fire at runtime
#     — so we refuse to inject a payload that would ship dead code.
#   - CMA_ASAR_ENFORCER_INJECTED_MARKER: the on-disk sentinel that both
#     `grep -F` (doctor) and the injector itself (idempotency check) look
#     for. MUST NOT be present on a pristine chunk.
CMA_ASAR_ENFORCER_METHOD_MARKER='handleRemoteControlCommand'
CMA_ASAR_ENFORCER_INJECTED_MARKER='/* claude-multiacct-rc-enforcer v1 */'

# @electron/asar module path. Layered lookup so hermetic bats tests (which
# run under a scratch $HOME with no mise install) can still find the module
# from the developer's real HOME:
#   1. Explicit CMA_ASAR_MODULE_DIR override — used by bats setup().
#   2. Current $HOME (canonical: mise installs npm:@electron/asar under
#      $HOME/.local/share/mise/installs/npm-electron-asar/<ver>/lib/node_modules/@electron/asar).
#   3. `mise where npm:@electron/asar` — mise's own lookup, works whether
#      the current $HOME matches the install $HOME or not.
_asar_module_dir() {
  if [[ -n "${CMA_ASAR_MODULE_DIR:-}" ]]; then
    [[ -d "$CMA_ASAR_MODULE_DIR" ]] || return 1
    printf '%s\n' "$CMA_ASAR_MODULE_DIR"
    return 0
  fi
  local d
  for d in "$HOME/.local/share/mise/installs/npm-electron-asar/"*"/lib/node_modules/@electron/asar" \
    "$HOME/.local/share/mise/installs/npm-electron-asar/"*"/node_modules/@electron/asar"; do
    [[ -d "$d" ]] && {
      printf '%s\n' "$d"
      return 0
    }
  done
  # Fall through to mise's own lookup — resolves the install dir even under
  # a scratch $HOME (bats setup()) provided mise itself is on PATH.
  if command -v mise > /dev/null 2>&1; then
    local base
    base="$(mise where npm:@electron/asar 2> /dev/null || true)"
    if [[ -n "$base" ]]; then
      for d in "$base/lib/node_modules/@electron/asar" "$base/node_modules/@electron/asar"; do
        [[ -d "$d" ]] && {
          printf '%s\n' "$d"
          return 0
        }
      done
    fi
  fi
  return 1
}

# Extract /Applications/Claude.app's app.asar into $extract_dir. Emits stderr
# but returns silently on success — the caller composes the report line.
#
# @electron/asar 4.x is a pure-ESM package (`"type": "module"` + `exports`),
# so `require()` from an inline `node -e` throws ERR_REQUIRE_ESM. We use
# `node --input-type=module` + dynamic `import()` of a file:// URL for the
# module directory — that resolves package.json's "exports" field and gives
# us the same `asar` object `require()` used to return in 3.x.
_asar_extract() {
  local src_asar="$1" extract_dir="$2" mod_dir="$3"
  [[ -f "$src_asar" ]] || cma_die "asar-patch: source app.asar missing at $src_asar"
  mkdir -p "$extract_dir"
  # Wipe any prior extraction (idempotent path used by repeated refresh-clones).
  rm -rf "${extract_dir:?}"/{*,.*} 2> /dev/null || true
  node --input-type=module -e "
import { extractAll } from 'file://$mod_dir/lib/asar.js';
extractAll('$src_asar', '$extract_dir');
" || cma_die "asar-patch: extractAll failed for $src_asar → $extract_dir"
}

# Print, one per line (relative to $extract_dir), each .vite/build/*.js file
# whose CONTENT contains the literal $marker. This is the single primitive all
# content-based anchor discovery routes through, so a chunk-name churn in a
# future Claude Desktop build never breaks the patch — only a CONTENT change
# does (which we then fail loud on). Restricted to *.js (esbuild's build
# output) so a marker that also appears inside a sibling .map file's embedded
# sourcesContent can't produce a phantom match. Sorted for deterministic
# ordering across runs. grep -F = fixed-string (our markers carry regex
# metacharacters like `[` `]` `(` `)` `.`); the per-file grep -q keeps this
# working on bash 3.2 without process substitution quirks.
_asar_grep_anchor_files() {
  local extract_dir="$1" marker="$2"
  local build_dir="$extract_dir/.vite/build"
  [[ -d "$build_dir" ]] || return 0
  local f
  while IFS= read -r f; do
    if grep -qF -- "$marker" "$f" 2> /dev/null; then
      printf '%s\n' "${f#"$extract_dir"/}"
    fi
  done < <(find "$build_dir" -type f -name '*.js' 2> /dev/null | sort)
}

# Discover THE single .vite/build/*.js chunk that re-exports the
# LocalSessionManager singleton (`exports.claudeCodeSessionManager=hs;`) and
# print its path relative to $extract_dir. Both the session-propagation IIFE
# and the rc-enforcer IIFE inject into THIS chunk (the enforcer's method marker
# lives here too — asserted at inject-time). Exactly one match is expected:
# zero means Claude Desktop restructured the session-manager module (die), more
# than one means it got split and we'd need to re-anchor on a specific site
# (die). NOTE: this replaces the never-existed `_asar_locate_propagate_file`
# the old CMA_ASAR_PROPAGATE_FILE comment referenced — now it is real.
_asar_locate_propagate_file() {
  local extract_dir="$1"
  local found count
  found="$(_asar_grep_anchor_files "$extract_dir" "$CMA_ASAR_PROPAGATE_SINGLETON_MARKER")"
  count="$(printf '%s' "$found" | grep -c . || true)"
  if [[ "$count" != "1" ]]; then
    cma_die "asar-patch: expected exactly 1 .vite/build/*.js file carrying the session-manager singleton marker ('$CMA_ASAR_PROPAGATE_SINGLETON_MARKER'), found $count (Claude Desktop internals changed — re-anchor)"
  fi
  printf '%s\n' "$found"
}

# Apply the bXt() route append to every discovered anchor file. esbuild renames
# its chunks every build, so we DISCOVER the target files by content
# (_asar_grep_anchor_files) rather than by hardcoded name. The route anchor
# legitimately lives in TWO files (the eager index.pre.js + one lazy chunk);
# both get the append. Fail-loud contract: if the anchor content is present in
# NEITHER its pristine (OLD) NOR its already-patched form, Claude Desktop's
# internals changed — die. Idempotent: the append consumes the OLD anchor's
# terminal `)]`, so an already-patched file surfaces only in the patched-marker
# set and is skipped (a primary rerun re-extracts an already-patched asar).
#
# The rewrite uses node (not bash string-subst or sed) because:
#   - Bash `${s/OLD/NEW}` on a 12MB+ chunk pegs a CPU core for minutes
#     (verified 2026-07-17: bash -x hung >2min on the anchor-file rewrite).
#   - GNU sed 's/OLD/NEW/' works but BSD sed on macOS needs escape gymnastics
#     for the literal `[` `]` `(` `)` `"` chars in our anchor, and cross-Mac
#     shell portability is a repo invariant.
#   - Node's String.prototype.replace with a literal string first arg does
#     exactly-one replacement in ~50ms on 12 MB input.
_asar_apply_patches() {
  local extract_dir="$1"
  local target rel count
  local -a route_files=() patched_files=()
  # Still-pristine files carrying the OLD route anchor → need the append.
  while IFS= read -r rel; do
    [[ -n "$rel" ]] && route_files+=("$rel")
  done < <(_asar_grep_anchor_files "$extract_dir" "$CMA_ASAR_ANCHOR_OLD")
  # Already-patched files carrying our appended mirror-prefs marker → skip.
  while IFS= read -r rel; do
    [[ -n "$rel" ]] && patched_files+=("$rel")
  done < <(_asar_grep_anchor_files "$extract_dir" "$CMA_ASAR_PATCHED_MARKER")

  # Fail loud ONLY when the anchor content is absent in BOTH forms — that is a
  # genuine Claude Desktop layout change, not an already-patched rerun.
  if [[ ${#route_files[@]} -eq 0 && ${#patched_files[@]} -eq 0 ]]; then
    cma_die "asar-patch: bXt() route anchor not found in any .vite/build/*.js file (Claude Desktop internals changed — the anchor needs regenerating)"
  fi

  if [[ ${#patched_files[@]} -gt 0 ]]; then
    for rel in "${patched_files[@]}"; do
      cma_dim "  = $rel already patched"
    done
  fi

  [[ ${#route_files[@]} -gt 0 ]] || return 0
  for rel in "${route_files[@]}"; do
    target="$extract_dir/$rel"
    # The OLD anchor's terminal `)]` array-close must appear exactly once per
    # file. bXt() returns two plist paths but only the LAST is followed by the
    # `]` we anchor on; a second hit means an unexpected duplication — die.
    count="$(grep -cF "$CMA_ASAR_ANCHOR_OLD" "$target" || true)"
    if [[ "$count" != "1" ]]; then
      cma_die "asar-patch: expected 1 occurrence of route anchor in $rel, found $count (Claude Desktop internals changed — the anchor needs regenerating)"
    fi
    # Node stdin-fed script + env-var payload: keeps the 12 MB file content
    # out of the shell's argv and process env; ANCHOR strings are ASCII-
    # safe so we can pass them via `--eval` argv without escaping quotes.
    CMA_ASAR_TARGET="$target" \
      CMA_ASAR_ANCHOR_OLD="$CMA_ASAR_ANCHOR_OLD" \
      CMA_ASAR_ANCHOR_NEW="$CMA_ASAR_ANCHOR_NEW" \
      node -e '
const fs = require("fs");
const t = process.env.CMA_ASAR_TARGET;
const oldA = process.env.CMA_ASAR_ANCHOR_OLD;
const newA = process.env.CMA_ASAR_ANCHOR_NEW;
const s = fs.readFileSync(t, "utf8");
// String.replace with a literal string first arg replaces the FIRST hit.
// If the anchor is not present, .indexOf-check earlier in bash caught it.
const patched = s.replace(oldA, newA);
if (patched === s) {
	console.error("asar-patch: node replace produced no change — anchor logic mismatch");
	process.exit(2);
}
fs.writeFileSync(t, patched);
' || cma_die "asar-patch: node rewrite failed on $target"
    cma_dim "  + patched $rel"
  done
}

# Repack the extracted tree back into a single app.asar with the same unpack
# glob that /Applications/Claude.app uses. The unpack rules keep .node / .dylib
# / node-pty spawn-helper outside the archive because those are dlopened /
# fork/exec'd at runtime and need a real filesystem path.
_asar_repack() {
  local extract_dir="$1" dst_asar="$2" mod_dir="$3"
  # The unpack glob mirrors what /Applications/Claude.app ships (verified
  # against app.asar.unpacked contents: node_modules/@ant/claude-native/
  # *.node, node_modules/node-pty/prebuilds/*/spawn-helper, .dylib in
  # office365-mcp/). @electron/asar's minimatch treats {*.node,…} as a
  # recursive glob for these patterns.
  local unpack='{*.node,*.dylib,spawn-helper}'
  rm -f "$dst_asar"
  rm -rf "${dst_asar}.unpacked"
  node --input-type=module -e "
import { createPackageWithOptions } from 'file://$mod_dir/lib/asar.js';
await createPackageWithOptions('$extract_dir', '$dst_asar', { unpack: '$unpack' });
" || cma_die "asar-patch: repack failed for $extract_dir → $dst_asar"
}

# Compute the SHA-256 of getRawHeader().headerString for the given asar.
# This is the value Electron's ElectronAsarIntegrity check compares against.
# Electron sources: shell/browser/api/electron_api_app.cc + asar/asar_util.cc.
_asar_header_hash() {
  local asar_path="$1" mod_dir="$2"
  node --input-type=module -e "
import { getRawHeader } from 'file://$mod_dir/lib/asar.js';
import { createHash } from 'crypto';
const raw = getRawHeader('$asar_path');
process.stdout.write(createHash('sha256').update(raw.headerString).digest('hex'));
" || return 1
}

# Update Info.plist's ElectronAsarIntegrity."Resources/app.asar".hash to the
# new value. We use PlistBuddy (not `plutil`) because plutil's key-path syntax
# is `.`-separated with no escape for the literal `/` in the key
# "Resources/app.asar" — plutil -extract with that path errors "No value at
# that key path or invalid key path". PlistBuddy's `:`-separated path handles
# the same key without ambiguity.
_asar_update_integrity() {
  local plist="$1" new_hash="$2"
  [[ -f "$plist" ]] || cma_die "asar-patch: Info.plist missing at $plist"
  local key=':ElectronAsarIntegrity:Resources/app.asar:hash'
  # Guard: the key must already exist (created by Anthropic's build). If
  # it's absent, Claude Desktop's own layout changed — fail loud rather
  # than blindly creating a key that Electron may not honour.
  /usr/libexec/PlistBuddy -c "Print $key" "$plist" > /dev/null 2>&1 \
    || cma_die "asar-patch: ElectronAsarIntegrity:Resources/app.asar:hash missing from $plist (Claude Desktop layout changed?)"
  /usr/libexec/PlistBuddy -c "Set $key $new_hash" "$plist" \
    || cma_die "asar-patch: PlistBuddy Set failed on $plist"
}

# Inject the session-propagation IIFE into the singleton chunk. Idempotent:
# a rerun over an already-patched extraction detects the injected marker and
# no-ops. The payload comes from the sibling file
# lib/asar-session-propagation.inject.js so the JS is editable/lintable on its
# own instead of buried in a bash heredoc. See the header of that file for
# runtime-context + failure-mode docs.
#
# Anchor invariants (all fail loud on drift):
#   1. $propagate_rel (discovered by _asar_locate_propagate_file) must exist.
#   2. The singleton marker (`exports.claudeCodeSessionManager=hs;`) must
#      occur exactly ONCE — same fail-loud shape as the bXt() anchor. Zero
#      hits means Claude Desktop restructured the session manager module;
#      the injection would fire against the wrong file. Multiple hits means
#      the module got split and we'd need to pick a specific site — refuse
#      until re-anchored.
#   3. The injected marker `/* claude-multiacct-session-propagation v1 */`
#      MUST NOT already be present on a pristine extraction (idempotency).
#
# The insertion point is DERIVED, not hardcoded: the node rewrite reads the
# discovered chunk's OWN terminal `//# sourceMappingURL=…` line (esbuild names
# it after the churning chunk basename) and inserts the IIFE immediately above
# it so the sourcemap link stays terminal. If the chunk carries no such line,
# it appends at EOF (still valid — there is no sourcemap link to preserve).
_asar_inject_session_propagation() {
  local extract_dir="$1" propagate_rel="$2"
  local target="$extract_dir/$propagate_rel"

  if [[ ! -f "$target" ]]; then
    cma_die "asar-patch: propagation anchor file missing at $target (Claude Desktop restructured the session-manager chunk?)"
  fi

  # Already patched? First-token match on the injected version marker.
  if grep -qF "$CMA_ASAR_PROPAGATE_INJECTED_MARKER" "$target"; then
    cma_dim "  = $propagate_rel session-propagation already injected"
    return 0
  fi

  # Singleton marker must exist exactly once (structural sanity check). This is
  # also the discovery key, so on a fresh extraction it is 1 by construction;
  # the assertion guards a corrupted/hand-edited extraction.
  local singleton_count
  singleton_count="$(grep -cF "$CMA_ASAR_PROPAGATE_SINGLETON_MARKER" "$target" || true)"
  if [[ "$singleton_count" != "1" ]]; then
    cma_die "asar-patch: expected 1 occurrence of session-manager singleton marker in $propagate_rel, found $singleton_count (Claude Desktop internals changed — re-anchor)"
  fi

  # Resolve the payload file (sibling of this script). Fail loud if missing.
  local payload
  payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/asar-session-propagation.inject.js"
  [[ -f "$payload" ]] || cma_die "asar-patch: session-propagation payload missing at $payload"

  # Rewrite via node so the payload (~5 KB) is passed via env/file, not shell
  # argv. See _asar_apply_patches for the same rationale (bash string-subst
  # on multi-MB inputs is pathologically slow; sed's BSD/GNU quirks make the
  # cross-platform escapes brittle; node does one deterministic pass in tens
  # of ms). The sourceMappingURL anchor is DERIVED from the file itself here.
  # shellcheck disable=SC2016  # the single-quoted node script is JS, not shell; the `$` is a regex end-anchor, not a shell expansion
  CMA_PROP_TARGET="$target" \
    CMA_PROP_PAYLOAD_FILE="$payload" \
    node -e '
const fs = require("fs");
const t = process.env.CMA_PROP_TARGET;
const p = process.env.CMA_PROP_PAYLOAD_FILE;
const chunk = fs.readFileSync(t, "utf8");
const payload = fs.readFileSync(p, "utf8");
// Derive the insertion anchor from the chunk s OWN terminal sourceMappingURL
// line (esbuild writes `//# sourceMappingURL=<thisChunk-basename>.js.map` as
// the last line — the basename churns every build so we never hardcode it).
// Insert the IIFE ABOVE that line so the sourcemap link stays terminal. If the
// chunk has no sourceMappingURL line, append at EOF (still valid JS).
const m = chunk.match(/\/\/# sourceMappingURL=[^\n]*\n?$/);
let merged;
if (m) {
	const idx = chunk.length - m[0].length;
	const before = chunk.slice(0, idx);
	const after = chunk.slice(idx);
	const sep = before.endsWith("\n") ? "" : "\n";
	merged = before + sep + payload + (payload.endsWith("\n") ? "" : "\n") + after;
} else {
	const sep = chunk.endsWith("\n") ? "" : "\n";
	merged = chunk + sep + payload + (payload.endsWith("\n") ? "" : "\n");
}
fs.writeFileSync(t, merged);
' || cma_die "asar-patch: node rewrite failed on $target"

  cma_dim "  + injected session-propagation into $propagate_rel"
}

# Inject the Remote-Control enforcer IIFE (Chunk Y) into the SAME chunk as
# the propagation IIFE. Both close over the LocalSessionManager singleton
# `hs`; the enforcer additionally calls into `hs.handleRemoteControlCommand`
# which must exist at runtime. Idempotent: a rerun over an already-patched
# extraction detects the injected marker and no-ops. The payload comes from
# the sibling file lib/asar-remote-control-enforcer.inject.js.
#
# Anchor invariants (all fail loud on drift):
#   1. $propagate_rel (the same discovered chunk as propagation) must exist.
#   2. `handleRemoteControlCommand` must occur AT LEAST ONCE (method def +
#      call sites) IN THE DISCOVERED CHUNK — this asserts the enforcer method
#      really co-locates with the singleton. Zero hits means Claude Desktop
#      restructured the class — the enforcer would inject dead code.
#   3. The enforcer's injected marker MUST NOT already be present.
#
# The enforcer injection runs AFTER the propagation injection in main(). The
# sourceMappingURL insertion anchor is DERIVED per-inject from the chunk's own
# terminal line (see _asar_inject_session_propagation), so both IIFEs stack
# above whatever that terminal line is — even after propagation moved bytes.
_asar_inject_rc_enforcer() {
  local extract_dir="$1" propagate_rel="$2"
  local target="$extract_dir/$propagate_rel"

  if [[ ! -f "$target" ]]; then
    cma_die "asar-patch: enforcer target chunk missing at $target (Claude Desktop restructured?)"
  fi

  # Already patched? First-token match on the injected version marker.
  if grep -qF "$CMA_ASAR_ENFORCER_INJECTED_MARKER" "$target"; then
    cma_dim "  = $propagate_rel rc-enforcer already injected"
    return 0
  fi

  # Method marker must exist at least once. Zero → the runtime call would
  # throw TypeError; refuse to ship a payload that would never work.
  local method_count
  method_count="$(grep -cF "$CMA_ASAR_ENFORCER_METHOD_MARKER" "$target" || true)"
  if [[ "$method_count" -lt 1 ]]; then
    cma_die "asar-patch: expected >=1 occurrence of RC method marker ('$CMA_ASAR_ENFORCER_METHOD_MARKER') in $propagate_rel, found $method_count (Claude Desktop internals changed — re-anchor)"
  fi

  # Resolve the payload file (sibling of this script). Fail loud if missing.
  local payload
  payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/asar-remote-control-enforcer.inject.js"
  [[ -f "$payload" ]] || cma_die "asar-patch: rc-enforcer payload missing at $payload"

  # Same node-rewrite shape as _asar_inject_session_propagation — DERIVES the
  # sourceMappingURL insertion anchor from the chunk itself. Payload lives on
  # disk to keep it editable/lintable outside a bash heredoc.
  # shellcheck disable=SC2016  # the single-quoted node script is JS, not shell; the `$` is a regex end-anchor, not a shell expansion
  CMA_ENF_TARGET="$target" \
    CMA_ENF_PAYLOAD_FILE="$payload" \
    node -e '
const fs = require("fs");
const t = process.env.CMA_ENF_TARGET;
const p = process.env.CMA_ENF_PAYLOAD_FILE;
const chunk = fs.readFileSync(t, "utf8");
const payload = fs.readFileSync(p, "utf8");
// Derive the terminal sourceMappingURL line (basename churns every build) and
// insert ABOVE it; append at EOF when the chunk has no sourcemap line.
const m = chunk.match(/\/\/# sourceMappingURL=[^\n]*\n?$/);
let merged;
if (m) {
	const idx = chunk.length - m[0].length;
	const before = chunk.slice(0, idx);
	const after = chunk.slice(idx);
	const sep = before.endsWith("\n") ? "" : "\n";
	merged = before + sep + payload + (payload.endsWith("\n") ? "" : "\n") + after;
} else {
	const sep = chunk.endsWith("\n") ? "" : "\n";
	merged = chunk + sep + payload + (payload.endsWith("\n") ? "" : "\n");
}
fs.writeFileSync(t, merged);
' || cma_die "asar-patch: node rewrite failed on $target"

  cma_dim "  + injected rc-enforcer into $propagate_rel"
}

# Write the per-bundle managed-prefs plist. Uses `plutil` from Apple's
# CommandLineTools so we get a validated binary/XML plist rather than a
# hand-rolled string — Electron's native readPlistValue would reject a
# malformed plist and silently skip the whole managed tier.
#
# Keys written:
#   - disableAutoUpdates=YES         → suppresses Squirrel auto-poll (Chunk W).
#                                      MIRROR MODE ONLY — mirror clones are not
#                                      Anthropic-signed, so a Squirrel update
#                                      check would fail Designated-Requirement
#                                      verification; we silence it. The PRIMARY
#                                      deliberately OMITS this key so Squirrel
#                                      keeps applying upstream updates (the
#                                      loose-DR re-sign keeps updates valid).
#   - remoteControlAtStartup=YES     → auto-enables Remote Control bridge on
#                                      each new session (Chunk X-A). The Chunk Y
#                                      enforcer catches subsequent drift but
#                                      relies on this initial-startup flip to
#                                      arm the first flip cheaply through Claude
#                                      Desktop's own maybeAutoEnableRemoteControl
#                                      code path.
#
# Both flow through the SAME managed-tier machinery: the bundled JS's $Xt()
# reader iterates the schema keys (from SXt() = [...IW.keys()], where IW is
# built from every top-level key of the settings schema Nl) and calls
# `nativeReader.readPlistValue(<plist_path>, <key>)` for each. Because
# `remoteControlAtStartup` is a top-level `f.boolean().optional()` field in the
# schema (index.chunk-DqiH2czz.js: SettingsResolver), it appears in IW.keys()
# with no additional JS anchor patching — SXt() returns it and $Xt() reads it
# straight from the plist. See docs/architecture.md for the full trace.
_asar_write_mirror_plist() {
  local plist="$1" mode="${2:-mirror}"
  # `<true/>` is the plist boolean literal. plutil -create produces an
  # empty root dict; -insert adds the key.
  plutil -create xml1 "$plist" || cma_die "asar-patch: plutil -create failed for $plist"
  # disableAutoUpdates is MIRROR-ONLY. Writing it into the primary's plist
  # would silence Squirrel on /Applications/Claude.app itself and freeze the
  # primary at its currently-installed version forever — the whole point of
  # the loose-DR re-sign is to KEEP the primary updatable.
  if [[ "$mode" == "mirror" ]]; then
    plutil -insert disableAutoUpdates -bool true "$plist" \
      || cma_die "asar-patch: plutil -insert disableAutoUpdates failed for $plist"
  fi
  plutil -insert remoteControlAtStartup -bool true "$plist" \
    || cma_die "asar-patch: plutil -insert remoteControlAtStartup failed for $plist"
}

# ── Primary-mode: snapshot / re-sign / unpatch ─────────────────────────────

# Snapshot the pristine app.asar AND app.asar.unpacked ONCE per Squirrel-
# installed version so `primary-unpatch` can restore the FULL patch surface.
# The old bug (a real incident) snapshotted only app.asar; unpatch then
# rm -rf'd app.asar.unpacked and restored just the asar, deleting the native
# @ant/claude-native + claude-swift *.node modules and blanking the app. We
# snapshot BOTH here and restore BOTH in _asar_unpatch_primary.
#
# On a re-run against an already-patched primary (idempotent case), the backup
# already exists — leave it alone (it holds the pristine bytes). When Squirrel
# drops a fresh pristine, the primary-patch-refresh agent deletes the stale
# backups BEFORE re-invoking so this captures the NEW pristine.
_asar_snapshot_primary_bundle() {
  local app="$1"
  local asar="$app/Contents/Resources/app.asar"
  local unpacked="$app/Contents/Resources/app.asar.unpacked"
  local asar_backup="$app/Contents/Resources/$CMA_PRIMARY_ASAR_BACKUP"
  local unpacked_backup="$app/Contents/Resources/$CMA_PRIMARY_UNPACKED_BACKUP"

  [[ -f "$asar" ]] || cma_die "asar-patch: primary app.asar missing at $asar (Claude.app corrupt?)"

  if [[ -f "$asar_backup" ]]; then
    cma_dim "  primary app.asar backup already exists at $asar_backup — keeping"
  else
    cp -p "$asar" "$asar_backup" \
      || cma_die "asar-patch: failed to snapshot primary app.asar to $asar_backup"
    cma_dim "  snapshotted primary app.asar → $asar_backup ($(du -h "$asar_backup" | awk '{print $1}'))"
  fi

  # app.asar.unpacked is the native-module tree (Electron dlopens .node from
  # it). It is ALWAYS present on the real Claude.app; a hermetic fixture with
  # no native modules ships without it. Snapshot it whenever it exists so
  # unpatch can put it back byte-for-byte.
  if [[ -d "$unpacked" ]]; then
    if [[ -e "$unpacked_backup" ]]; then
      cma_dim "  primary app.asar.unpacked backup already exists at $unpacked_backup — keeping"
    else
      cp -Rp "$unpacked" "$unpacked_backup" \
        || cma_die "asar-patch: failed to snapshot primary app.asar.unpacked to $unpacked_backup"
      cma_dim "  snapshotted primary app.asar.unpacked → $unpacked_backup"
    fi
  fi
}

# Write the loose Designated Requirement to a requirements file. Kept a
# one-liner so the exact bytes are trivially assertable by tests. The DR is
# the SOLE thing that keeps the patched primary update-capable — see the
# CMA_PRIMARY_LOOSE_DR comment.
_asar_write_dr_requirements() {
  local reqfile="$1"
  printf '%s\n' "$CMA_PRIMARY_LOOSE_DR" > "$reqfile" \
    || cma_die "asar-patch: failed to write DR requirements file $reqfile"
}

# Emit the nested code-signing targets for $app in INSIDE-OUT order, one path
# per line: every nested Mach-O-bearing bundle first (Helper .apps incl.
# (GPU)/(Renderer)/(Plugin), then the *.framework bundles), and the OUTER app
# LAST. The caller signs in this exact order so each seal is computed over
# already-signed nested code — the whole reason we can't use `--deep` (which
# leaves "nested code is modified or invalid" under ad-hoc). Factored out so a
# test can assert the ordering without a real codesign.
_asar_primary_sign_targets() {
  local app="$1"
  local fw="$app/Contents/Frameworks"
  if [[ -d "$fw" ]]; then
    # Helper .apps (deepest executables) first, then frameworks.
    find "$fw" -maxdepth 1 -type d -name '*.app' 2> /dev/null | sort
    find "$fw" -maxdepth 1 -type d -name '*.framework' 2> /dev/null | sort
  fi
  # Outer app LAST — its seal covers Contents/Info.plist (the rewritten
  # ElectronAsarIntegrity hash) + the already-signed nested code.
  printf '%s\n' "$app"
}

# Re-sign the primary bundle INSIDE-OUT, ad-hoc, with the loose DR. For each
# target (nested first, outer app last):
#   - extract that component's ORIGINAL entitlements (Anthropic's signature is
#     still intact at this point — we haven't touched nested code) and re-apply
#     them so the runtime keeps its sandbox/JIT/etc grants;
#   - sign `--force --sign - --options runtime --requirements <loose DR>`.
# Deliberately NOT `--deep`.
_asar_resign_primary_inside_out() {
  local app="$1"
  command -v codesign > /dev/null 2>&1 || cma_die "asar-patch: codesign not found on PATH (Xcode CLT required for primary re-sign)"

  local reqfile
  reqfile="$(mktemp -t cma-dr-req 2> /dev/null || mktemp)" || cma_die "asar-patch: mktemp failed for DR requirements"
  _asar_write_dr_requirements "$reqfile"

  cma_say "primary re-sign: inside-out ad-hoc with loose DR (NO team pin, NO --deep) — keeps the primary Squirrel-updatable"

  local target ent
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    ent="$(mktemp -t cma-ent 2> /dev/null || mktemp)" || cma_die "asar-patch: mktemp failed for entitlements"
    # Preserve the component's original entitlements when it has any. `:path`
    # form writes the entitlements xml directly to the file. If the component
    # is unsigned / has no entitlements (e.g. a script-based fixture binary),
    # sign without --entitlements.
    if codesign -d --entitlements ":$ent" "$target" > /dev/null 2>&1 && [[ -s "$ent" ]]; then
      codesign --force --sign - --options runtime --requirements "$reqfile" --entitlements "$ent" "$target" > /dev/null 2>&1 \
        || cma_die "asar-patch: inside-out codesign failed on $target (with entitlements)"
      cma_dim "  signed (loose DR, +entitlements): $target"
    else
      codesign --force --sign - --options runtime --requirements "$reqfile" "$target" > /dev/null 2>&1 \
        || cma_die "asar-patch: inside-out codesign failed on $target"
      cma_dim "  signed (loose DR): $target"
    fi
    rm -f "$ent"
  done < <(_asar_primary_sign_targets "$app")

  rm -f "$reqfile"
}

# Post-patch assertions on a patched primary (Rule 12 fail-loud):
#   1. If the PRISTINE bundle shipped native .node modules (production always
#      does; a hermetic fixture may not), the PATCHED bundle must still carry
#      them under app.asar.unpacked — proves the repack/re-sign didn't blank
#      the native-module tree (the incident this whole change guards against).
#   2. `codesign --verify --strict` must pass with NO "nested code" complaint —
#      proves the inside-out sign produced a valid seal (which `--deep` ad-hoc
#      did not).
_asar_assert_primary_healthy() {
  local app="$1"
  local unpacked="$app/Contents/Resources/app.asar.unpacked"
  local unpacked_backup="$app/Contents/Resources/$CMA_PRIMARY_UNPACKED_BACKUP"

  # (1) native-module survival — only enforced when the pristine had .node.
  if [[ -d "$unpacked_backup" ]] \
    && find "$unpacked_backup" -name '*.node' -print -quit 2> /dev/null | grep -q .; then
    if ! find "$unpacked" -name '*.node' -print -quit 2> /dev/null | grep -q .; then
      cma_die "asar-patch: PATCHED primary lost its native .node modules under $unpacked (pristine had them) — refusing to leave the bundle blanked"
    fi
    cma_dim "  assertion OK: patched primary retains native .node modules"
  fi

  # (2) codesign strict validity — no nested-code corruption.
  local verify_out
  verify_out="$(codesign --verify --strict "$app" 2>&1 || true)"
  if printf '%s' "$verify_out" | grep -qiF 'nested code'; then
    cma_die "asar-patch: codesign --verify --strict reports nested-code corruption on $app: $verify_out"
  fi
  # A non-empty output that isn't the nested-code case is surfaced but not
  # fatal (some macOS builds emit informational lines); the nested-code grep
  # above is the load-bearing check.
  cma_dim "  assertion OK: codesign --verify --strict shows no nested-code corruption"
}

# Restore the pristine primary from the FULL snapshot (app.asar +
# app.asar.unpacked), remove the multiacct-owned plist, recompute the
# Info.plist integrity hash to match the pristine asar, and re-sign inside-out
# with the loose DR. Called by `claude-multiacct primary-unpatch`.
#
# CRITICAL: restores app.asar.unpacked too. The old unpatch deleted it and
# restored only the asar — that removed the native modules and blanked the
# app. Never leave the bundle without its app.asar.unpacked native modules.
_asar_unpatch_primary() {
  local app="$1"
  local asar="$app/Contents/Resources/app.asar"
  local unpacked="$app/Contents/Resources/app.asar.unpacked"
  local asar_backup="$app/Contents/Resources/$CMA_PRIMARY_ASAR_BACKUP"
  local unpacked_backup="$app/Contents/Resources/$CMA_PRIMARY_UNPACKED_BACKUP"
  local plist="$app/Contents/Info.plist"
  local mirror_plist="$app/Contents/Resources/$CMA_MIRROR_PLIST_BASENAME"

  [[ -d "$app" ]] || cma_die "asar-unpatch: appBundle not found at $app"
  [[ -f "$asar_backup" ]] || cma_die "asar-unpatch: no backup at $asar_backup — primary was never patched by this tool"

  local mod_dir
  # shellcheck disable=SC2310
  if ! mod_dir="$(_asar_module_dir)"; then
    cma_die "asar-unpatch: @electron/asar module not installed (run \`mise install\` from the repo root)"
  fi

  cma_say "asar unpatch label=primary (restoring app.asar + app.asar.unpacked)"

  # Restore app.asar.unpacked FIRST so an interruption never leaves the bundle
  # with a pristine asar but no native modules. If the pristine had no unpacked
  # tree (fixture), there is nothing to restore and nothing was removed.
  rm -rf "$unpacked"
  if [[ -e "$unpacked_backup" ]]; then
    cp -Rp "$unpacked_backup" "$unpacked" \
      || cma_die "asar-unpatch: failed to restore app.asar.unpacked from $unpacked_backup"
    cma_dim "  restored app.asar.unpacked from backup"
  fi

  rm -f "$asar"
  cp -p "$asar_backup" "$asar" \
    || cma_die "asar-unpatch: failed to restore app.asar from $asar_backup"
  cma_dim "  restored app.asar from backup"

  if [[ -f "$mirror_plist" ]]; then
    rm -f "$mirror_plist"
    cma_dim "  removed $mirror_plist"
  fi

  local pristine_hash
  # shellcheck disable=SC2310
  if ! pristine_hash="$(_asar_header_hash "$asar" "$mod_dir")"; then
    cma_die "asar-unpatch: could not compute pristine header hash"
  fi
  _asar_update_integrity "$plist" "$pristine_hash"
  cma_dim "  restored Info.plist ElectronAsarIntegrity hash: $pristine_hash"

  # Consume the backups now that they are restored.
  rm -f "$asar_backup"
  rm -rf "$unpacked_backup"

  # Re-sign inside-out with the loose DR so the restored bundle is validly
  # signed AND stays update-capable. (Anthropic's original Developer ID
  # signature is only restored by a real Squirrel drop / reinstall.)
  _asar_resign_primary_inside_out "$app"

  cma_ok "asar unpatched: primary restored to pristine app.asar + app.asar.unpacked (re-signed with loose DR; Apple signature returns on next Squirrel drop)"
}

main() {
  local mode="mirror"
  local action="patch"
  # Support --mode=<mirror|primary> AND --unpatch flag before the positionals.
  # Default-mirror keeps existing callers (build-clone-app.sh) unchanged.
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode=*)
        mode="${1#--mode=}"
        shift
        ;;
      --mode)
        mode="$2"
        shift 2
        ;;
      --unpatch)
        action="unpatch"
        shift
        ;;
      *) break ;;
    esac
  done
  case "$mode" in
    mirror | primary) ;;
    *) cma_die "asar-patch: --mode must be 'mirror' or 'primary' (got '$mode')" ;;
  esac
  # --unpatch is primary-only: a mirror unpatch is `remove-instance` (drops the
  # whole clone). A mirror + --unpatch combination is a user error.
  if [[ "$action" == "unpatch" && "$mode" != "primary" ]]; then
    cma_die "asar-patch: --unpatch is only meaningful with --mode=primary (mirror unpatch = remove-instance)"
  fi

  local label="$1" app="$2"
  # Primary mode uses the reserved label "primary" (cma_validate_label refuses
  # it — that reservation keeps 'primary' out of the mirror namespace, so the
  # check here is a special-case bypass with a fixed label).
  if [[ "$mode" == "primary" ]]; then
    [[ "$label" == "primary" ]] || cma_die "asar-patch: --mode=primary requires label 'primary' (got '$label')"
  else
    cma_validate_label "$label"
  fi
  [[ -n "$app" ]] || cma_die "asar-patch: missing appBundle arg"
  [[ -d "$app" ]] || cma_die "asar-patch: appBundle not found at $app"

  # Dispatch --unpatch before the patch pipeline.
  if [[ "$action" == "unpatch" ]]; then
    _asar_unpatch_primary "$app"
    return 0
  fi

  local asar="$app/Contents/Resources/app.asar"
  local plist="$app/Contents/Info.plist"
  local mirror_plist="$app/Contents/Resources/$CMA_MIRROR_PLIST_BASENAME"

  # Hermetic tests build a minimal fake Claude.app fixture that has no
  # app.asar — nothing to patch, no-op cleanly. Production always has an
  # asar; a missing asar there would be caught upstream (build-clone-app.sh
  # would have failed on the ditto that copies the source bundle's asar).
  # Dedicated asar-patch tests use a fuller fixture that DOES include an
  # app.asar and exercise this path in full.
  if [[ ! -f "$asar" ]]; then
    cma_dim "asar-patch: no $asar (fixture bundle) — nothing to patch, skipping"
    return 0
  fi

  # Primary-mode snapshot: preserve the pristine app.asar + app.asar.unpacked
  # BEFORE we mutate anything so `primary-unpatch` can restore the FULL patch
  # surface. Idempotent — an existing backup is kept (holds the pristine bytes
  # from the last time we saw a pristine primary).
  if [[ "$mode" == "primary" ]]; then
    _asar_snapshot_primary_bundle "$app"
  fi

  local mod_dir
  # `if ! ...; then` form: we DELIBERATELY consume the function's rc — dying
  # on nonzero via cma_die is the whole point. SC2310 fires on any function
  # call in an if/! condition; the ownership is explicit here.
  # shellcheck disable=SC2310
  if ! mod_dir="$(_asar_module_dir)"; then
    cma_die "asar-patch: @electron/asar module not installed (run \`mise install\` from the repo root)"
  fi

  cma_say "asar-patch label=$label"
  cma_dim "  bundle: $app"
  cma_dim "  asar:   $asar"

  # Working directory under CMA_LOG_DIR/asar-patch-<label>. Reused across
  # reruns for cheaper churn. Wiped at each call because extract is fast
  # (~2s on SSD) and the on-disk cost of extracted node_modules exceeds
  # the extract-cost saving.
  local work="$CMA_LOG_DIR/asar-patch-$label"
  mkdir -p "$work"
  local extract_dir="$work/extracted"
  local patched_asar="$work/patched.asar"

  cma_dim "  extract → $extract_dir"
  _asar_extract "$asar" "$extract_dir" "$mod_dir"

  cma_dim "  apply patches"
  _asar_apply_patches "$extract_dir"

  # Discover the singleton chunk ONCE (content-anchored — its name churns every
  # Claude build) and thread it through both injectors. cma_die inside
  # _asar_locate_propagate_file fires at top level (main), not in a masked
  # subshell, so a 0/>1 match aborts loudly.
  local propagate_rel
  propagate_rel="$(_asar_locate_propagate_file "$extract_dir")"

  cma_dim "  inject session-propagation → $propagate_rel"
  _asar_inject_session_propagation "$extract_dir" "$propagate_rel"

  cma_dim "  inject rc-enforcer → $propagate_rel"
  _asar_inject_rc_enforcer "$extract_dir" "$propagate_rel"

  cma_dim "  repack → $patched_asar"
  _asar_repack "$extract_dir" "$patched_asar" "$mod_dir"

  # Move the patched asar into place, preserving the app.asar.unpacked/
  # tree the source ships with (Electron dlopens .node from there). Note:
  # `createPackageWithOptions` only emits the .unpacked/ sibling when the
  # staged tree actually contains files matching the unpack glob — for the
  # real Claude.app it always does (@ant/claude-native/*.node etc.), for a
  # hermetic bats fixture with no native modules it doesn't. Guard the mv.
  cma_dim "  install patched asar into clone"
  rm -f "$asar"
  rm -rf "${asar}.unpacked"
  mv "$patched_asar" "$asar"
  if [[ -d "${patched_asar}.unpacked" ]]; then
    mv "${patched_asar}.unpacked" "${asar}.unpacked"
  fi

  local new_hash
  # shellcheck disable=SC2310 # deliberate: caller consumes the rc via cma_die
  if ! new_hash="$(_asar_header_hash "$asar" "$mod_dir")"; then
    cma_die "asar-patch: could not compute header hash for $asar"
  fi
  [[ -n "$new_hash" ]] || cma_die "asar-patch: computed header hash is empty (@electron/asar version incompatible?)"
  cma_dim "  new asar header sha256: $new_hash"

  _asar_update_integrity "$plist" "$new_hash"
  cma_dim "  Info.plist ElectronAsarIntegrity hash updated"

  _asar_write_mirror_plist "$mirror_plist" "$mode"
  cma_dim "  wrote $mirror_plist (mode=$mode)"

  # Codesign:
  #   - mirror  → build-clone-app.sh ad-hoc re-signs the whole clone bundle
  #               after this returns, so we don't re-sign here.
  #   - primary → re-sign IN PLACE, inside-out, ad-hoc, with the loose DR so
  #               the primary stays validly signed AND Squirrel-updatable.
  #               Then assert native modules survived + no nested-code
  #               corruption.
  if [[ "$mode" == "primary" ]]; then
    _asar_resign_primary_inside_out "$app"
    _asar_assert_primary_healthy "$app"
  fi

  case "$mode" in
    mirror) cma_ok "asar patched: label=$label mode=mirror (auto-updates disabled + propagation + rc-enforcer)" ;;
    primary) cma_ok "asar patched: label=$label mode=primary (propagation + rc-enforcer; auto-updates left ENABLED, loose-DR re-signed)" ;;
  esac
}

# Only run main() when executed directly. Sourcing the file (e.g. from bats
# tests that need to reach into `_asar_inject_session_propagation` in isolation
# without extracting a full asar first) leaves main() available but not fired.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
