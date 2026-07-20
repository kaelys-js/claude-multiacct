#!/usr/bin/env bash
# ci-local.sh — run this repo's CI workflow locally via `act`.
# See ../docs/local-ci.md (in kaelys-js-infra) for full context.
#
# Usage:
#   bin/ci-local.sh              # run the CI workflow (push event)
#   bin/ci-local.sh --list       # list jobs act would run
#   bin/ci-local.sh -W <path>    # override workflow file
#   bin/ci-local.sh pull_request # use pull_request event instead of push
#
# Environment:
#   ACT_ARGS        extra args passed to act (e.g. "-j lint" for one job)
#   ACT_SECRETS     path to a secrets file (defaults to .act/secrets if present)

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKFLOW=".github/workflows/ci.yml"
EVENT="push"
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    --list) PASSTHRU+=("--list"); shift;;
    -W) WORKFLOW="$2"; shift 2;;
    push | pull_request | workflow_dispatch | schedule) EVENT="$1"; shift;;
    *) PASSTHRU+=("$1"); shift;;
  esac
done

if [ ! -f "$WORKFLOW" ]; then
  printf 'ci-local: workflow not found: %s\n' "$WORKFLOW" >&2
  exit 1
fi

ACT_SECRETS="${ACT_SECRETS:-.act/secrets}"
ARGS=("$EVENT" "-W" "$WORKFLOW" "--container-architecture" "linux/amd64")
if [ -f "$ACT_SECRETS" ]; then
  ARGS+=("--secret-file" "$ACT_SECRETS")
fi
if [ -n "${ACT_ARGS:-}" ]; then
  # shellcheck disable=SC2206  # deliberate word-splitting on user-supplied args
  ARGS+=($ACT_ARGS)
fi
if [ ${#PASSTHRU[@]} -gt 0 ]; then
  ARGS+=("${PASSTHRU[@]}")
fi

# Apple Silicon: force linux/amd64 to avoid arch-mismatch warnings + image
# resolution failures for standard actions runner images.
exec act "${ARGS[@]}"
