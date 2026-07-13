#!/usr/bin/env bash
# lib/discover.sh — inspect on-disk state of all instances. Emits a health
# report + machine-parseable TSV (via --tsv). Used by `list` and `doctor`.
#
# Usage:
#   discover.sh                # human report to stderr, no output to stdout
#   discover.sh --tsv          # TSV to stdout: label\thealth\tissues

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

TSV=0
[[ "${1:-}" == "--tsv" ]] && TSV=1

# Check a single instance and print a report + optionally a TSV row.
check_one() {
  local label="$1"
  local row; row="$(cma_resolve_instance "$label")"
  local _l email cdir udata cli app bid
  IFS=$'\t' read -r _l email cdir udata cli app bid <<<"$row"

  local issues=()

  cma_say "instance: $label"
  cma_dim "  email:       $email"
  cma_dim "  configDir:   $cdir"
  cma_dim "  userData:    $udata"

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
  else
    cma_warn "configDir missing"
    issues+=("configdir-missing")
  fi

  # 2. userData
  if [[ -d "$udata" ]]; then
    cma_ok "userData exists"
    local ccs="$udata/claude-code-sessions"
    if [[ -d "$ccs" ]]; then
      local acct; acct="$(find "$ccs" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
      if [[ -n "$acct" ]]; then
        cma_ok "logged in (account UUID: $(basename "$acct"))"
        local org; org="$(find "$acct" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)"
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
    if codesign -v "$app" >/dev/null 2>&1; then
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
      actual_bid="$(plutil -extract CFBundleIdentifier raw "$app/Contents/Info.plist" 2>/dev/null || printf '%s' '<unreadable>')"
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
      clone_ver="$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist" 2>/dev/null || printf '%s' '<unreadable>')"
      if [[ -f "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" ]]; then
        primary_ver="$(plutil -extract CFBundleShortVersionString raw "$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist" 2>/dev/null || printf '%s' '<unreadable>')"
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
    if xattr -lr "$app" 2>/dev/null | grep -q '^[^:]*: com\.apple\.provenance'; then
      cma_dim "  com.apple.provenance xattr present (informational — modern macOS protects it; launch still works)"
    fi
    # Check LaunchServices registration.
    if "$LSREGISTER" -dump 2>/dev/null | grep -F "$app" >/dev/null; then
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
  cma_dim "  → $health"

  if [[ $TSV -eq 1 ]]; then
    local issues_joined=""
    [[ ${#issues[@]} -eq 0 ]] || issues_joined="$(IFS=,; printf '%s' "${issues[*]}")"
    printf '%s\t%s\t%s\n' "$label" "$health" "$issues_joined"
  fi
}

main() {
  # If no config file, only report the primary state.
  if [[ ! -f "$CMA_CONFIG_FILE" ]]; then
    cma_warn "no config file at $CMA_CONFIG_FILE — run \`claude-multiacct init\`"
    return 0
  fi
  local label
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    check_one "$label"
  done < <(cma_list_labels)
}

main "$@"
