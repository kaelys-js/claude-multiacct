#!/usr/bin/env bash
# bin/claude-metadata-watcher.sh — launchd fire-handler for
# com.user.claude-metadata-symlink. Iterates every configured mirror and runs
# lib/metadata-symlinks.sh on it; already-installed symlinks are a no-op, and
# mirrors that haven't signed in yet skip cleanly (metadata-symlinks.sh returns
# 0 with a "not logged in yet" warn). One mirror's failure does not skip the
# others.
#
# Triggered by launchd on any mutation under a mirror's
# <userData>/claude-code-sessions or <userData>/local-agent-mode-sessions —
# i.e. the moment Claude Desktop creates the per-account UUID subdir on
# sign-in. ThrottleInterval=15 in the plist coalesces mutation bursts.
#
# Log path: $CMA_LOG_DIR/metadata-watcher.log.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/metadata-watcher.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

main() {
  cma_require yq

  if [[ ! -f "$CMA_CONFIG_FILE" ]]; then
    log "SKIP: no config file at $CMA_CONFIG_FILE"
    return 0
  fi

  log "=== metadata-watcher begin ==="

  local processed=0 errored=0
  local label
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    processed=$((processed + 1))
    # shellcheck disable=SC2310  # continue with next mirror on one's failure
    if "$CMA_LIB/metadata-symlinks.sh" "$label" >>"$LOG" 2>&1; then
      log "  ok $label"
    else
      log "  ERR $label (rc=$?)"
      errored=$((errored + 1))
    fi
  done < <(cma_list_labels)

  log "=== metadata-watcher end (processed=$processed errored=$errored) ==="

  # A per-mirror failure is logged but we return 0 — launchd should not treat
  # a partial run as a systemic failure (which would inhibit re-firing).
  return 0
}

main "$@"
