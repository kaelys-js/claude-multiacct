#!/usr/bin/env bash
# lib/install-instance.sh — install (or repair) a single mirror instance.
# Steps: create configDir + userData; write instance-copy of .claude.json with
# oauth stripped; write settings.json; build CLI launcher; build .app bundle;
# install metadata symlinks (if mirror already logged in).
#
# Usage: install-instance.sh <label>
# Idempotent — safe to re-run.

set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./common.sh
. "$LIB/common.sh"

# Strip account-identifying fields from a copy of ~/.claude/.claude.json so
# the mirror gets its own identity but keeps MCP/onboarding/trust state.
# Removes: oauthAccount, userID, sessionID (all binding to the primary).
mirror_claude_json() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || { cma_warn "primary .claude.json not present at $src — skipping"; return 0; }
  python3 - "$src" "$dst" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    d = json.load(f)
# Strip account-identifying fields; keep MCP/onboarding/trust state.
for k in ("oauthAccount", "userID", "sessionID", "hasCompletedOnboarding"):
    d.pop(k, None)
with open(dst, "w") as f:
    json.dump(d, f, indent=2)
PY
  chmod 600 "$dst"
}

main() {
  local label="$1"
  cma_validate_label "$label"

  # Resolve target paths (defaults + any overrides from instances.yaml).
  local row; row="$(cma_resolve_instance "$label")"
  local _l email cdir udata cli app bid
  IFS=$'\t' read -r _l email cdir udata cli app bid <<<"$row"

  cma_say "install-instance: label=$label email=$email"
  cma_dim "  configDir=$cdir"
  cma_dim "  userData=$udata"
  cma_dim "  cli=$cli"
  cma_dim "  app=$app"
  cma_dim "  bundleId=$bid"

  local p_cdir; p_cdir="$(cma_primary_configdir)"

  # ── 1. Config dir + symlinks + private files ──────────────────────────
  mkdir -p "$cdir"
  chmod 700 "$cdir" 2>/dev/null || true

  # Independent .claude.json (identity stripped, MCP/trust kept). Only write
  # if missing — repeat runs don't clobber a live config.
  if [[ ! -f "$cdir/.claude.json" ]]; then
    mirror_claude_json "$p_cdir/.claude.json" "$cdir/.claude.json"
    cma_ok "wrote $cdir/.claude.json"
  else
    cma_dim "  = $cdir/.claude.json already exists — keeping"
  fi

  # Minimal per-instance settings.json — matches the current on-disk B instance's
  # shape (a small settings.json + settings.local.json). Skip if user has one.
  if [[ ! -f "$cdir/settings.json" ]]; then
    cat >"$cdir/settings.json" <<JSON
{
  "\$schema": "https://json.schemastore.org/claude-code-settings.json"
}
JSON
    chmod 600 "$cdir/settings.json"
    cma_ok "wrote $cdir/settings.json"
  fi
  if [[ ! -f "$cdir/settings.local.json" ]]; then
    cat >"$cdir/settings.local.json" <<JSON
{
  "\$schema": "https://json.schemastore.org/claude-code-settings.json"
}
JSON
    cma_ok "wrote $cdir/settings.local.json"
  fi

  # Shared-via-symlink subpaths — done by metadata-symlinks.sh below.

  # ── 2. userData dir (Claude Desktop auto-creates on launch, but pre-create) ──
  mkdir -p "$udata"
  # Pre-create the two session subdirs Claude Desktop populates on first sign-in.
  # Load-bearing: the launchd metadata-symlink agent watches these paths, and
  # WatchPaths must be armed on paths that already exist for the trigger to be
  # observable across Desktop version + macOS variants. Empty dirs are safe —
  # Desktop populates them as it always does on sign-in.
  mkdir -p "$udata/claude-code-sessions"
  mkdir -p "$udata/local-agent-mode-sessions"

  # ── 3. CLI launcher ───────────────────────────────────────────────────
  "$LIB/build-cli-launcher.sh" "$label" "$cdir" "$udata" "$cli"

  # ── 4. .app bundle ─────────────────────────────────────────────────────
  # Full clone of /Applications/Claude.app with a rewritten Info.plist and a
  # wrapped MacOS/Claude that injects the per-instance env. See docs/dock-icon-fix.md
  # for why a shell-launcher .app doesn't fix Dock-icon grouping.
  "$LIB/build-clone-app.sh" "$label" "$bid" "$cdir" "$udata" "$app"

  # ── 5. Symlinks (config-dir shares + metadata symlinks) ────────────────
  # metadata-symlinks.sh handles both:
  #  - config-dir shared subpaths (projects/sessions/todos/…)
  #  - claude-code-sessions + local-agent-mode-sessions per-account symlinks
  # It's a no-op-and-warn for the metadata layer if the mirror hasn't logged in yet.
  "$LIB/metadata-symlinks.sh" "$label"

  cma_ok "install-instance: label=$label complete"
  cma_dim "  next: launch \`$cli\` (or click \"$(basename "$app")\") + sign in with $email"
  cma_dim "  the launchd metadata-symlink agent will install the session-metadata symlinks on first sign-in"
  cma_dim "  (fallback: re-run \`claude-multiacct repair $label\` if the agent hasn't fired)"
}

main "$@"
