#!/usr/bin/env bash
# lib/discover.sh — inspect on-disk state of all instances. Emits a health
# report + machine-parseable TSV (via --tsv) or JSON (via --json). Used by
# `list` and `doctor`.
#
# Usage:
#   discover.sh                # human report to stderr, no output to stdout
#   discover.sh --tsv          # TSV to stdout: label\thealth\tissues
#   discover.sh --json         # JSON array of instance objects to stdout,
#                              # human report suppressed (cross-mac diff format)

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

TSV=0
JSON=0
case "${1:-}" in
  --tsv) TSV=1 ;;
  --json) JSON=1 ;;
esac

# --json suppresses the human-readable report entirely — the caller wants ONLY
# a machine-parseable object. cma_say / cma_ok / cma_warn / cma_dim all write to
# stderr; --json redirects stderr to /dev/null via the wrapper below so a diff
# between two Macs' outputs is clean.
_cma_quiet=""
if [[ $JSON -eq 1 ]]; then
  _cma_quiet=1
fi

# JSON collector — one line per instance, joined at the end. Populated only in
# --json mode.
_json_rows=()

# JSON-escape a single string. Handles the four escapes JSON requires:
# backslash, double-quote, newline, tab. Sufficient for label / email / config
# paths — none of our fields contain control chars beyond \n / \t.
_json_esc() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

