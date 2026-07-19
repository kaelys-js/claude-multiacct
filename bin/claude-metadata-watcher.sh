#!/usr/bin/env bash
# bin/claude-metadata-watcher.sh — launchd fire-handler for
# com.user.claude-metadata-symlink. Iterates every configured mirror and runs
# lib/metadata-symlinks.sh on it; already-installed symlinks are a no-op, and
# mirrors that haven't signed in yet skip cleanly (metadata-symlinks.sh returns
# 0 with a "not logged in yet" warn). One mirror's failure does not skip the
# others.
#
# After a successful pass whose symlinks are now on disk, the watcher also
# writes a sentinel at <mirror_userData>/.claude-multiacct/symlinks-installed
# and — if this was the FIRST such pass for that mirror AND the mirror process
# is currently running — quits + relaunches the mirror. Desktop's React sidebar
# caches the mirror's session dir on app-start and does not retroactively pick
# up symlinks that appear mid-run; the auto-restart closes the last piece of
# manual UX from the mirror-first-signin flow. Subsequent fires observe the
# sentinel and skip the restart branch.
#
# Triggered by launchd on any mutation under a mirror's
# <userData>/claude-code-sessions or <userData>/local-agent-mode-sessions
# or <userData>/config.json — the moment Claude Desktop caches the OAuth
# token on sign-in (or creates the per-account UUID subdir on Code first-use).
# ThrottleInterval=15 in the plist coalesces mutation bursts.
#
# WatchPaths / CMA_AUTO_RESTART reconciliation (C1):
#   config.json stays in WatchPaths BECAUSE it is the post-OAuth / pre-Code
#   trigger — Desktop writes it on sign-in, well before the user opens Code,
#   which is what lets the symlink install happen the moment sign-in completes.
#   The downside is that config.json is rewritten many times during Desktop's
#   sign-in write-burst, so this handler fires repeatedly on a fresh sign-in.
#   The symlink install + sentinel write are idempotent and safe to repeat on
#   every fire. The auto quit+relaunch is NOT safe to repeat against a live
#   mirror, so it is gated behind CMA_AUTO_RESTART (default 0/off, plumbed via
#   the plist EnvironmentVariables) and additionally sentinel-gated to fire at
#   most once. Default-off means a first sign-in installs symlinks + sentinel
#   silently and the user relaunches the mirror by hand to refresh the sidebar.
#
# Env seams for hermetic tests:
#   CMA_AUTO_RESTART   — 1 opts into the auto quit+relaunch of a live mirror on
#                        first symlink install. Default 0 (off): install the
#                        symlinks + sentinel but never TERM/relaunch.
#   CMA_RESTART_WAIT_S — cap on the graceful-shutdown wait (default 5s).
#                        Bats overrides to e.g. 0.2 to keep tests fast.
#
# Log path: $CMA_LOG_DIR/metadata-watcher.log.

set -euo pipefail

CMA_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"
# shellcheck source=../lib/common.sh
. "$CMA_LIB/common.sh"

LOG="$CMA_LOG_DIR/metadata-watcher.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# Does the mirror have any org-level symlink installed under
# <userData>/claude-code-sessions/<acct>/<org>? Returns 0 if yes, 1 if no. Used
# to tell apart a real install (which we should sentinel-gate + maybe restart
# for) from a pre-signin skip (metadata-symlinks returns 0 in both cases). The
# post-install layout is <ccs>/<acct>/<org> where <org> is a symlink — hence
# -mindepth 2 -maxdepth 2 -type l.
mirror_has_symlinks() {
  local m_udata="$1"
  local ccs="$m_udata/claude-code-sessions"
  [[ -d "$ccs" ]] || return 1
  find "$ccs" -mindepth 2 -maxdepth 2 -type l 2> /dev/null | grep -q . || return 1
  return 0
}

