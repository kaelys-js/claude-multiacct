#!/usr/bin/env bash
# lib/install-launchd.sh — render the launchd/com.user.claude-sessions-sync.plist
# template with real paths + install to ~/Library/LaunchAgents/ + bootstrap.
# Idempotent: bootout+bootstrap sequence is safe to re-run.
#
# Usage: install-launchd.sh

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

LABEL="com.user.claude-sessions-sync"
TEMPLATE="$CMA_REPO_ROOT/launchd/$LABEL.plist.tmpl"
INSTALLED="$HOME/Library/LaunchAgents/$LABEL.plist"

main() {
  # Escape hatch for hermetic testing: bats runs under a scratch $HOME where
  # launchctl bootstrap fails ("5: Input/output error") because launchd only
  # accepts plists under the user's real domain. CMA_SKIP_LAUNCHD=1 makes
  # install-launchd.sh a no-op — install/repair still succeed under the test.
  if [[ "${CMA_SKIP_LAUNCHD:-0}" == "1" ]]; then
    cma_dim "  = CMA_SKIP_LAUNCHD=1 — skipping launchd install (test mode)"
    return 0
  fi

  [[ -f "$TEMPLATE" ]] || cma_die "template missing at $TEMPLATE"

  local sync_bin="$CMA_REPO_ROOT/bin/claude-sessions-sync.sh"
  local primary_ls; primary_ls="$(cma_primary_userdata)/Local State"
  local log_path="$CMA_LOG_DIR/sessions-sync.log"

  mkdir -p "$CMA_LOG_DIR"
  mkdir -p "$(dirname "$INSTALLED")"

  # Render template into place atomically.
  local tmp; tmp="$(mktemp "$INSTALLED.XXXXXX")"
  sed \
    -e "s|__SYNC_BIN__|$sync_bin|g" \
    -e "s|__PRIMARY_LOCALSTATE__|$primary_ls|g" \
    -e "s|__LOG_PATH__|$log_path|g" \
    "$TEMPLATE" > "$tmp"

  # If the installed plist already matches, skip the reload cycle.
  if [[ -f "$INSTALLED" ]] && diff -q "$tmp" "$INSTALLED" >/dev/null 2>&1; then
    rm -f "$tmp"
    cma_dim "  = launchd plist already up-to-date"
    # Still ensure it's loaded. `launchctl print` fails when the label isn't
    # registered — we use that to detect and re-load.
    local loaded=0
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && loaded=1
    if [[ $loaded -eq 0 ]]; then
      cma_warn "  plist matches but agent not loaded — loading"
      launchctl load -w "$INSTALLED"
      cma_ok "loaded $LABEL"
    fi
    return 0
  fi

  # Snapshot existing plist (if any) before overwriting.
  if [[ -f "$INSTALLED" ]]; then
    local snap; snap="$(cma_backup_snapshot "$INSTALLED" "launchd-plist")"
    cma_dim "  snapshot: $snap"
    # Unload the old version. `launchctl unload` is the pair to `load -w`;
    # both use the older but consistently-working API on modern macOS.
    # (Modern `bootstrap` fails with "5: Input/output error" in some domain
    # states we've seen — 2026-07-13; `load -w` handles the same transitions
    # correctly.)
    launchctl unload -w "$INSTALLED" 2>/dev/null || true
  fi

  mv -f "$tmp" "$INSTALLED"
  chmod 644 "$INSTALLED"
  cma_ok "installed $INSTALLED"

  # Load (registers the agent + arms WatchPaths).
  launchctl load -w "$INSTALLED"
  cma_ok "loaded $LABEL"

  cma_dim "  test: touch \"$primary_ls\" — the sync fires after primary close"
}

main "$@"
