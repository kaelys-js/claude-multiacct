#!/usr/bin/env bash
# lib/asar-patch-clone.sh — patch a mirror clone's app.asar so Squirrel's
# auto-updater treats the mirror as "auto-updates disabled by admin" instead
# of firing an update check that fails Designated-Requirement verification
# against a bundle Anthropic didn't sign (produces "Failed to check for
# updates" dialog + repeated auto-poll error logs).
#
# The mechanism (design docs/architecture.md):
#   1. Claude Desktop's managed-config reader iterates a list of plist paths
#      (bXt() in the bundled JS) looking for `disableAutoUpdates=YES`. The
#      pristine list is:
#        /Library/Managed Preferences/com.anthropic.claudefordesktop.plist
#        /Library/Managed Preferences/<user>/com.anthropic.claudefordesktop.plist
#      Both are MDM-owned and empty on a personal Mac.
#   2. We APPEND process.resourcesPath+"/claude-multiacct-mirror-prefs.plist"
#      to that list AND write a per-mirror plist at
#      <clone>/Contents/Resources/claude-multiacct-mirror-prefs.plist with
#      <key>disableAutoUpdates</key><true/>. Claude then reads the flag from
#      the mirror-owned plist and:
#        - i_t() short-circuits: "[updater] Auto-updates disabled by
#          enterprise policy" log line, no network call.
#        - NRn() menu builder sees `Oe().autoUpdate.disabled=true` and
#          disables the "Check for Updates…" item with sublabel "Updates
#          disabled by admin". The old "Failed to check for updates" dialog
#          is never reachable.
#   3. Repack asar, recompute the SHA-256 of `getRawHeader().headerString`,
#      write it into <clone>/Contents/Info.plist under
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
# Usage: asar-patch-clone.sh <label> <appBundle>

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Path anchors patched inside app.asar. Both anchors must exist EXACTLY ONCE
# in exactly ONE file each — mismatched counts fail loud rather than silently
# corrupting the asar.
CMA_ASAR_ANCHOR_OLD='"com.anthropic.claudefordesktop.plist")]'
CMA_ASAR_ANCHOR_NEW='"com.anthropic.claudefordesktop.plist"),process.resourcesPath+"/claude-multiacct-mirror-prefs.plist"]'
CMA_ASAR_ANCHOR_FILES=(
  ".vite/build/index.chunk-DD6nxfJK.js"
  ".vite/build/index.pre.js"
)

# Path inside the clone where the per-mirror managed-prefs plist lives. Read
# by the bXt() append via `process.resourcesPath+"/..."`.
CMA_MIRROR_PLIST_BASENAME="claude-multiacct-mirror-prefs.plist"

# ── Session-propagation anchor (Chunk X-B) ────────────────────────────────
#
# In addition to the two bXt() anchors above we ALSO inject a self-contained
# IIFE into `.vite/build/index.chunk-BpZff9Dw.js` — the chunk that instantiates
# the LocalSessionManager singleton (`hs = new vt(o.CCD_SESSIONS_BASE_DIR)`)
# and re-exports it as `exports.claudeCodeSessionManager`. The injection sets
# up an fs.watch on the mirror's claude-code-sessions storage dir; on any
# cross-process file mutation (primary or peer mirrors writing through the
# Layer-2 symlink) it rescans the changed files, updates the in-memory Map,
# and calls `hs.emitSessionUpdated(sessionId)` — the SAME emit path the manager
# uses for its own mutations, so every renderer subscription (sidebar included)
# updates without a process restart. See docs/architecture.md § "Real-time
# session-state propagation" for the full trace.
#
# Anchor markers:
#   - CMA_ASAR_PROPAGATE_FILE: which chunk to inject into (content-anchored
#     via _asar_locate_propagate_file at extract-time so a chunk-name churn
#     in a future Claude Desktop release fails loud rather than injecting
#     into the wrong file).
#   - CMA_ASAR_PROPAGATE_MARKER: the exact string that MUST be present in the
#     chunk pre-injection AND becomes the "already patched" idempotency check
#     post-injection.
#   - CMA_ASAR_PROPAGATE_ANCHOR_BEFORE: the sourceMappingURL comment we insert
#     the IIFE ABOVE (keeps the sourcemap link at the very end of file).
CMA_ASAR_PROPAGATE_FILE=".vite/build/index.chunk-BpZff9Dw.js"
CMA_ASAR_PROPAGATE_SINGLETON_MARKER='exports.claudeCodeSessionManager=hs;'
CMA_ASAR_PROPAGATE_ANCHOR_BEFORE='//# sourceMappingURL=index.chunk-BpZff9Dw.js.map'
CMA_ASAR_PROPAGATE_INJECTED_MARKER='/* claude-multiacct-session-propagation v1 */'

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