# Post-install hook: write the sentinel, then auto-restart the mirror if this
# was its first symlink install AND the mirror is currently running. Called
# after metadata-symlinks.sh returns rc=0 for <label>.
#   - first_install is captured BEFORE anything else by sentinel presence.
#   - If no symlinks are actually on disk (pre-signin skip), we do nothing —
#     the next fire, once OAuth completes, handles it.
#   - Sentinel is written on every fire where symlinks are present, so a
#     mirror that already had symlinks pre-b095035 becomes "already installed"
#     after this pass and never triggers auto-restart. That's the safe default.
#   - Auto-restart pattern targets ONLY the mirror: the mirror's argv includes
#     `--user-data-dir=<mirror_userData>` (injected by the shell wrapper in
#     Contents/MacOS/Claude); the primary's argv NEVER carries that flag.
#     A pkill -f on that pattern therefore cannot kill the primary.
handle_first_install() {
  local label="$1" m_udata="$2" m_app="$3"
  local sentinel_dir="$m_udata/.claude-multiacct"
  local sentinel="$sentinel_dir/symlinks-installed"

  # Capture BEFORE any write. Sentinel is our "we already did the first install
  # auto-restart for this mirror" flag.
  local first_install=0
  [[ -e "$sentinel" ]] || first_install=1

  # shellcheck disable=SC2310  # deliberate: mirror_has_symlinks returns non-zero for the pre-signin skip, which is expected — not an error we propagate.
  if ! mirror_has_symlinks "$m_udata"; then
    log "  $label: no symlinks resolved yet (pre-signin) — sentinel not written"
    return 0
  fi

  # Write the sentinel. Future fires observe it and skip auto-restart.
  mkdir -p "$sentinel_dir"
  touch "$sentinel"

  if [[ $first_install -eq 0 ]]; then
    log "  $label: sentinel present (previous install) — skip auto-restart"
    return 0
  fi

  # C1 — the auto quit+relaunch is OPT-IN (CMA_AUTO_RESTART=1). The symlink
  # install + sentinel above happen on EVERY fire regardless; only the
  # disruptive TERM+relaunch of a live mirror is gated. Default OFF: during
  # Desktop's sign-in write-bursts the config.json WatchPath fires this
  # handler repeatedly, and an unexpected TERM of the user's live mirror is
  # worse than the one-time manual "quit+relaunch to refresh the sidebar"
  # step. The plist's EnvironmentVariables carries the default (0); operators
  # who want the hands-off restart install with CMA_AUTO_RESTART=1.
  if [[ "${CMA_AUTO_RESTART:-0}" != "1" ]]; then
    log "  $label: first symlink install but CMA_AUTO_RESTART!=1 — sentinel written, skipping auto quit+relaunch (relaunch the mirror manually to refresh its sidebar)"
    return 0
  fi

  # First install path. Match ONLY the mirror by its --user-data-dir arg.
  local match_pattern="--user-data-dir=$m_udata"
  if ! pgrep -f "$match_pattern" > /dev/null 2>&1; then
    log "  $label: mirror not running — first launch will pick up symlinks naturally"
    return 0
  fi

  log "  $label: auto-restarting mirror (first symlink install)"
  # `|| true`: pkill returns non-zero if no process matched, which is a race
  # (mirror exited between our pgrep and this pkill) — not a script failure.
  pkill -TERM -f "$match_pattern" 2> /dev/null || true

  # Poll for graceful exit. Cap adjustable via CMA_RESTART_WAIT_S for tests
  # (bats overrides to a small value; live default is 5s). Poll at 0.1s so a
  # sub-second cap still exits in a single tick.
  local wait_s="${CMA_RESTART_WAIT_S:-5}"
  local ticks
  ticks="$(awk -v w="$wait_s" 'BEGIN { printf "%d", w*10 }')"
  local i=0
  while ((i < ticks)); do
    if ! pgrep -f "$match_pattern" > /dev/null 2>&1; then
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done

  if pgrep -f "$match_pattern" > /dev/null 2>&1; then
    log "  $label: WARN mirror did not exit within ${wait_s}s — skipping relaunch (do NOT SIGKILL)"
    return 0
  fi

  # Brief beat before relaunch so LaunchServices sees a clean state.
  sleep 0.1
  if open "$m_app" 2> /dev/null; then
    log "  $label: relaunched $m_app"
  else
    log "  $label: WARN open $m_app failed"
  fi
}

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

    # Resolve mirror paths up front — handle_first_install needs them and
    # a failure here (e.g. missing yaml row) should be logged, not fatal.
    local row _l _e _cdir m_udata _cli m_app _bid
    # shellcheck disable=SC2310  # continue with next mirror on one's failure
    if ! row="$(cma_resolve_instance "$label" 2> /dev/null)"; then
      log "  ERR $label: cma_resolve_instance failed"
      errored=$((errored + 1))
      continue
    fi
    IFS=$'\t' read -r _l _e _cdir m_udata _cli m_app _bid <<< "$row"

    # shellcheck disable=SC2310  # continue with next mirror on one's failure
    if "$CMA_LIB/metadata-symlinks.sh" "$label" >> "$LOG" 2>&1; then
      log "  ok $label"
      # Post-install (sentinel + auto-restart) wrapped so a failure here
      # doesn't abort the outer loop — other mirrors still get their pass.
      handle_first_install "$label" "$m_udata" "$m_app" \
        || log "  WARN $label: handle_first_install returned non-zero"
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
