#!/bin/sh
# Fixture-capture stub for `curl` -- narrowed to the ClickUp POSTs the
# tracker layer issues.
#
# Behaviour:
#   1. Log the invocation (argv + cwd + stdin/body + resolved host + path)
#      as one JSON line to $TRP_FIXTURE_DIR/tracker-invocations.jsonl.
#   2. Look up a canned response by (host, path) at
#      $TRP_FIXTURE_DIR/curl-responses/<host>/<slugified-path>.json.
#      A per-host fallback file at
#      $TRP_FIXTURE_DIR/curl-responses/<host>/_default.json is honoured
#      when no path-specific file exists -- fixtures often only care
#      about the host boundary (ClickUp API returned OK).
#   3. Print `.stdout` (or `.body`) to stdout, `.stderr` to stderr,
#      exit with `.exit`.
#   4. UNMATCHED host -> exit 3 with a loud stderr banner. No silent
#      network egress from a fixture replay.

set -eu

_self="$0"
while [ -L "$_self" ]; do
    _link_target="$(readlink "$_self")"
    case "$_link_target" in
        /*) _self="$_link_target" ;;
        *) _self="$(dirname "$_self")/$_link_target" ;;
    esac
done
_shared_bin="$(cd "$(dirname "$_self")" && pwd)"
# shellcheck source=_json.sh
. "$_shared_bin/_json.sh"

require_fixture_dir
require_jq

_log="$TRP_FIXTURE_DIR/tracker-invocations.jsonl"
_responses_dir="$TRP_FIXTURE_DIR/curl-responses"

_stdin_capture="$(read_stdin_capped)"
_argv_json="$(json_string_array "$@")"

# Extract the URL. `curl` accepts the URL as any positional arg (not
# always the last), and it can also come from `--url <URL>` /
# `--url=<URL>`. Walk argv once and pick the first thing that looks
# like an http(s) URL.
_url=""
_next_is_url=0
for _arg in "$@"; do
    if [ "$_next_is_url" -eq 1 ]; then
        _url="$_arg"
        _next_is_url=0
        continue
    fi
    case "$_arg" in
        --url=*) _url="${_arg#--url=}" ;;
        --url) _next_is_url=1 ;;
        http://*|https://*) _url="$_arg" ;;
    esac
    if [ -n "$_url" ]; then
        break
    fi
done

if [ -z "$_url" ]; then
    die_loud 3 "FIXTURE MISS: curl invoked with no URL in argv"
fi

# Parse host + path out of the URL via a small awk. sh doesn't have
# native URL parsing, and we want to be exact about the boundary
# ClickUp (or any other host) sits at.
_host="$(printf '%s' "$_url" | awk -F/ '{print $3}')"
_path="$(printf '%s' "$_url" | awk -F/ '{ for (i=4;i<=NF;i++) printf "/" $i }')"
if [ -z "$_path" ]; then
    _path="/"
fi

# Slug: replace `/` with `_` and strip a leading `_` so a file for
# `/api/v2/task/12345/comment` lives at `api_v2_task_12345_comment.json`.
# The query string (?foo=bar) is stripped -- fixtures key on the
# endpoint, not the specific parameter values.
_path_no_query="${_path%%\?*}"
_path_slug="$(printf '%s' "$_path_no_query" | tr '/' '_' | sed 's/^_//')"
if [ -z "$_path_slug" ]; then
    _path_slug="root"
fi

_log_line="$(
    jq -cn \
        --arg cwd "$PWD" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson argv "$_argv_json" \
        --arg stdin "$_stdin_capture" \
        --arg url "$_url" \
        --arg host "$_host" \
        --arg path "$_path_no_query" \
        '{tool: "curl", ts: $ts, cwd: $cwd, host: $host, url: $url, path: $path, argv: $argv, body: $stdin}'
)"
append_invocation_line "$_log" "$_log_line"

# Response lookup: (host, path-slug) > (host, _default) > MISS.
_host_dir="$_responses_dir/$_host"
if [ ! -d "$_host_dir" ]; then
    die_loud 3 "FIXTURE MISS: curl host $_host not canned (no dir $_host_dir)"
fi

_response_file="$_host_dir/$_path_slug.json"
if [ ! -f "$_response_file" ]; then
    _response_file="$_host_dir/_default.json"
fi

if [ ! -f "$_response_file" ]; then
    die_loud 3 "FIXTURE MISS: curl $_host $_path_no_query not canned (looked for $_host_dir/$_path_slug.json)"
fi

_stdout="$(jq -r '.stdout // .body // ""' "$_response_file")"
_stderr="$(jq -r '.stderr // ""' "$_response_file")"
_exit="$(jq -r '.exit // 0' "$_response_file")"

if [ -n "$_stdout" ]; then
    printf '%s' "$_stdout"
fi
if [ -n "$_stderr" ]; then
    printf '%s' "$_stderr" >&2
fi
exit "$_exit"