# Apply the bXt() append to each anchor file. The anchor count MUST be
# exactly 1 in the pristine primary; if a future Claude update deletes the
# anchor OR duplicates it, we fail loud with a message pointing at the file
# and the count. Idempotent: on re-run, the anchor is already the patched
# form — we detect that and no-op.
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
  for rel in "${CMA_ASAR_ANCHOR_FILES[@]}"; do
    target="$extract_dir/$rel"
    [[ -f "$target" ]] || cma_die "asar-patch: anchor file missing at $target (Claude Desktop layout changed?)"
    # Already patched? The NEW anchor contains the mirror-prefs marker
    # whereas the OLD anchor doesn't — one grep tells us both.
    if grep -qF 'claude-multiacct-mirror-prefs.plist' "$target"; then
      cma_dim "  = $rel already patched"
      continue
    fi
    # Not patched — the OLD anchor must appear exactly once.
    count="$(grep -cF "$CMA_ASAR_ANCHOR_OLD" "$target" || true)"
    if [[ "$count" != "1" ]]; then
      cma_die "asar-patch: expected 1 occurrence of anchor in $rel, found $count (Claude Desktop internals changed — the anchor needs regenerating)"
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
#   1. The propagate file must exist inside the extraction.
#   2. The singleton marker (`exports.claudeCodeSessionManager=hs;`) must
#      occur exactly ONCE — same fail-loud shape as the bXt() anchor. Zero
#      hits means Claude Desktop restructured the session manager module;
#      the injection would fire against the wrong file. Multiple hits means
#      the module got split and we'd need to pick a specific site — refuse
#      until re-anchored.
#   3. The sourcemap comment must exist exactly ONCE (as the last line of the
#      file, per esbuild's output). We insert the IIFE immediately BEFORE it
#      so the sourcemap link stays terminal.
#   4. The injected marker `/* claude-multiacct-session-propagation v1 */`
#      MUST NOT already be present on a pristine extraction (i.e. the anchor
#      count check runs only when we're not already patched).
_asar_inject_session_propagation() {
  local extract_dir="$1"
  local target="$extract_dir/$CMA_ASAR_PROPAGATE_FILE"

  if [[ ! -f "$target" ]]; then
    cma_die "asar-patch: propagation anchor file missing at $target (Claude Desktop restructured the session-manager chunk?)"
  fi

  # Already patched? First-token match on the injected version marker.
  if grep -qF "$CMA_ASAR_PROPAGATE_INJECTED_MARKER" "$target"; then
    cma_dim "  = $CMA_ASAR_PROPAGATE_FILE session-propagation already injected"
    return 0
  fi

  # Singleton marker must exist exactly once (structural sanity check).
  local singleton_count anchor_count
  singleton_count="$(grep -cF "$CMA_ASAR_PROPAGATE_SINGLETON_MARKER" "$target" || true)"
  if [[ "$singleton_count" != "1" ]]; then
    cma_die "asar-patch: expected 1 occurrence of session-manager singleton marker in $CMA_ASAR_PROPAGATE_FILE, found $singleton_count (Claude Desktop internals changed — re-anchor)"
  fi
  anchor_count="$(grep -cF "$CMA_ASAR_PROPAGATE_ANCHOR_BEFORE" "$target" || true)"
  if [[ "$anchor_count" != "1" ]]; then
    cma_die "asar-patch: expected 1 occurrence of sourceMappingURL anchor in $CMA_ASAR_PROPAGATE_FILE, found $anchor_count"
  fi

  # Resolve the payload file (sibling of this script). Fail loud if missing.
  local payload
  payload="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/asar-session-propagation.inject.js"
  [[ -f "$payload" ]] || cma_die "asar-patch: session-propagation payload missing at $payload"

  # Rewrite via node so the payload (~5 KB) is passed via env/file, not shell
  # argv. See _asar_apply_patches for the same rationale (bash string-subst
  # on multi-MB inputs is pathologically slow; sed's BSD/GNU quirks make the
  # cross-platform escapes brittle; node's String.replace with a literal
  # first arg does one deterministic replacement in tens of ms).
  CMA_PROP_TARGET="$target" \
    CMA_PROP_PAYLOAD_FILE="$payload" \
    CMA_PROP_ANCHOR="$CMA_ASAR_PROPAGATE_ANCHOR_BEFORE" \
    node -e '
const fs = require("fs");
const t = process.env.CMA_PROP_TARGET;
const p = process.env.CMA_PROP_PAYLOAD_FILE;
const anchor = process.env.CMA_PROP_ANCHOR;
const chunk = fs.readFileSync(t, "utf8");
const payload = fs.readFileSync(p, "utf8");
// Insert payload ABOVE the sourceMappingURL comment so the sourcemap link
// stays at the very end of the file (some Electron dev-tooling parses only
// the LAST such line, so keeping it terminal is the safe convention).
const idx = chunk.indexOf(anchor);
if (idx === -1) {
	console.error("asar-patch: sourceMappingURL anchor not found in target (pre-node grep should have caught this)");
	process.exit(2);
}
// Ensure a trailing newline before the anchor so the injected IIFE and the
// sourcemap comment are on their own lines.
const before = chunk.slice(0, idx);
const after = chunk.slice(idx);
const sep = before.endsWith("\n") ? "" : "\n";
const merged = before + sep + payload + (payload.endsWith("\n") ? "" : "\n") + after;
fs.writeFileSync(t, merged);
' || cma_die "asar-patch: node rewrite failed on $target"

  cma_dim "  + injected session-propagation into $CMA_ASAR_PROPAGATE_FILE"
}

