#!/usr/bin/env bash
# lib/metadata-symlinks.sh — install per-account-folder symlinks so a mirror
# instance's desktop UI reads/writes the same session metadata as the primary.
#
# Two layers get symlinked:
#   1. claude-code-sessions/<mirrorAcct>/<mirrorOrg> → /<primaryAcct>/<primaryOrg>
#   2. local-agent-mode-sessions/<mirrorAcct>       → /<primaryAcct>
#
# Also symlinks ~/.<mirrorConfigDir>/{projects,sessions,todos,shell-snapshots,
# plugins,skills} → the primary's equivalents. These carry the JSONL body of
# every session — sharing them at file layer is what makes the sidebar identical.
#
# Usage: metadata-symlinks.sh <label>
# Idempotent: existing correct symlinks are left alone; incorrect targets are
# snapshotted first then replaced.

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Ensure $link points at $target. If it already does, no-op. If it exists
# but points elsewhere (or is a real file/dir), snapshot it then replace.
# Aborts if the parent dir doesn't exist (caller's responsibility).
symlink_atomic() {
  local link="$1" target="$2"
  local parent; parent="$(dirname "$link")"
  [[ -d "$parent" ]] || cma_die "symlink parent missing: $parent"

  if [[ -L "$link" ]]; then
    local cur; cur="$(readlink "$link")"
    if [[ "$cur" == "$target" ]]; then
      cma_dim "  = already correct: $link → $target"
      return 0
    fi
    cma_dim "  ↻ replacing symlink at $link (was → $cur)"
    rm "$link"
  elif [[ -e "$link" ]]; then
    local snap; snap="$(cma_backup_snapshot "$link" "symlink-replace")"
    cma_warn "  snapshotted existing at $link → $snap"
    rm -rf "$link"
  fi
  ln -s "$target" "$link"
  cma_ok "$link → $target"
}

main() {
  local label="$1"
  cma_validate_label "$label"

  # Resolve mirror + primary paths.
  local row; row="$(cma_resolve_instance "$label")"
  local _m_label _m_email m_cdir m_udata _l _a _b
  IFS=$'\t' read -r _m_label _m_email m_cdir m_udata _l _a _b <<<"$row"
  local p_udata; p_udata="$(cma_primary_userdata)"
  local p_cdir; p_cdir="$(cma_primary_configdir)"

  cma_say "metadata-symlinks: label=$label"

  # ── Config-dir symlinks (JSONL bodies + shared skills/plugins/todos) ──────
  # Ensure the mirror's config dir exists; if it did NOT before this run,
  # Claude Desktop hasn't yet been launched under this label. The launch of
  # Claude with CLAUDE_CONFIG_DIR set creates the dir; we can safely create
  # it ourselves ahead of time.
  mkdir -p "$m_cdir"

  # These subpaths are ACCOUNT-AGNOSTIC (Claude Code writes session-id-keyed
  # files, no per-account partitioning inside). Symlinking is safe.
  local shared
  for shared in projects sessions todos shell-snapshots plugins skills; do
    symlink_atomic "$m_cdir/$shared" "$p_cdir/$shared"
  done

  # ── Desktop UI session metadata symlink (claude-code-sessions) ──────────
  # Location: <userData>/claude-code-sessions/<acctUuid>/<orgUuid>/local_<sessId>.json
  # The JSON body has NO account field — symlinking the mirror's account+org
  # folder at the primary's account+org folder makes both apps see the same
  # local_<sessId>.json files as "their own".
  #
  # The mirror's account+org UUIDs are only assigned AFTER the mirror has
  # logged in at least once. So this symlink is a POST-LOGIN install step;
  # the caller (install-instance.sh) either runs this after a first launch
  # or the doctor/repair subcommand re-runs it later.
  local m_ccs="$m_udata/claude-code-sessions"
  local m_lams="$m_udata/local-agent-mode-sessions"

  if [[ ! -d "$m_ccs" ]]; then
    cma_warn "  claude-code-sessions/ missing under mirror userData — not logged in yet, will retry on next Desktop event"
    return 0
  fi

  # Find the mirror's account UUID under its userData (there should be exactly one).
  # `find -L`: after the first successful run, the org UUID under this acct is a
  # SYMLINK (pointing at the primary's org dir), and BSD `find -type d` without
  # `-L` won't match a symlink. `-L` makes find follow symlinks so an already-
  # symlinked layout still discovers the acct/org pair — the watcher then
  # observes "already correct" instead of "not logged in yet". Load-bearing for
  # idempotency under repeated launchd fires.
  local m_acct; m_acct="$(find -L "$m_ccs" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
  [[ -n "$m_acct" ]] || { cma_warn "  not logged in yet (no account UUID under $m_ccs) — will retry on next Desktop event"; return 0; }
  local m_acct_uuid; m_acct_uuid="$(basename "$m_acct")"

  # Same discovery for primary.
  local p_uuids; p_uuids="$(cma_primary_uuids "$p_udata")"
  local p_acct_uuid p_org_uuid
  IFS=$'\t' read -r p_acct_uuid p_org_uuid <<<"$p_uuids"

  # Under the mirror's acct dir, find its org UUID (there should also be exactly one).
  # `-L`: see the note on the acct-level find above — after the first successful
  # run this entry is a symlink, and BSD find without -L would skip it.
  local m_org; m_org="$(find -L "$m_acct" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
  [[ -n "$m_org" ]] || { cma_warn "  not logged in yet (no org UUID under $m_acct) — will retry on next Desktop event"; return 0; }
  local m_org_uuid; m_org_uuid="$(basename "$m_org")"

  # Symlink: mirror's <acct>/<org> → primary's <acct>/<org>.
  symlink_atomic "$m_ccs/$m_acct_uuid/$m_org_uuid" \
                 "$p_udata/claude-code-sessions/$p_acct_uuid/$p_org_uuid"

  # ── Agent-mode subagent metadata symlink ──────────────────────────────
  # Same shape but only account-scoped (no org-level partition below).
  # `-L`: same reason as the claude-code-sessions finds above — after the
  # first successful run the acct dir here IS the symlink; -L lets us
  # rediscover it and no-op via symlink_atomic instead of silently missing it.
  if [[ -d "$m_lams" ]]; then
    local m_lams_acct; m_lams_acct="$(find -L "$m_lams" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
    if [[ -n "$m_lams_acct" ]]; then
      local m_lams_acct_uuid; m_lams_acct_uuid="$(basename "$m_lams_acct")"
      symlink_atomic "$m_lams/$m_lams_acct_uuid" \
                     "$p_udata/local-agent-mode-sessions/$p_acct_uuid"
    fi
  fi

  cma_ok "metadata-symlinks: label=$label all links resolved"
}

main "$@"
