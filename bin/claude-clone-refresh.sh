#!/usr/bin/env bash
# bin/claude-clone-refresh.sh — launchd-invokable rebuild of every mirror
# clone from the current /Applications/Claude.app. Triggered by the
# WatchPaths agent on /Applications/Claude.app/Contents/Info.plist (Squirrel
# rewrites this file on every Claude Desktop update).
#
# This is a thin wrapper over `claude-multiacct refresh-clones` — the actual
# rebuild logic lives in the CLI so it stays testable via the CLI's own
# subcommand.
#
# Self-serialization:
#   A rapid succession of Info.plist mtime bumps (Squirrel writes the file
#   more than once during a single update) can fire this agent twice in quick
#   succession. A flock at /tmp/claude-multiacct-refresh.lock serializes the
#   fires so two ditto passes never race over the same clone bundle.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
CMA_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/clone-refresh.log"
LOCK="/tmp/claude-multiacct-refresh.lock"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Acquire the refresh lock so overlapping fires serialize (see script header).
# flock blocks; mkdir-based fallback is used on stock macOS where flock isn't
# on PATH.
if command -v flock > /dev/null 2>&1; then
  exec 200> "$LOCK"
  flock 200
else
  if ! mkdir "$LOCK.d" 2> /dev/null; then
    log "another refresh is in progress (lock $LOCK.d present); no-op this fire"
    exit 0
  fi
  # shellcheck disable=SC2064  # deliberate: expand LOCK now, not at trap time
  trap "rmdir '$LOCK.d' 2>/dev/null || true" EXIT
fi

log "=== launchd-triggered clone refresh begin ==="

# The CLI subcommand handles the mirror-running guard, the per-instance loop,
# and per-clone codesign + lsregister. We just call it and forward its rc.
rc=0
# shellcheck disable=SC2310  # assign rc from the subcommand's exit even under set -e
"$CMA_BIN/claude-multiacct" refresh-clones >> "$LOG" 2>&1 || rc=$?

log "=== launchd-triggered clone refresh end (rc=$rc) ==="

exit "$rc"