# Write the per-mirror managed-prefs plist. Uses `plutil` from Apple's
# CommandLineTools so we get a validated binary/XML plist rather than a
# hand-rolled string — Electron's native readPlistValue would reject a
# malformed plist and silently skip the whole managed tier.
#
# Keys written:
#   - disableAutoUpdates=YES         → suppresses Squirrel auto-poll (Chunk W)
#   - remoteControlAtStartup=YES     → auto-enables Remote Control bridge on
#                                      each new session (Chunk X-A)
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
  local plist="$1"
  # `<true/>` is the plist boolean literal. plutil -create produces an
  # empty root dict; -insert adds the key.
  plutil -create xml1 "$plist" || cma_die "asar-patch: plutil -create failed for $plist"
  plutil -insert disableAutoUpdates -bool true "$plist" \
    || cma_die "asar-patch: plutil -insert disableAutoUpdates failed for $plist"
  plutil -insert remoteControlAtStartup -bool true "$plist" \
    || cma_die "asar-patch: plutil -insert remoteControlAtStartup failed for $plist"
}

main() {
  local label="$1" app="$2"
  cma_validate_label "$label"
  [[ -n "$app" ]] || cma_die "asar-patch: missing appBundle arg"
  [[ -d "$app" ]] || cma_die "asar-patch: appBundle not found at $app"

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

  cma_dim "  inject session-propagation"
  _asar_inject_session_propagation "$extract_dir"

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

  _asar_write_mirror_plist "$mirror_plist"
  cma_dim "  wrote $mirror_plist"

  cma_ok "asar patched: label=$label (auto-updates disabled via per-mirror plist)"
}

# Only run main() when executed directly. Sourcing the file (e.g. from bats
# tests that need to reach into `_asar_inject_session_propagation` in isolation
# without extracting a full asar first) leaves main() available but not fired.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
