#!/usr/bin/env bash
# bin/claude-clone-refresh.sh — launchd-invokable rebuild of every mirror
# clone from the current /Applications/Claude.app. Triggered by the
# WatchPaths agent on /Applications/Claude.app/Contents/Info.plist (Squirrel
# rewrites this file on every Claude Desktop update).
#
# This is a thin wrapper over `claude-multiacct refresh-clones` — the actual
# rebuild logic lives in the CLI so it stays testable via the CLI's own
# subcommand.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
CMA_BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/clone-refresh.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

log "=== launchd-triggered clone refresh begin ==="

# The CLI subcommand handles the mirror-running guard, the per-instance loop,
# and per-clone codesign + lsregister. We just call it and forward its rc.
rc=0
# shellcheck disable=SC2310  # assign rc from the subcommand's exit even under set -e
"$CMA_BIN/claude-multiacct" refresh-clones >> "$LOG" 2>&1 || rc=$?

log "=== launchd-triggered clone refresh end (rc=$rc) ==="

exit "$rc"
