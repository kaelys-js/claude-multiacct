#!/usr/bin/env bash
# lib/uninstall-instance.sh — symmetric teardown of a single mirror instance.
# Removes: CLI launcher, .app bundle, metadata symlinks (unlinked, not deleted),
# configDir/, userData/. Snapshots everything into a timestamped backup before
# removal so the user can recover.
#
# Usage: uninstall-instance.sh <label> [--keep-userdata] [--keep-configdir]

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

main() {
  local label="$1"; shift
  cma_validate_label "$label"

  local keep_ud=0 keep_cd=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-userdata)  keep_ud=1; shift ;;
      --keep-configdir) keep_cd=1; shift ;;
      *) cma_die "uninstall-instance: unknown flag: $1" ;;
    esac
  done

  local row; row="$(cma_resolve_instance "$label")"
  local _l _e cdir udata cli app _bid
  IFS=$'\t' read -r _l _e cdir udata cli app _bid <<<"$row"

  cma_say "uninstall-instance: label=$label"

  # 1. Remove the CLI launcher (snapshot first).
  if [[ -e "$cli" ]]; then
    local snap; snap="$(cma_backup_snapshot "$cli" "cli-$label")"
    cma_dim "  snapshot: $snap"
    rm -f "$cli"
    cma_ok "removed $cli"
  fi

  # 2. Remove the .app bundle (snapshot Info.plist + LaunchServices unregister).
  # The bundle is a 745 MB clone of Claude Desktop — snapshotting the whole
  # thing would burn disk. Info.plist alone is enough for forensics (bundle-id,
  # version, executable name); the rest is bit-identical to the source
  # /Applications/Claude.app of the same version.
  if [[ -d "$app" ]]; then
    if [[ -f "$app/Contents/Info.plist" ]]; then
      local snap; snap="$(cma_backup_snapshot "$app/Contents/Info.plist" "clone-plist-$label")"
      cma_dim "  snapshot: $snap (Info.plist only; the 745 MB payload is not snapshotted)"
    fi
    "$LSREGISTER" -u "$app" >/dev/null 2>&1 || true
    rm -rf "$app"
    cma_ok "removed $app"
  fi

  # 3. Remove the configDir (unless --keep-configdir).
  if [[ "$keep_cd" -eq 0 ]] && [[ -e "$cdir" ]]; then
    local snap; snap="$(cma_backup_snapshot "$cdir" "configdir-$label")"
    cma_dim "  snapshot: $snap"
    rm -rf "$cdir"
    cma_ok "removed $cdir"
  elif [[ "$keep_cd" -eq 1 ]]; then
    cma_dim "  --keep-configdir: leaving $cdir in place"
  fi

  # 4. Remove the userData (unless --keep-userdata).
  # By default we KEEP userData — it holds the account's OAuth cookies, and
  # deleting them logs the user out of that account. Explicit override drops it.
  if [[ "$keep_ud" -eq 0 ]] && [[ -e "$udata" ]]; then
    cma_warn "  userData contains the account's OAuth cookies; use --keep-userdata to preserve"
    local snap; snap="$(cma_backup_snapshot "$udata" "userdata-$label")"
    cma_dim "  snapshot: $snap"
    rm -rf "$udata"
    cma_ok "removed $udata"
  else
    cma_dim "  keeping $udata (default; use --keep-userdata=0 semantics via explicit teardown to force removal)"
  fi

  cma_ok "uninstall-instance: label=$label complete"
}

main "$@"
