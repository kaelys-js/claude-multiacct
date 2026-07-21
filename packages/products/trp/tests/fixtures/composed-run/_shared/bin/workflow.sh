#!/bin/sh
# Fixture-capture stub for the workflow bundle-exchange call.
#
# Real behaviour (production): a Workflow({scriptPath, args}) invocation
# runs an agent script and returns a JSON bundle on stdout. In offline
# replay we can't run the agent, so this stub reads a pre-recorded
# bundle from disk and prints it verbatim.
#
# Contract:
#   - $TRP_BUNDLE_FIXTURE_PATH points at the JSON bundle to emit.
#     The file's contents are printed to stdout unchanged and the stub
#     exits 0.
#   - The invocation is still logged (argv + cwd + stdin) to
#     $TRP_FIXTURE_DIR/workflow-invocations.jsonl so a test can assert
#     the workflow was called with the expected args.
#   - UNMATCHED (env var unset or file missing) -> exit 3 loud.
#     No silent fallback: an offline replay must never hit the model.

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

_log="$TRP_FIXTURE_DIR/workflow-invocations.jsonl"

_stdin_capture="$(read_stdin_capped)"
_argv_json="$(json_string_array "$@")"

_log_line="$(
    jq -cn \
        --arg cwd "$PWD" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson argv "$_argv_json" \
        --arg stdin "$_stdin_capture" \
        --arg bundle_path "${TRP_BUNDLE_FIXTURE_PATH:-}" \
        '{tool: "workflow", ts: $ts, cwd: $cwd, argv: $argv, stdin: $stdin, bundle_path: $bundle_path}'
)"
append_invocation_line "$_log" "$_log_line"

if [ -z "${TRP_BUNDLE_FIXTURE_PATH:-}" ]; then
    die_loud 3 "FIXTURE MISS: workflow stub called without TRP_BUNDLE_FIXTURE_PATH set"
fi

if [ ! -f "$TRP_BUNDLE_FIXTURE_PATH" ]; then
    die_loud 3 "FIXTURE MISS: workflow bundle fixture not found at $TRP_BUNDLE_FIXTURE_PATH"
fi

# Validate the bundle is JSON before emitting -- catches a corrupt
# fixture at the stub boundary rather than downstream in the driver.
if ! jq -e . "$TRP_BUNDLE_FIXTURE_PATH" >/dev/null 2>&1; then
    die_loud 3 "FIXTURE MISS: workflow bundle at $TRP_BUNDLE_FIXTURE_PATH is not valid JSON"
fi

cat "$TRP_BUNDLE_FIXTURE_PATH"
