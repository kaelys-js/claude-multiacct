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
# UUID discovery is two-tier:
#   A. On-disk find (existing behaviour). After Desktop has opened the Code area
#      at least once, the <acct>/<org> dirs are real dirs (or, after our first
#      symlink install, symlinks) that `find -L` picks up.
#   B. config.json derivation (new). Claude Desktop writes
#      <userData>/config.json on OAuth sign-in — well BEFORE Code first-use —
#      with `lastKnownAccountUuid` and `dxt:allowlistLastUpdated:<orgUuid>`
#      timestamped keys. When (A) can't resolve, we parse those to build the
#      symlink chain right after sign-in, no manual "click into Code once"
#      step required. This is what removes the last piece of manual UX from
#      the mirror-first-signin flow.
#
# Usage: metadata-symlinks.sh <label>
# Idempotent: existing correct symlinks are left alone; incorrect targets are
# snapshotted first then replaced.

set -euo pipefail

# shellcheck source=./common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# Derive (mirrorAcct, mirrorOrg, primaryAcct, primaryOrg) UUIDs by parsing the
# mirror's and primary's <userData>/config.json. Claude Desktop writes these
# files on OAuth sign-in — the account UUID lives at `lastKnownAccountUuid`,
# and the org UUID is the SUFFIX of one of the `dxt:allowlistLastUpdated:<org>`
# keys. Multiple orgs may be present (a Claude account that belongs to more
# than one org has one such key per org); the currently-active org is the one
# with the newest ISO-8601 timestamp value.
#
# Prints tab-separated m_acct\tm_org\tp_acct\tp_org on success and exits 0.
# Returns non-zero on any parse failure so the caller can fall to a "not
# logged in yet" retry-later warn: missing file, malformed JSON, missing
# lastKnownAccountUuid, no dxt:allowlistLastUpdated:* keys, or any of the four
# UUIDs failing the ^[0-9a-f]{8}-…{12}$ shape check (guards against a config
# key we don't recognise sneaking in as an "org UUID").
#
# Python (not jq) because common.sh already relies on python3 for config
# parsing (see cma_primary_email) and jq is not pinned in mise.toml — the
# system /usr/bin/jq is present on modern macOS but adopting it here would
# introduce a second parser dependency for no benefit.
_derive_uuids_from_config() {
  local m_cfg="$1" p_cfg="$2"
  [[ -f "$m_cfg" && -f "$p_cfg" ]] || return 1
  python3 -c '
import json, re, sys
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

def newest_org(d):
    """Pick the org UUID whose dxt:allowlistLastUpdated timestamp is newest."""
    prefix = "dxt:allowlistLastUpdated:"
    best_ts = ""
    best_uuid = ""
    for k, v in d.items():
        if not k.startswith(prefix):
            continue
        if not isinstance(v, str):
            continue
        # ISO-8601 timestamps sort lexicographically iff they share a common
        # zulu/offset form — Claude Desktop writes trailing "Z" uniformly.
        if v > best_ts:
            best_ts = v
            best_uuid = k[len(prefix):]
    return best_uuid

try:
    m = json.load(open(sys.argv[1]))
    p = json.load(open(sys.argv[2]))
except Exception:
    sys.exit(1)

m_acct = (m.get("lastKnownAccountUuid") or "").lower()
p_acct = (p.get("lastKnownAccountUuid") or "").lower()
m_org  = newest_org(m).lower()
p_org  = newest_org(p).lower()

for u in (m_acct, m_org, p_acct, p_org):
    if not UUID_RE.match(u):
        sys.exit(1)

sys.stdout.write(f"{m_acct}\t{m_org}\t{p_acct}\t{p_org}\n")
' "$m_cfg" "$p_cfg"
}

