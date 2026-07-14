#!/bin/sh
# fixture-setup.sh -- prep the shell for an offline composed-run replay.
#
# Usage:
#   . <fixture>/bin/fixture-setup.sh <fixture-dir> [bundle-fixture]
#
# The first positional arg is the fixture root (the directory that
# contains gh-responses/, curl-responses/, gh-invocations.jsonl, etc.).
# The second (optional) arg is a path to the workflow bundle fixture
# for this run; when provided, TRP_BUNDLE_FIXTURE_PATH is exported so
# workflow.sh can replay it.
#
# What this script does:
#   - Prepends <fixture>/bin to PATH so `gh`, `curl`, `workflow` all
#     resolve to the stubs before any real binary. Symlinks under
#     <fixture>/bin/ named `gh`, `curl`, `workflow` must already exist
#     and point at ../../_shared/bin/gh.sh (etc.).
#   - Exports TRP_FIXTURE_DIR (required by every stub).
#   - Exports TRP_BUNDLE_FIXTURE_PATH when the second arg is given.
#   - Truncates the three invocation logs so a fresh run starts clean.
#   - Sets a couple of deterministic env vars the driver reads at
#     runtime (TRP mode markers, offline flag) so tests don't have to
#     export them per case.
#
# This script MUST be sourced, not executed, so the PATH change and
# env vars survive into the caller's shell.

if [ -z "${1:-}" ]; then
    echo "fixture-setup.sh: fixture root is required" >&2
    return 2 2>/dev/null || exit 2
fi

_fixture_dir="$1"
_bundle_fixture="${2:-}"

if [ ! -d "$_fixture_dir" ]; then
    echo "fixture-setup.sh: $_fixture_dir is not a directory" >&2
    return 2 2>/dev/null || exit 2
fi

# Resolve to an absolute path so PATH stays valid even if the caller
# later cd's away.
_fixture_dir_abs="$(cd "$_fixture_dir" && pwd)"

if [ ! -d "$_fixture_dir_abs/bin" ]; then
    echo "fixture-setup.sh: $_fixture_dir_abs/bin missing -- expected symlinks to _shared/bin stubs" >&2
    return 2 2>/dev/null || exit 2
fi

# Prepend the stub dir to PATH. Guard against double-prepending on
# repeated sources (harmless but noisy).
case ":$PATH:" in
    *":$_fixture_dir_abs/bin:"*) : ;;
    *) PATH="$_fixture_dir_abs/bin:$PATH" ;;
esac
export PATH

export TRP_FIXTURE_DIR="$_fixture_dir_abs"

if [ -n "$_bundle_fixture" ]; then
    if [ ! -f "$_bundle_fixture" ]; then
        echo "fixture-setup.sh: bundle fixture $_bundle_fixture not found" >&2
        return 2 2>/dev/null || exit 2
    fi
    export TRP_BUNDLE_FIXTURE_PATH="$(cd "$(dirname "$_bundle_fixture")" && pwd)/$(basename "$_bundle_fixture")"
fi

# Fresh logs per replay -- a stale log from a previous run would let a
# test pass on old data.
: > "$TRP_FIXTURE_DIR/gh-invocations.jsonl"
: > "$TRP_FIXTURE_DIR/tracker-invocations.jsonl"
: > "$TRP_FIXTURE_DIR/workflow-invocations.jsonl"

# Driver env vars the composed-run harness reads. These are the
# minimum set required so the driver doesn't consult real config
# during replay; individual fixtures can override before running the
# case under test.
export TRP_OFFLINE_REPLAY=1
export TRP_DISABLE_NETWORK=1
# `gh` in the wild reads GH_TOKEN; give it a synthetic value so any
# path that guards on "token present" stays green without touching a
# real credential.
export GH_TOKEN="fixture-token-not-real"
# ClickUp side.
export CLICKUP_TOKEN="pk_fixture_not_real"

unset _fixture_dir _fixture_dir_abs _bundle_fixture _link_target
