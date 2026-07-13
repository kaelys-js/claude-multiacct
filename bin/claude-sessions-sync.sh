#!/usr/bin/env bash
# bin/claude-sessions-sync.sh — one-way rsync of Chromium state (IndexedDB +
# Local Storage + Session Storage) from the primary Claude Desktop instance to
# every configured mirror. Called by the launchd WatchPaths agent on primary
# close (Chromium rewrites Local State on exit) and manually via
# `claude-multiacct sync-now`.
#
# Safety invariants:
#   - Refuses to run if the primary is still running (would rsync mid-flight LevelDB writes).
#   - Refuses to run if ANY mirror is running (a mirror-owned rsync destination is invalid).
#   - 5s grace after the trigger to let Chromium finish flushing LevelDB.
#   - Never touches Cookies, Preferences, Network Persistent State, or Crashpad.
#   - Only rsyncs the three LevelDB-backed directories that hold web-chat cache.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/sessions-sync.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

# Sync a single primary → mirror pair.
sync_one() {
  local mirror_label="$1"
  local row; row="$(cma_resolve_instance "$mirror_label")"
  local _l _e _cdir m_udata _cli _app _bid
  IFS=$'\t' read -r _l _e _cdir m_udata _cli _app _bid <<<"$row"

  local p_udata; p_udata="$(cma_primary_userdata)"

  if [[ ! -d "$p_udata" ]]; then
    log "  ✗ primary userData missing at $p_udata — skip $mirror_label"
    return 1
  fi
  if [[ ! -d "$m_udata" ]]; then
    log "  ✗ mirror userData missing at $m_udata — skip $mirror_label"
    return 1
  fi

  log "=== begin sync primary → $mirror_label ==="

  local sub
  for sub in "IndexedDB" "Local Storage" "Session Storage"; do
    if [[ ! -d "$p_udata/$sub" ]]; then
      log "  · primary $sub missing — skipping (nothing to copy yet)"
      continue
    fi
    # `--delete` mirrors the exact primary state so a session removed on primary
    # is removed on mirror. Preserves inode-level flags via -a.
    if rsync -a --delete "$p_udata/$sub/" "$m_udata/$sub/" 2>>"$LOG"; then
      log "  ✓ $sub"
    else
      log "  ✗ $sub — rsync failed (see stderr above)"
      return 1
    fi
  done

  log "=== sync complete primary → $mirror_label ==="
  return 0
}

main() {
  cma_require rsync
  cma_require yq

  # Skip if any Claude Desktop is running. `pgrep -f 'com.anthropic.claudefordesktop|Claude Helper'`
  # matches both the primary and any mirror since they share the same executable.
  # SC2310 disable — assigning the pgrep rc explicitly avoids the pattern.
  local claude_running=0
  pgrep -f 'com.anthropic.claudefordesktop|Claude Helper' >/dev/null 2>&1 && claude_running=1
  if [[ $claude_running -eq 1 ]]; then
    log "SKIP: at least one Claude Desktop instance is running (would rsync mid-flight state)"
    return 0
  fi

  # 5s grace for Chromium to finish flushing LevelDB from the trigger.
  sleep 5

  if [[ ! -f "$CMA_CONFIG_FILE" ]]; then
    log "SKIP: no config file at $CMA_CONFIG_FILE"
    return 0
  fi

  local rc=0
  local label sync_rc
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    sync_rc=0
    # shellcheck disable=SC2310  # deliberate: continue with next mirror on one's failure
    sync_one "$label" || sync_rc=$?
    [[ $sync_rc -eq 0 ]] || rc=1
  done < <(cma_list_labels)

  return "$rc"
}

main "$@"
