#!/bin/sh
# Fixture-capture stub for `gh`.
#
# Behaviour:
#   1. Log the invocation (argv + cwd + stdin) as one JSON line to
#      $TRP_FIXTURE_DIR/gh-invocations.jsonl.
#   2. Look up a canned response by subcommand at
#      $TRP_FIXTURE_DIR/gh-responses/<subcommand>.json.
#      The response file is `{"stdout": "...", "stderr": "...", "exit": N}`;
#      stderr is optional.
#   3. Print `.stdout` to stdout, `.stderr` (if present) to stderr, and
#      exit with `.exit`.
#   4. UNMATCHED subcommand -> exit 3 with a loud stderr banner.
#      No silent pass-through -- an offline replay must never hit the
#      network, so a miss is a test failure (Rule 12).

set -eu

_here="$(cd "$(dirname "$0")" && pwd)"
# When invoked via a symlink at <fixture>/bin/gh -> _shared/bin/gh.sh,
# $0 is the symlink; dirname gives us <fixture>/bin. That's fine -- we
# read TRP_FIXTURE_DIR from the env for the log/response roots. The
# `_here` variable is only used to source the shared helpers, which
# live next to this script in `_shared/bin/`.
#
# Resolve the physical path of THIS script (through the symlink) so we
# can source _json.sh even when invoked via the symlink. `readlink` on
# BSD (macOS) doesn't have -f; use a portable loop.
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

_log="$TRP_FIXTURE_DIR/gh-invocations.jsonl"
_responses_dir="$TRP_FIXTURE_DIR/gh-responses"

# Capture stdin so we can log it AND (potentially) let a response file
# assert on it in the future. We store it as a UTF-8 string.
_stdin_capture="$(read_stdin_capped)"

# Argv as a JSON array.
_argv_json="$(json_string_array "$@")"

# Build the log line via jq so we get correct escaping for every field.
_log_line="$(
    jq -cn \
        --arg cwd "$PWD" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson argv "$_argv_json" \
        --arg stdin "$_stdin_capture" \
        '{tool: "gh", ts: $ts, cwd: $cwd, argv: $argv, stdin: $stdin}'
)"
append_invocation_line "$_log" "$_log_line"

# Route on the first positional arg. `gh` supports `--help` etc. before
# the subcommand; we treat those as their own "subcommand" for lookup
# purposes so the fixture author sees them in the miss message.
_subcommand="${1:-}"

if [ -z "$_subcommand" ]; then
    die_loud 3 "FIXTURE MISS: gh invoked with no subcommand"
fi

_response_file="$_responses_dir/$_subcommand.json"
if [ ! -f "$_response_file" ]; then
    die_loud 3 "FIXTURE MISS: gh $_subcommand not canned (looked for $_response_file)"
fi

# Emit stdout, stderr (optional), exit.
_stdout="$(jq -r '.stdout // ""' "$_response_file")"
_stderr="$(jq -r '.stderr // ""' "$_response_file")"
_exit="$(jq -r '.exit // 0' "$_response_file")"

if [ -n "$_stdout" ]; then
    printf '%s' "$_stdout"
fi
if [ -n "$_stderr" ]; then
    printf '%s' "$_stderr" >&2
fi
exit "$_exit"