# Ensure $link points at $target. If it already does, no-op. If it exists
# but points elsewhere (or is a real file/dir), snapshot it then replace.
# Aborts if the parent dir doesn't exist (caller's responsibility).
symlink_atomic() {
  local link="$1" target="$2"
  local parent
  parent="$(dirname "$link")"
  [[ -d "$parent" ]] || cma_die "symlink parent missing: $parent"

  if [[ -L "$link" ]]; then
    local cur
    cur="$(readlink "$link")"
    if [[ "$cur" == "$target" ]]; then
      cma_dim "  = already correct: $link → $target"
      return 0
    fi
    cma_dim "  ↻ replacing symlink at $link (was → $cur)"
    rm "$link"
  elif [[ -e "$link" ]]; then
    local snap
    snap="$(cma_backup_snapshot "$link" "symlink-replace")"
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
  local row
  row="$(cma_resolve_instance "$label")"
  local _m_label _m_email m_cdir m_udata _l _a _b
  IFS=$'\t' read -r _m_label _m_email m_cdir m_udata _l _a _b <<< "$row"
  local p_udata
  p_udata="$(cma_primary_userdata)"
  local p_cdir
  p_cdir="$(cma_primary_configdir)"

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
  local m_ccs="$m_udata/claude-code-sessions"
  local m_lams="$m_udata/local-agent-mode-sessions"

  # Ensure the two parent dirs exist so the find calls below observe an empty
  # dir (0 matches) instead of failing "No such file or directory". Normally
  # install-instance.sh pre-creates these; add-instance-less callers (like the
  # launchd watcher running before an install has finished) don't have that
  # guarantee.
  mkdir -p "$m_ccs" "$m_lams"

  # UUID resolution: try on-disk find FIRST, fall to config.json derivation
  # if any of the four UUIDs is unresolvable that way.
  #
  # find is preferred when it works because it observes actual on-disk state —
  # if Desktop assigns a different UUID than config.json's lastKnownAccountUuid
  # (unusual but theoretically possible after an account switch), the on-disk
  # UUID is what Desktop is actively using and must be what we symlink.
  #
  # `find -L`: after the first successful run, the org UUID under the mirror's
  # acct is a SYMLINK (pointing at the primary's org dir), and BSD `find -type
  # d` without `-L` won't match a symlink. `-L` makes find follow symlinks so
  # an already-symlinked layout still discovers the acct/org pair — the
  # watcher then observes "already correct" instead of "not logged in yet".
  # Load-bearing for idempotency under repeated launchd fires.
  local m_acct_uuid="" m_org_uuid="" p_acct_uuid="" p_org_uuid=""
  local uuid_source="find"

  local m_acct
  m_acct="$(find -L "$m_ccs" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2> /dev/null | head -1)"
  if [[ -n "$m_acct" ]]; then
    m_acct_uuid="$(basename "$m_acct")"
    local m_org
    m_org="$(find -L "$m_acct" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2> /dev/null | head -1)"
    if [[ -n "$m_org" ]]; then
      m_org_uuid="$(basename "$m_org")"
      # Primary side. cma_primary_uuids dies if the primary hasn't opened the
      # Code area yet; run in a subshell w/ stderr suppressed so we can fall
      # through to config.json derivation cleanly. `|| p_uuids=""` catches the
      # non-zero exit. shellcheck flags the || for suppressing set -e — that's
      # exactly the intent (we WANT to catch failure and try the config path).
      local p_uuids=""
      # shellcheck disable=SC2310  # deliberate: catch cma_primary_uuids's die, fall to config.json
      p_uuids="$(cma_primary_uuids "$p_udata" 2> /dev/null)" || p_uuids=""
      if [[ -n "$p_uuids" ]]; then
        IFS=$'\t' read -r p_acct_uuid p_org_uuid <<< "$p_uuids"
      fi
    fi
  fi

  # If any of the four UUIDs is still empty, try config.json derivation.
  # This is the new post-OAuth / pre-Code-first-use path: config.json is
  # written on OAuth sign-in, so we can install the symlinks right after
  # sign-in without the user having to click into Code inside Desktop first.
  if [[ -z "$m_acct_uuid" || -z "$m_org_uuid" || -z "$p_acct_uuid" || -z "$p_org_uuid" ]]; then
    local derived=""
    # shellcheck disable=SC2310  # deliberate: derivation is expected to fail on pre-signin mirrors
    if derived="$(_derive_uuids_from_config "$m_udata/config.json" "$p_udata/config.json")" && [[ -n "$derived" ]]; then
      IFS=$'\t' read -r m_acct_uuid m_org_uuid p_acct_uuid p_org_uuid <<< "$derived"
      uuid_source="config.json"
    else
      cma_warn "  not logged in yet (no account UUID discoverable on disk or in config.json) — will retry on next Desktop event"
      return 0
    fi
  fi

  # Ensure the mirror's <acct>/ dir exists before installing the <org> symlink
  # under it. On the find path this is already a real dir; on the config.json
  # path we're creating it fresh here. mkdir -p is a no-op on the former.
  mkdir -p "$m_ccs/$m_acct_uuid"

  # Symlink: mirror's <acct>/<org> → primary's <acct>/<org>.
  symlink_atomic "$m_ccs/$m_acct_uuid/$m_org_uuid" \
    "$p_udata/claude-code-sessions/$p_acct_uuid/$p_org_uuid"

  # ── Agent-mode subagent metadata symlink ──────────────────────────────
  # Same shape but only account-scoped (no org-level partition below).
  # Use the m_acct_uuid we already resolved (find or config.json) — same
  # account UUID regardless of which dir it was discovered from.
  symlink_atomic "$m_lams/$m_acct_uuid" \
    "$p_udata/local-agent-mode-sessions/$p_acct_uuid"

  if [[ "$uuid_source" == "config.json" ]]; then
    cma_ok "metadata-symlinks: label=$label all links resolved (uuids derived from config.json)"
  else
    cma_ok "metadata-symlinks: label=$label all links resolved"
  fi
}

main "$@"
