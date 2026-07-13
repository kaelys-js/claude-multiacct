#!/usr/bin/env bash
# lib/common.sh — shared functions sourced by every bin/ and lib/ script.
# Defines: logging, path helpers, config parsing, primary-instance detection,
# label validation, and the on-disk layout constants.
#
# Sourced with `set -euo pipefail` already applied by the caller. Do NOT set it
# here — the caller controls its own error handling.

# ── Paths ──────────────────────────────────────────────────────────────────

# Repo root: this file lives at $REPO_ROOT/lib/common.sh
CMA_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CMA_REPO_ROOT

# User-level config directory follows the XDG spec.
CMA_CONFIG_DIR="${CMA_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/claude-multiacct}"
CMA_CONFIG_FILE="$CMA_CONFIG_DIR/instances.yaml"
export CMA_CONFIG_DIR CMA_CONFIG_FILE

# Log dir.
CMA_LOG_DIR="${CMA_LOG_DIR:-$HOME/Library/Logs/claude-multiacct}"
export CMA_LOG_DIR

# Backup dir (snapshots before destructive writes).
CMA_BACKUP_DIR="${CMA_BACKUP_DIR:-$HOME/.claude-multiacct-backups}"
export CMA_BACKUP_DIR

# ── Logging ────────────────────────────────────────────────────────────────

# Colour when stdout is a TTY.
if [[ -t 1 ]]; then
  CMA_C_INFO=$'\033[1;34m'  # blue
  CMA_C_WARN=$'\033[1;33m'  # yellow
  CMA_C_ERR=$'\033[1;31m'   # red
  CMA_C_OK=$'\033[1;32m'    # green
  CMA_C_DIM=$'\033[2m'
  CMA_C_END=$'\033[0m'
else
  CMA_C_INFO=""; CMA_C_WARN=""; CMA_C_ERR=""; CMA_C_OK=""; CMA_C_DIM=""; CMA_C_END=""
fi

cma_say()  { printf "%s==>%s %s\n" "$CMA_C_INFO" "$CMA_C_END" "$*" >&2; }
cma_ok()   { printf "%s ✓ %s%s\n" "$CMA_C_OK" "$*" "$CMA_C_END" >&2; }
cma_warn() { printf "%s[!]%s %s\n" "$CMA_C_WARN" "$CMA_C_END" "$*" >&2; }
cma_err()  { printf "%s[✗]%s %s\n" "$CMA_C_ERR" "$CMA_C_END" "$*" >&2; }
cma_die()  { cma_err "$*"; exit 1; }
cma_dim()  { printf "%s%s%s\n" "$CMA_C_DIM" "$*" "$CMA_C_END" >&2; }

# ── Tooling ────────────────────────────────────────────────────────────────

