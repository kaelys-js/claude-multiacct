#!/usr/bin/env bash
# lib/install-launchd.sh — render every launchd plist template with real paths
# and install into ~/Library/LaunchAgents/, then load. Idempotent: bootout+load
# sequence is safe to re-run.
#
# Three agents are installed:
#   com.user.claude-sessions-sync    — WatchPaths on primary <userData>/Local State
#                                      → rsyncs IndexedDB / Local Storage / Session
#                                      Storage primary → mirrors on primary close.
#   com.user.claude-clone-refresh    — WatchPaths on primary Claude.app/Contents/Info.plist
#                                      → rebuilds every mirror clone after a
#                                      Claude Desktop Squirrel autoupdate.
#   com.user.claude-metadata-symlink — WatchPaths on every mirror's
#                                      <userData>/claude-code-sessions and
#                                      <userData>/local-agent-mode-sessions
#                                      → installs missing per-account-folder
#                                      symlinks the moment Desktop creates them
#                                      on sign-in. Skipped when zero mirrors.
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
  local tmp
  tmp="$(mktemp "$installed.XXXXXX")"
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
  if [[ -f "$installed" ]] && diff -q "$tmp" "$installed" > /dev/null 2>&1; then
    rm -f "$tmp"
    cma_dim "  = launchd plist $label already up-to-date"
    local loaded=0
    launchctl print "gui/$(id -u)/$label" > /dev/null 2>&1 && loaded=1
    if [[ $loaded -eq 0 ]]; then
      cma_warn "  plist matches but agent not loaded — loading"
      launchctl load -w "$installed"
      cma_ok "loaded $label"
    fi
    return 0
  fi

  # Snapshot existing plist (if any) before overwriting.
  if [[ -f "$installed" ]]; then
    local snap
    snap="$(cma_backup_snapshot "$installed" "launchd-plist-$label")"
    cma_dim "  snapshot: $snap"
    # Unload the old version. `launchctl unload` is the pair to `load -w`;
    # both use the older but consistently-working API on modern macOS.
    # (Modern `bootstrap` fails with "5: Input/output error" in some domain
    # states we've seen — 2026-07-13; `load -w` handles the same transitions
    # correctly.)
    launchctl unload -w "$installed" 2> /dev/null || true
  fi

  mv -f "$tmp" "$installed"
  chmod 644 "$installed"
  cma_ok "installed $installed"

  # Load (registers the agent + arms WatchPaths).
  launchctl load -w "$installed"
  cma_ok "loaded $label"
}

# Symmetric counterpart to install_agent — unload + delete a plist if it
# exists. No-op when nothing installed. Used when a previously-installed agent
# is no longer relevant (e.g. metadata-symlink after every mirror was removed).
uninstall_agent() {
  local label="$1"
  local installed="$HOME/Library/LaunchAgents/$label.plist"
  [[ -f "$installed" ]] || return 0
  local snap
  snap="$(cma_backup_snapshot "$installed" "launchd-plist-$label")"
  cma_dim "  snapshot: $snap"
  launchctl unload -w "$installed" 2> /dev/null || true
  rm -f "$installed"
  cma_ok "removed $label"
}

# Write one <string>PATH</string> line per mirror WatchPath into $entries_file.
# The metadata-symlink agent watches THREE paths per mirror:
#   - <userData>/claude-code-sessions       — mtime-changes when Desktop creates
#     the per-account UUID subdir on Code first-use inside Desktop.
#   - <userData>/local-agent-mode-sessions  — same but for agent-mode.
#   - <userData>/config.json                — mtime-changes on OAuth sign-in
#     (Desktop caches tokens + writes lastKnownAccountUuid), which happens
#     BEFORE Code first-use. Watching this file is what lets the watcher
#     install the metadata symlinks the moment sign-in completes, no manual
#     "click into Code once" step required.
# Returns the count of mirrors emitted.
build_metadata_watchpaths() {
  local entries_file="$1"
  : > "$entries_file"
  local count=0 label
  while IFS= read -r label; do
    [[ -z "$label" ]] && continue
    local row
    row="$(cma_resolve_instance "$label")"
    local _l _e _cdir m_udata _cli _app _bid
    IFS=$'\t' read -r _l _e _cdir m_udata _cli _app _bid <<< "$row"
    # Group the three per-mirror entries so shellcheck-SC2129 stays clean and
    # the file is opened once per mirror instead of thrice.
    {
      printf '        <string>%s/claude-code-sessions</string>\n' "$m_udata"
      printf '        <string>%s/local-agent-mode-sessions</string>\n' "$m_udata"
      printf '        <string>%s/config.json</string>\n' "$m_udata"
    } >> "$entries_file"
    count=$((count + 1))
  done < <(cma_list_labels)
  printf '%s' "$count"
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

  local primary_ls
  primary_ls="$(cma_primary_userdata)/Local State"

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

  # Agent 3: metadata-symlink — per-mirror session-metadata symlink installer,
  # armed on the per-mirror dirs Desktop creates on sign-in. Only installed
  # when there is at least one mirror — an empty WatchPaths array is invalid
  # under launchd, and a placeholder path would arm the agent uselessly.
  # If mirrors were removed since the last install, bootout + delete the
  # existing plist so the agent's WatchPaths don't dangle at stale paths.
  local entries_file
  entries_file="$(mktemp -t claude-metadata-watchpaths)"
  # Ensure cleanup even on the cma_die → set -e paths inside install_agent.
  # shellcheck disable=SC2064  # deliberate: expand entries_file now, not at trap time
  trap "rm -f '$entries_file'" EXIT
  local mirror_count
  mirror_count="$(build_metadata_watchpaths "$entries_file")"
  if [[ "$mirror_count" -gt 0 ]]; then
    # sed script: match the placeholder line, read the entries file into the
    # output stream, then delete the placeholder line itself. Real newlines
    # inside the -e arg are what let the `r file; d` block span multiple
    # sed commands under BSD sed (verified on macOS 15).
    install_agent \
      "com.user.claude-metadata-symlink" \
      "$CMA_REPO_ROOT/launchd/com.user.claude-metadata-symlink.plist.tmpl" \
      "$CMA_LOG_DIR/metadata-watcher.log" \
      "s|__WATCH_BIN__|$CMA_REPO_ROOT/bin/claude-metadata-watcher.sh|g" \
      "/__WATCHPATHS_ENTRIES__/{
r $entries_file
d
}"
  else
    uninstall_agent "com.user.claude-metadata-symlink"
    cma_dim "  = no mirrors configured — metadata-symlink agent skipped"
  fi

  cma_dim "  test sessions-sync: touch \"$primary_ls\" — sync fires after primary close"
  cma_dim "  test clone-refresh: touch \"$CMA_SOURCE_CLAUDE_APP/Contents/Info.plist\" — refresh fires"
}

main "$@"