# Check a single instance and print a report + optionally a TSV row.
check_one() {
  local label="$1"
  local row
  row="$(cma_resolve_instance "$label")"
  local _l email cdir udata cli app bid
  IFS=$'\t' read -r _l email cdir udata cli app bid <<< "$row"

  local issues=()

  if [[ -z "${_cma_quiet:-}" ]]; then
    cma_say "instance: $label"
    cma_dim "  email:       $email"
    cma_dim "  configDir:   $cdir"
    cma_dim "  userData:    $udata"
  fi

  # 1. configDir + its symlinks
  if [[ -d "$cdir" ]]; then
    cma_ok "configDir exists"
    local shared missing=()
    for shared in projects sessions todos shell-snapshots plugins skills; do
      if [[ ! -L "$cdir/$shared" ]]; then
        missing+=("$shared")
      fi
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
      cma_ok "config-dir shared symlinks present"
    else
      cma_warn "config-dir shared symlinks MISSING: ${missing[*]}"
      issues+=("shared-symlinks-missing:${missing[*]}")
    fi

    # remoteControlAtStartup is written into every mirror's settings.json by
    # install-instance.sh (User tier) AND into the mirror-prefs plist by
    # asar-patch-clone.sh (Managed tier). The two tiers are belt-and-braces:
    # either one on its own is enough for SettingsResolver's j$n() to auto-
    # enable Remote Control at session start. Doctor reports the User-tier
    # signal here; the Managed-tier signal is reported in the asar-patch block
    # further down (mirror-prefs plist check).
    local settings_file="$cdir/settings.json"
    if [[ -f "$settings_file" ]]; then
      local rc_val
      rc_val="$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print("true" if d.get("remoteControlAtStartup") is True else "missing")
except Exception:
    print("unreadable")
' "$settings_file" 2> /dev/null)"
      case "$rc_val" in
        true)
          cma_ok "settings.json: remoteControlAtStartup=true (User tier)"
          ;;
        missing)
          cma_warn "settings.json: remoteControlAtStartup MISSING — run \`claude-multiacct repair $label\`"
          issues+=("remote-control-user-missing")
          ;;
        unreadable)
          cma_warn "settings.json: unreadable JSON at $settings_file"
          issues+=("settings-json-unreadable")
          ;;
      esac
    else
      cma_warn "settings.json MISSING at $settings_file"
      issues+=("settings-json-missing")
    fi
  else
    cma_warn "configDir missing"
    issues+=("configdir-missing")
  fi

  # 2. userData
  if [[ -d "$udata" ]]; then
    cma_ok "userData exists"
    local ccs="$udata/claude-code-sessions"
    if [[ -d "$ccs" ]]; then
      local acct
      acct="$(find "$ccs" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2> /dev/null | head -1)"
      if [[ -n "$acct" ]]; then
        cma_ok "logged in (account UUID: $(basename "$acct"))"
        local org
        org="$(find "$acct" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | head -1)"
        if [[ -n "$org" ]]; then
          if [[ -L "$org" ]]; then
            cma_ok "claude-code-sessions ORG symlinked → $(readlink "$org")"
          else
            cma_warn "claude-code-sessions ORG dir is NOT a symlink (metadata sharing not installed)"
            issues+=("metadata-symlink-missing")
          fi
        fi
      else
        cma_warn "not logged in yet (no account UUID under $ccs)"
        issues+=("not-logged-in")
      fi
    else
      cma_dim "  claude-code-sessions/ not yet created (Claude Desktop hasn't been launched with this identity yet)"
      issues+=("never-launched")
    fi
  else
    cma_warn "userData missing"
    issues+=("userdata-missing")
  fi

  # 3. CLI launcher
  if [[ -x "$cli" ]]; then
    cma_ok "cli launcher $cli"
  else
    cma_warn "cli launcher missing or not executable: $cli"
    issues+=("cli-missing")
  fi

  # 4. .app bundle
  if [[ -d "$app" ]]; then
    # Verify codesign.
    if codesign -v "$app" > /dev/null 2>&1; then
      cma_ok ".app codesigned"
    else
      cma_warn ".app codesign check FAILED — Dock launch will be silently rejected"
      issues+=("codesign-broken")
    fi

    # 4a. Bundle-id parity — the Dock groups by CFBundleIdentifier. If the
    # clone's plist doesn't match the expected per-instance id, Dock icons
    # will collide with the primary or with the wrong mirror.
    if [[ -f "$app/Contents/Info.plist" ]]; then
      local actual_bid
      actual_bid="$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist" 2> /dev/null || printf '%s' '<unreadable>')"
      if [[ "$actual_bid" == "$bid" ]]; then
        cma_ok "bundle-id parity: $actual_bid"
      else
        cma_warn "bundle-id drift — expected $bid, got $actual_bid; repair required"
        issues+=("bundle-id-drift")
      fi

      # 4b. Clone Claude version vs primary Claude version — Squirrel updates
      # Claude Desktop under the primary but our clone is a snapshot from the
      # time of the last `build-clone-app.sh` run. Version drift is why the
      # WatchPaths-driven refresh-clones agent exists; surface it in doctor so
      # a user can trigger it manually if it hasn't fired.
      local clone_ver primary_ver=""
      clone_ver="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist" 2> /dev/null || printf '%s' '<unreadable>')"
      if [[ -f "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" ]]; then
        primary_ver="$(plutil -extract CFBundleShortVersionString raw "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" 2> /dev/null || printf '%s' '<unreadable>')"
      fi
      if [[ -n "$primary_ver" && "$clone_ver" != "$primary_ver" ]]; then
        cma_warn "Claude version drift: clone=$clone_ver primary=$primary_ver — run \`claude-multiacct refresh-clones\`"
        issues+=("version-drift")
      else
        cma_dim "  Claude version: $clone_ver (matches primary)"
      fi
    else
      cma_warn "Info.plist missing under .app bundle"
      issues+=("info-plist-missing")
    fi

    # Note: com.apple.provenance is a PROTECTED xattr on modern macOS (2026-07-13
    # verified: `xattr -d/-c` returns 0 but the xattr persists — SIP-adjacent).
    # It's cosmetically-flagged but NOT actually blocking: `open -b <bundleId>`
    # against a provenance-tagged ad-hoc bundle DOES launch (verified same day).
    # Report presence for information only; do NOT add to issues.
    if xattr -lr "$app" 2> /dev/null | grep -q '^[^:]*: com\.apple\.provenance'; then
      cma_dim "  com.apple.provenance xattr present (informational — modern macOS protects it; launch still works)"
    fi

    # 4c. Asar patch state — lib/asar-patch-clone.sh appends the mirror's
    # managed-prefs plist path to the bXt() list inside the bundled JS. Without
    # this, Squirrel's auto-updater fires against Anthropic's Developer ID
    # designated requirement, rejects the DR-mismatch on our ad-hoc signature,
    # and the mirror menu-click shows "Failed to check for updates". Three
    # signals must all be present for the patch to be effective:
    #   - Per-mirror plist file on disk
    #   - `disableAutoUpdates=true` inside it (the flatKey Claude Desktop's
    #     managed-config schema reads for autoUpdate.disabled)
    #   - `claude-multiacct-mirror-prefs.plist` byte-visible inside the asar
    #     (the string search doesn't need extraction — asar files store the
    #     raw JS bodies concatenated after a JSON header, and our append is
    #     an ASCII-only string).
    #
    # Header hash integrity IS separately enforced at boot by Electron's
    # ElectronAsarIntegrity check (electron/asar/asar_util.cc:143) — if the
    # rewrite left the plist hash stale we'd see the mirror fatal-exit before
    # its window opens. Boot-time enforcement is stronger than any doctor
    # check, so we surface only the "was the patch applied?" signal here.
    local mirror_plist="$app/Contents/Resources/claude-multiacct-mirror-prefs.plist"
    local asar_file="$app/Contents/Resources/app.asar"
    local patch_ok=1
    if [[ ! -f "$mirror_plist" ]]; then
      cma_warn "asar-patch: mirror-prefs plist MISSING at $mirror_plist — auto-updates NOT disabled"
      issues+=("asar-patch-plist-missing")
      patch_ok=0
    else
      if ! /usr/libexec/PlistBuddy -c 'Print :disableAutoUpdates' "$mirror_plist" 2> /dev/null | grep -qx true; then
        cma_warn "asar-patch: mirror-prefs plist present but disableAutoUpdates != true"
        issues+=("asar-patch-plist-value")
        patch_ok=0
      fi
      # Managed-tier signal for Remote-Control auto-enable. Belt-and-braces
      # with the User-tier settings.json check emitted earlier in this function;
      # either tier alone is enough (SettingsResolver.j$n merges tiers) but
      # doctor surfaces both so an operator can see which routes are wired up.
      if ! /usr/libexec/PlistBuddy -c 'Print :remoteControlAtStartup' "$mirror_plist" 2> /dev/null | grep -qx true; then
        cma_warn "asar-patch: mirror-prefs plist missing remoteControlAtStartup=true — Managed-tier auto-enable NOT wired"
        issues+=("asar-patch-plist-remote-control-missing")
        patch_ok=0
      fi
    fi
    if [[ -f "$asar_file" ]] && ! grep -qF 'claude-multiacct-mirror-prefs.plist' "$asar_file" 2> /dev/null; then
      cma_warn "asar-patch: bXt() marker NOT present inside app.asar — Squirrel auto-poll not suppressed"
      issues+=("asar-patch-marker-missing")
      patch_ok=0
    fi
    # Chunk X-B — session-propagation IIFE marker. Injected into
    # index.chunk-BpZff9Dw.js (the LocalSessionManager singleton chunk) by
    # asar-patch-clone.sh's _asar_inject_session_propagation. The marker
    # string is a comment header so it's byte-visible inside the asar (asar
    # stores raw JS bodies concatenated after a JSON header — same reason
    # the mirror-prefs marker check above uses `grep -F` on the archive).
    # Absence = the mirror's LocalSessionManager isn't watching its sessions
    # dir, so cross-process mutations from primary/peer mirrors won't be
    # reflected in this mirror's sidebar until quit+relaunch. See
    # docs/architecture.md § "Real-time session-state propagation".
    if [[ -f "$asar_file" ]] && ! grep -qF 'claude-multiacct-session-propagation' "$asar_file" 2> /dev/null; then
      cma_warn "asar-patch: session-propagation marker NOT present inside app.asar — cross-process session mutations won't reflect until quit+relaunch"
      issues+=("asar-patch-propagation-missing")
      patch_ok=0
    fi
    if [[ $patch_ok -eq 1 ]]; then
      cma_ok "asar-patch: auto-updates disabled + Remote Control auto-enable + session-propagation via per-mirror plist"
    fi
    # Check LaunchServices registration.
    if "$LSREGISTER" -dump 2> /dev/null | grep -F "$app" > /dev/null; then
      cma_ok "registered with LaunchServices"
    else
      cma_warn ".app NOT registered with LaunchServices (Dock launch will fail)"
      issues+=("ls-not-registered")
    fi
  else
    cma_warn ".app bundle missing: $app"
    issues+=("app-missing")
  fi

  local health="ok"
  [[ ${#issues[@]} -eq 0 ]] || health="degraded"
  [[ -z "${_cma_quiet:-}" ]] && cma_dim "  → $health"

  if [[ $TSV -eq 1 ]]; then
    local issues_joined=""
    [[ ${#issues[@]} -eq 0 ]] || issues_joined="$(
      IFS=,
      printf '%s' "${issues[*]}"
    )"
    printf '%s\t%s\t%s\n' "$label" "$health" "$issues_joined"
  fi

  if [[ $JSON -eq 1 ]]; then
    # Build the JSON object for this instance. Issues become a JSON array of
    # short kebab-slug strings (they never contain quotes / newlines, so
    # trivial escaping suffices).
    local issues_json="[]"
    if [[ ${#issues[@]} -gt 0 ]]; then
      local first=1 iss
      issues_json="["
      for iss in "${issues[@]}"; do
        [[ $first -eq 1 ]] || issues_json+=","
        first=0
        issues_json+="\"$(_json_esc "$iss")\""
      done
      issues_json+="]"
    fi
    _json_rows+=(
      "{\"label\":\"$(_json_esc "$label")\",\"email\":\"$(_json_esc "$email")\",\"configDir\":\"$(_json_esc "$cdir")\",\"userData\":\"$(_json_esc "$udata")\",\"health\":\"$health\",\"issues\":$issues_json}"
    )
  fi
}

main() {
  # If no config file, only report the primary state.
  if [[ ! -f "$CMA_CONFIG_FILE" ]]; then
    if [[ $JSON -eq 1 ]]; then
      printf '[]\n'
    else
      cma_warn "no config file at $CMA_CONFIG_FILE — run \`claude-multiacct init\`"
    fi
    return 0
  fi
  local label
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    check_one "$label"
  done < <(cma_list_labels)

  if [[ $JSON -eq 1 ]]; then
    # Join the per-instance rows into a JSON array. Using printf + IFS keeps
    # the join in pure bash (no jq dependency — see metadata-symlinks.sh note
    # on why jq is deliberately avoided in this repo).
    if [[ ${#_json_rows[@]} -eq 0 ]]; then
      printf '[]\n'
    else
      local joined
      joined="$(
        IFS=,
        printf '%s' "${_json_rows[*]}"
      )"
      printf '[%s]\n' "$joined"
    fi
  fi
}

main "$@"
