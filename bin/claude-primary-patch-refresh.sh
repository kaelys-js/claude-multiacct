#!/usr/bin/env bash
# bin/claude-primary-patch-refresh.sh — launchd-invokable re-patch of the
# primary /Applications/Claude.app after a Squirrel drop-replace. Triggered
# by the com.user.claude-primary-patch-refresh WatchPaths agent on
# /Applications/Claude.app/Contents/Info.plist mtime change.
#
# Squirrel-cycle semantics:
#   Squirrel overwrites the primary bundle with a fresh Anthropic-signed
#   pristine → Info.plist mtime bumps → this agent fires. The agent DELETES
#   the multiacct-owned app.asar.multiacct-backup (since it now holds the
#   OLD version's pristine bytes, not the new one's), then invokes
#   `claude-multiacct primary-patch`. `_asar_snapshot_primary_backup` in
#   the patch pipeline detects the missing backup and captures the NEW
#   pristine before applying the patch.
#
# Serialization with clone-refresh:
#   Both this agent and com.user.claude-clone-refresh WatchPaths the same
#   Info.plist. To keep clone-refresh's ditto from capturing a mid-patch
#   primary, both scripts share a flock at /tmp/claude-multiacct-refresh.lock.
#   This script acquires the lock EXCLUSIVELY for the entire patch run so
#   clone-refresh (which acquires the same lock) blocks until primary is
#   fully re-patched.
#
# Live-primary guard:
#   `claude-multiacct primary-patch` refuses to run while the primary is
#   up (codesign vs. mmap race). This script therefore no-ops loudly when
#   the primary is running — Squirrel restarts the primary AS PART OF the
#   update, so the WatchPaths fire may catch a moment where the new pristine
#   is written but the new primary isn't up yet, OR a moment where the new
#   primary is up. In the second case, the operator sees "primary running,
#   skipping" in the log and can quit + re-run manually. Retrying every
#   ThrottleInterval would spam the log; ThrottleInterval=60 gates that.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
CMA_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/primary-patch-refresh.log"
LOCK="/tmp/claude-multiacct-refresh.lock"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

log "=== launchd-triggered primary-patch-refresh begin ==="

# Acquire the shared refresh lock. -x = exclusive, -w = wait (no timeout).
# Two agents contending for the same lock serialize cleanly; the loser
# blocks here until the winner exits (releases the FD, which flock ties
# the lock to). See lock docs at
# https://man7.org/linux/man-pages/man2/flock.2.html for the exact
# semantics on macOS's BSD-derived flock.
#
# macOS ships `flock` as a symlink to util-linux's binary via Homebrew, but
# NOT stock. Detect + fall back to a lockfile-loop when flock isn't on PATH
# (still safe under launchd's ThrottleInterval — a losing loop iteration
# just gets rescheduled after 60 s).
if command -v flock > /dev/null 2>&1; then
  exec 200> "$LOCK"
  flock 200
else
  # Poor-man's lock: mkdir is atomic, no external tool required. Skip when
  # already held so a launchd re-fire during a running patch just no-ops.
  if ! mkdir "$LOCK.d" 2> /dev/null; then
    log "another refresh is in progress (lock $LOCK.d present); no-op this fire"
    log "=== launchd-triggered primary-patch-refresh end (rc=0, skipped) ==="
    exit 0
  fi
  # shellcheck disable=SC2064  # deliberate: expand LOCK now, not at trap time
  trap "rmdir '$LOCK.d' 2>/dev/null || true" EXIT
fi

# Primary-running guard. Deferred to the patch script itself but we mirror
# the check here so the log clearly records WHY we no-op'd rather than
# leaving a bare "cma_die: primary running" trace.
# shellcheck disable=SC2310  # deliberate: predicate consumed as if-condition (set -e off inside is intentional)
if cma_primary_claude_running; then
  log "primary Claude Desktop is running; skipping re-patch (quit primary + retry manually via \`claude-multiacct primary-patch\`)"
  log "=== launchd-triggered primary-patch-refresh end (rc=0, skipped) ==="
  exit 0
fi

# The Squirrel drop has captured a NEW pristine app.asar on disk. Delete the
# stale backup so `_asar_snapshot_primary_backup` in the patch pipeline
# captures the fresh pristine before we re-inject.
BACKUP="/Applications/Claude.app/Contents/Resources/app.asar.multiacct-backup"
if [[ -f "$BACKUP" ]]; then
  log "deleting stale backup $BACKUP so patch pipeline captures the fresh Squirrel-installed pristine"
  rm -f "$BACKUP"
fi

# Invoke the CLI primary-patch subcommand. Forward its rc.
rc=0
# shellcheck disable=SC2310  # deliberate: consume the rc via the assignment even under set -e
"$CMA_BIN/claude-multiacct" primary-patch >> "$LOG" 2>&1 || rc=$?

log "=== launchd-triggered primary-patch-refresh end (rc=$rc) ==="

exit "$rc"
