#!/usr/bin/env bash
# lib/install-launchd.sh — render every launchd plist template with real paths
# and install into ~/Library/LaunchAgents/, then load. Idempotent: bootout+load
# sequence is safe to re-run.
#
# Two agents are installed:
#   com.user.claude-sessions-sync   — WatchPaths on primary <userData>/Local State
#                                     → rsyncs IndexedDB / Local Storage / Session
#                                     Storage primary → mirrors on primary close.
#   com.user.claude-clone-refresh   — WatchPaths on primary Claude.app/Contents/Info.plist
#                                     → rebuilds every mirror clone after a
#                                     Claude Desktop Squirrel autoupdate.
#
# Usage: install-launchd.sh

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

# Render a template into ~/Library/LaunchAgents/<label>.plist with the caller's
# sed-expression list applied, then reload the agent. Idempotent: skips the
# unload/load cycle if the rendered content already matches disk.
#
# Args: <label> <template-path> <log-path> <sed-expr>...
install_agent() {
  local label="$1" template="$2" log_path="$3"
  shift 3
  local installed="$HOME/Library/LaunchAgents/$label.plist"

  [[ -f "$template" ]] || cma_die "template missing at $template"
  mkdir -p "$CMA_LOG_DIR"
  mkdir -p "$(dirname "$installed")"

  # Render template into place atomically.
  local tmp; tmp="$(mktemp "$installed.XXXXXX")"
  local sed_args=()
  local expr
  for expr in "$@"; do
    sed_args+=("-e" "$expr")
  done
  # Always substitute __LOG_PATH__ — it's a universal placeholder in every template.
  sed_args+=("-e" "s|__LOG_PATH__|$log_path|g")
  sed "${sed_args[@]}" "$template" > "$tmp"

  # If the installed plist already matches, skip the reload cycle. Still verify
  # the agent is actually loaded; if not, load it. `launchctl print` fails when
  # the label isn't registered — we use that to detect it.
  if [[ -f "$installed" ]] && diff -q "$tmp" "$installed" >/dev/null 2>&1; then
    rm -f "$tmp"
    cma_dim "  = launchd plist $label already up-to-date"
    local loaded=0
    launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && loaded=1
    if [[ $loaded -eq 0 ]]; then
      cma_warn "  plist matches but agent not loaded — loading"
      launchctl load -w "$installed"
      cma_ok "loaded $label"
    fi
    return 0
  fi

  # Snapshot existing plist (if any) before overwriting.
  if [[ -f "$installed" ]]; then
    local snap; snap="$(cma_backup_snapshot "$installed" "launchd-plist-$label")"
    cma_dim "  snapshot: $snap"
    # Unload the old version. `launchctl unload` is the pair to `load -w`;
    # both use the older but consistently-working API on modern macOS.
    # (Modern `bootstrap` fails with "5: Input/output error" in some domain
    # states we've seen — 2026-07-13; `load -w` handles the same transitions
    # correctly.)
    launchctl unload -w "$installed" 2>/dev/null || true
  fi

  mv -f "$tmp" "$installed"
  chmod 644 "$installed"
  cma_ok "installed $installed"

  # Load (registers the agent + arms WatchPaths).
  launchctl load -w "$installed"
  cma_ok "loaded $label"
}

main() {
  # Escape hatch for hermetic testing: bats runs under a scratch $HOME where
  # launchctl bootstrap fails ("5: Input/output error") because launchd only
  # accepts plists under the user's real domain. CMA_SKIP_LAUNCHD=1 makes
  # install-launchd.sh a no-op — install/repair still succeed under the test.
  if [[ "${CMA_SKIP_LAUNCHD:-0}" == "1" ]]; then
    cma_dim "  = CMA_SKIP_LAUNCHD=1 — skipping launchd install (test mode)"
    return 0
  fi

  local primary_ls; primary_ls="$(cma_primary_userdata)/Local State"

  # Agent 1: sessions-sync — IndexedDB / LS / SS rsync on primary close.
  install_agent \
    "com.user.claude-sessions-sync" \
    "$CMA_REPO_ROOT/launchd/com.user.claude-sessions-sync.plist.tmpl" \
    "$CMA_LOG_DIR/sessions-sync.log" \
    "s|__SYNC_BIN__|$CMA_REPO_ROOT/bin/claude-sessions-sync.sh|g" \
    "s|__PRIMARY_LOCALSTATE__|$primary_ls|g"

  # Agent 2: clone-refresh — mirror clone rebuild on Claude Desktop update.
  install_agent \
    "com.user.claude-clone-refresh" \
    "$CMA_REPO_ROOT/launchd/com.user.claude-clone-refresh.plist.tmpl" \
    "$CMA_LOG_DIR/clone-refresh.log" \
    "s|__REFRESH_BIN__|$CMA_REPO_ROOT/bin/claude-clone-refresh.sh|g" \
    "s|__WATCH_PATH__|$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist|g"

  cma_dim "  test sessions-sync: touch \"$primary_ls\" — sync fires after primary close"
  cma_dim "  test clone-refresh: touch \"$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist\" — refresh fires"
}

main "$@"