# Prepend the repo's mise install dirs to PATH so tooling (yq, shellcheck, bats,
# etc.) resolves without requiring the caller to have `mise activate` in their
# shell OR a `mise use -g` global default. A no-op on a fresh clone before
# `mise install`. Each tool has a different install layout — yq puts the
# binary directly in the version dir; shellcheck + gitleaks use `bin/`; bats
# uses `libexec/bin/` — so we glob every plausible location per tool.
#
# Load-bearing: the user's `~/.local/share/mise/shims/yq` shim tries to resolve
# via mise's project-detection, which requires the CWD to be inside a mise-
# activated project. When the CLI is called from an arbitrary CWD (e.g. from a
# launchd agent context), the shim fails with "No version set for shim". Our
# direct prepend routes around the shim's project-detection.
if [[ -d "$HOME/.local/share/mise/installs" ]]; then
  # Enable nullglob so unmatched patterns disappear cleanly. Wrap the whole
  # block so we don't leak shopt state into the caller. `shopt -q` returns
  # non-zero when the option is UNSET (the default state) — under `set -e`
  # the || : neutralises that non-zero without triggering an exit.
  _cma_had_nullglob=1
  shopt -q nullglob && _cma_had_nullglob=0 || true
  shopt -s nullglob
  for _cma_tool_dir in "$HOME/.local/share/mise/installs/yq"/* \
                       "$HOME/.local/share/mise/installs/shellcheck"/*/bin \
                       "$HOME/.local/share/mise/installs/bats"/*/libexec/bin \
                       "$HOME/.local/share/mise/installs/gitleaks"/*/bin \
                       "$HOME/.local/share/mise/installs/yamllint"/*/bin; do
    [[ -d "$_cma_tool_dir" ]] && PATH="$_cma_tool_dir:$PATH"
  done
  [[ $_cma_had_nullglob -eq 0 ]] || shopt -u nullglob
  unset _cma_tool_dir _cma_had_nullglob
  export PATH
fi

# Require a binary on PATH; die loud if missing.
cma_require() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || cma_die "missing dependency: $bin (install via \`mise install\` from the repo root)"
}

# ── Label validation ──────────────────────────────────────────────────────

# Labels are user-chosen path components — enforce a safe charset so we
# don't build paths that break on the filesystem or need shell escaping.
CMA_LABEL_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'

cma_validate_label() {
  local label="$1"
  [[ "$label" =~ $CMA_LABEL_RE ]] || \
    cma_die "invalid label '$label' — must match ${CMA_LABEL_RE#^} (lowercase letters, digits, hyphens; no leading/trailing hyphen)"
  [[ "$label" != "primary" ]] || cma_die "label 'primary' is reserved for the primary instance"
}

# ── Derived paths ─────────────────────────────────────────────────────────

# Primary paths — hard-coded to Claude Desktop's defaults.
CMA_PRIMARY_USERDATA="$HOME/Library/Application Support/Claude"
CMA_PRIMARY_CONFIG_DIR="$HOME/.claude"

# Given a label, echo the default userData / configDir / launcher / .app paths.
# Callers may override any of these via instances.yaml.
cma_default_userdata() {
  local label="$1"
  # Titlecase the label for the userData folder name (matches how Claude-B is named).
  local title; title="$(tr '[:lower:]' '[:upper:]' <<<"${label:0:1}")${label:1}"
  printf '%s\n' "$HOME/Library/Application Support/Claude-$title"
}
cma_default_configdir() {
  local label="$1"
  printf '%s\n' "$HOME/.claude-$label"
}
cma_default_cli_launcher() {
  local label="$1"
  printf '%s\n' "$HOME/.local/bin/claude-account-$label"
}
cma_default_app_bundle() {
  local label="$1"
  local title; title="$(tr '[:lower:]' '[:upper:]' <<<"${label:0:1}")${label:1}"
  printf '%s\n' "$HOME/Applications/Claude Account $title.app"
}
cma_default_bundle_id() {
  local label="$1"
  printf '%s\n' "com.claude-multiacct.claude-account-$label-launcher"
}

# ── Config file ───────────────────────────────────────────────────────────

# Read instances.yaml. Refuse if not initialised.
cma_require_config() {
  [[ -f "$CMA_CONFIG_FILE" ]] || \
    cma_die "$CMA_CONFIG_FILE not found — run \`claude-multiacct init\` first"
}

# List all labels from instances.yaml, one per line.
cma_list_labels() {
  cma_require_config
  yq -r '.instances[].label' "$CMA_CONFIG_FILE"
}

# Given a label, print the resolved fields (label email configDir userData launcher app bundleId).
# Fields default from cma_default_* if instances.yaml doesn't override.
cma_resolve_instance() {
  local label="$1"
  cma_require_config
  cma_validate_label "$label"

  # Extract every field via yq; empty string if missing.
  local email cdir udata launcher app bid
  email="$(yq -r ".instances[] | select(.label == \"$label\") | .email // \"\"" "$CMA_CONFIG_FILE")"
  cdir="$(yq -r ".instances[] | select(.label == \"$label\") | .configDir // \"\"" "$CMA_CONFIG_FILE")"
  udata="$(yq -r ".instances[] | select(.label == \"$label\") | .userData // \"\"" "$CMA_CONFIG_FILE")"
  launcher="$(yq -r ".instances[] | select(.label == \"$label\") | .cliLauncher // \"\"" "$CMA_CONFIG_FILE")"
  app="$(yq -r ".instances[] | select(.label == \"$label\") | .appBundle // \"\"" "$CMA_CONFIG_FILE")"
  bid="$(yq -r ".instances[] | select(.label == \"$label\") | .bundleId // \"\"" "$CMA_CONFIG_FILE")"

  [[ -n "$email" ]] || cma_die "instance '$label' not found in $CMA_CONFIG_FILE"

  # Expand ~ and defaults.
  cdir="${cdir/#\~/$HOME}"; [[ -n "$cdir" ]] || cdir="$(cma_default_configdir "$label")"
  udata="${udata/#\~/$HOME}"; [[ -n "$udata" ]] || udata="$(cma_default_userdata "$label")"
  launcher="${launcher/#\~/$HOME}"; [[ -n "$launcher" ]] || launcher="$(cma_default_cli_launcher "$label")"
  app="${app/#\~/$HOME}"; [[ -n "$app" ]] || app="$(cma_default_app_bundle "$label")"
  [[ -n "$bid" ]] || bid="$(cma_default_bundle_id "$label")"

  # Print as a TSV row so callers can `read -r label email cdir udata launcher app bid <<<"$(cma_resolve_instance x)"`.
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$email" "$cdir" "$udata" "$launcher" "$app" "$bid"
}

# Primary instance's userData / configDir — read from instances.yaml if defined,
# else fall back to the hard-coded Claude Desktop defaults.
cma_primary_userdata() {
  local v=""
  if [[ -f "$CMA_CONFIG_FILE" ]]; then
    v="$(yq -r '.primary.userData // ""' "$CMA_CONFIG_FILE")"
  fi
  v="${v/#\~/$HOME}"
  printf '%s\n' "${v:-$CMA_PRIMARY_USERDATA}"
}
cma_primary_configdir() {
  local v=""
  if [[ -f "$CMA_CONFIG_FILE" ]]; then
    v="$(yq -r '.primary.configDir // ""' "$CMA_CONFIG_FILE")"
  fi
  v="${v/#\~/$HOME}"
  printf '%s\n' "${v:-$CMA_PRIMARY_CONFIG_DIR}"
}

# Detect the primary's on-disk (accountUuid, orgUuid) — needed for metadata
# symlink paths. Reads them from the userData's claude-code-sessions dir.
cma_primary_uuids() {
  local userdata="${1:-$(cma_primary_userdata)}"
  local dir="$userdata/claude-code-sessions"
  [[ -d "$dir" ]] || cma_die "primary claude-code-sessions dir missing at $dir — has Claude Desktop been run at least once?"
  local acct org
  acct="$(find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
  [[ -n "$acct" ]] || cma_die "no account UUID found under $dir"
  org="$(find "$acct" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | head -1)"
  [[ -n "$org" ]] || cma_die "no org UUID found under $acct"
  printf '%s\t%s\n' "$(basename "$acct")" "$(basename "$org")"
}

# Detect the primary's email. Two possible sources depending on Claude version:
#   1. <userData>/config.json — the desktop app's OAuth token cache
#   2. ~/.claude/.claude.json — the Claude Code CLI config (has oauthAccount)
# Try both; return the first hit.
cma_primary_email() {
  local userdata="${1:-$(cma_primary_userdata)}"
  local configdir="${2:-$(cma_primary_configdir)}"
  local candidates=("$userdata/config.json" "$configdir/.claude.json")
  local cfg email=""
  for cfg in "${candidates[@]}"; do
    [[ -f "$cfg" ]] || continue
    email="$(python3 -c '
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  print(d.get("oauthAccount", {}).get("emailAddress") or d.get("userEmail") or "")
except Exception:
  print("")
' "$cfg" 2>/dev/null)"
    [[ -n "$email" ]] && break
  done
  printf '%s\n' "$email"
}

# ── Timestamped backup helpers ────────────────────────────────────────────

cma_backup_snapshot() {
  local src="$1" label="${2:-}"
  [[ -e "$src" ]] || return 0
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local dst="$CMA_BACKUP_DIR/$ts${label:+-$label}"
  mkdir -p "$dst"
  cp -R "$src" "$dst/"
  printf '%s\n' "$dst"
}
