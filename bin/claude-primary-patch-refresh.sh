#!/usr/bin/env bash
# bin/claude-primary-patch-refresh.sh — launchd-invokable re-patch of the
# primary /Applications/Claude.app after a Squirrel drop-replace. Triggered
# by the com.user.claude-primary-patch-refresh WatchPaths agent on
# /Applications/Claude.app/Contents/Info.plist mtime change.
#
# Why this agent is genuinely useful now:
#   The loose-DR re-sign keeps the primary Squirrel-updatable, so updates
#   ACTUALLY APPLY. Squirrel overwrites the primary bundle with a fresh
#   Anthropic-signed pristine → Info.plist mtime bumps → this agent fires.
#   The agent DELETES the multiacct-owned pristine snapshots (they hold the
#   OLD version's bytes, not the new one's), then invokes `claude-multiacct
#   primary-patch`. `_asar_snapshot_primary_bundle` in the patch pipeline
#   detects the missing snapshots and captures the NEW pristine before
#   re-applying the patch + loose-DR re-sign.
#
# Serialization with clone-refresh:
#   Both this agent and com.user.claude-clone-refresh WatchPaths the same
#   Info.plist. To keep clone-refresh's ditto from capturing a mid-patch
#   primary, both scripts share a flock at /tmp/claude-multiacct-refresh.lock.
#   This script acquires the lock EXCLUSIVELY for the entire patch run so
#   clone-refresh (which acquires the same lock) blocks until primary is
#   fully re-patched — meaning clone-refresh always ditto's the ALREADY-PATCHED
#   primary and the mirror's own asar-patch no-ops on the idempotency check.
#
# Live-primary guard:
#   `claude-multiacct primary-patch` refuses to run while the primary is up
#   (re-sign vs. mmap race). This script therefore no-ops loudly when the
#   primary is running — Squirrel restarts the primary as part of the update,
#   so the WatchPaths fire may catch a moment where the new pristine is on
#   disk but the new primary isn't up yet, OR a moment where it is. In the
#   second case the operator sees "primary running, skipping" in the log and
#   can quit + re-run manually. ThrottleInterval=60 gates log spam.

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

# Acquire the shared refresh lock. -x = exclusive (default for flock <fd>),
# -w would add a timeout; a plain blocking flock is what we want. Two agents
# contending for the same lock serialize cleanly; the loser blocks here until
# the winner exits (releases the FD the lock is tied to).
#
# macOS does not ship `flock` on stock PATH (it's a util-linux binary via
# Homebrew). Detect + fall back to an atomic-mkdir lockfile when flock is
# absent (still safe under ThrottleInterval — a losing loop iteration just
# gets rescheduled after 60 s).
if command -v flock > /dev/null 2>&1; then
  exec 200> "$LOCK"
  flock 200
else
  if ! mkdir "$LOCK.d" 2> /dev/null; then
    log "another refresh is in progress (lock $LOCK.d present); no-op this fire"
    log "=== launchd-triggered primary-patch-refresh end (rc=0, skipped) ==="
    exit 0
  fi
  # shellcheck disable=SC2064  # deliberate: expand LOCK now, not at trap time
  trap "rmdir '$LOCK.d' 2>/dev/null || true" EXIT
fi

# Primary-running guard. The patch script enforces this too, but mirroring it
# here records WHY we no-op'd rather than leaving a bare cma_die trace.
# shellcheck disable=SC2310  # deliberate: predicate consumed as if-condition (set -e off inside is intentional)
if cma_primary_claude_running; then
  log "primary Claude Desktop is running; skipping re-patch (quit primary + retry manually via \`claude-multiacct primary-patch\`)"
  log "=== launchd-triggered primary-patch-refresh end (rc=0, skipped) ==="
  exit 0
fi

# The Squirrel drop has captured a NEW pristine app.asar + app.asar.unpacked on
# disk. Delete the stale snapshots so `_asar_snapshot_primary_bundle` in the
# patch pipeline captures the fresh pristine before we re-inject + re-sign.
# BOTH snapshots must go — restoring a stale app.asar.unpacked over a new
# version's native modules would blank the app.
RES="/Applications/Claude.app/Contents/Resources"
for stale in "$RES/app.asar.multiacct-backup" "$RES/app.asar.unpacked.multiacct-backup"; do
  if [[ -e "$stale" ]]; then
    log "deleting stale snapshot $stale so patch pipeline captures the fresh Squirrel-installed pristine"
    rm -rf "$stale"
  fi
done

# Invoke the CLI primary-patch subcommand. Forward its rc.
rc=0
# shellcheck disable=SC2310  # deliberate: consume the rc via the assignment even under set -e
"$CMA_BIN/claude-multiacct" primary-patch >> "$LOG" 2>&1 || rc=$?

log "=== launchd-triggered primary-patch-refresh end (rc=$rc) ==="

exit "$rc"
