#!/bin/sh
# Shared helpers for the fixture-capture stubs.
#
# Not on PATH itself -- sourced by gh.sh / curl.sh / workflow.sh via an
# absolute path, so callers never accidentally get a shadowed helper.
#
# Contract:
#   - Requires TRP_FIXTURE_DIR to point at the active fixture root.
#     fixture-setup.sh sets it; if a stub is invoked without it, we
#     bail loud (Rule 12) rather than write logs to an unknown place.
#   - Requires jq on PATH. The response files are JSON, and the whole
#     point of offline replay is deterministic parsing -- shell string
#     munging is not acceptable here.

set -eu

die_loud() {
    # $1 = exit code, $2... = stderr message tokens
    _code="$1"; shift
    printf 'FIXTURE STUB: %s\n' "$*" >&2
    exit "$_code"
}

require_fixture_dir() {
    if [ -z "${TRP_FIXTURE_DIR:-}" ]; then
        die_loud 4 "TRP_FIXTURE_DIR unset -- source fixture-setup.sh before invoking $(basename "$0")"
    fi
    if [ ! -d "$TRP_FIXTURE_DIR" ]; then
        die_loud 4 "TRP_FIXTURE_DIR=$TRP_FIXTURE_DIR is not a directory"
    fi
}

require_jq() {
    if ! command -v jq >/dev/null 2>&1; then
        die_loud 4 "jq not on PATH -- required by fixture stubs"
    fi
}

# json_string_array <items...>
# Emit a JSON array of strings from the given args.
json_string_array() {
    if [ "$#" -eq 0 ]; then
        printf '[]'
        return
    fi
    printf '%s\n' "$@" | jq -R . | jq -sc .
}

# append_invocation_line <log_file> <json_line>
# Append one JSON object per line to <log_file>. Creates the file if absent.
append_invocation_line() {
    _log="$1"; _line="$2"
    mkdir -p "$(dirname "$_log")"
    printf '%s\n' "$_line" >> "$_log"
}

# read_stdin_capped -- slurp stdin up to a cap (16 KB) so a malformed
# caller can't blow the log up. Returns the captured text on stdout.
read_stdin_capped() {
    # Only read if stdin isn't a tty.
    if [ -t 0 ]; then
        printf ''
        return
    fi
    # `head -c` is POSIX-adjacent (in coreutils + BSD), which is all we
    # target here (macOS + Linux CI). Cap at 16 KB.
    head -c 16384
}
