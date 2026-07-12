#!/usr/bin/env bash
# TRP-EE: main-context wrapper that runs the fix-task driver + auto-loops on
# exit 66 (Stage 5-8 failure) or 67 (post-push external review flagged).
#
# Loop mechanics:
#   1. Run driver.
#   2. If exit 66 or 67 → workflow needs re-invoking with previous_attempt.
#      This wrapper can't call Workflow() (that's a Claude-session tool), so
#      it prints the exact command a Claude session should execute, then exits.
#   3. If exit 0 → done, print success summary.
#   4. Any other exit → hard fail, print details.
#
# Usage:
#   ./scripts/trp-run-loop.sh <TRACKER>:<TASK_ID> [--push | --push-force] [--attempt=N]
#
# When exit 66/67 fires and this wrapper prints the "next step" for main
# context to execute, the main context Claude session can:
#   a) Run `python3 scripts/prep-revise-input.py > /tmp/revise-args.json`
#      (TASK_ID_SLUG=<slug>). This bundles the failure JSON into workflow args.
#   b) Invoke Workflow({scriptPath:'workflows/trp-fix-task.js',
#                       args:<contents of /tmp/revise-args.json>})
#   c) Write the returned bundle to discovery/trp-bundle-<slug>.json
#   d) Re-run this wrapper with --attempt=<N+1> [--push-force].
#
# The wrapper doesn't try to auto-invoke Workflow because the Workflow tool
# only exists inside a Claude session. But every OTHER step is scripted.
#
# Remote-mutation gate: when TRP_ALLOW_REMOTE_MUTATE != "true", any stage
# that would push, open/edit a PR, POST to GitHub, or write to ClickUp is
# skipped cleanly (not an error). Stage 8+ halts before mutating remotes.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

_usage() {
  cat <<'USAGE'
Usage:
  trp-run-loop.sh <TRACKER>:<TASK_ID> [OPTIONS]

Options:
  --mode=<MODE>       Explicit mode override. Auto-detected from task shape if omitted.
                      spike-writeup — investigate + write-up only, no code changes
                      spike-solve   — spike-writeup + a bundled code fix
                      spike-full    — spike-solve + follow-up child ticket
                      solve         — default for non-spike tickets
                      reproduce     — failing regression test + minimal writeup, no PR
                      support       — tracker-comment answer only, no code change
  --push              Open PR + tracker comment. Gated by TRP_ALLOW_REMOTE_MUTATE=true.
  --push-force        Force-push + regenerate PR body. Gated as above.
  --attempt=N         Nth REVISE-loop attempt (SRP-J shape).
  --repo=<SLUG>       Multi-repo task: run against one client repo per invocation.
  -h, --help          Print this usage and exit 0.

Example:
  ./scripts/trp-run-loop.sh clickup:HAND_ITC-308
      # auto-detects [SPIKE] shape, runs spike-writeup, refuses to post
      # without TRP_ALLOW_REMOTE_MUTATE=true.
USAGE
}

# --help / -h / empty -> print usage BEFORE argparse, so a bare invocation
# doesn't cascade into "unbound variable" on DRIVER_ARGS.
case "${1:-}" in
  -h|--help) _usage; exit 0 ;;
  '')        _usage >&2; exit 2 ;;
esac

TASK_ID="${1}"
shift
# Bash 3.2-safe: ${arr[@]} on empty arrays under `set -u` blows up as
# "unbound variable". `${arr[@]+"${arr[@]}"}` expands to nothing when the
# array is empty, and to the tokens otherwise.
DRIVER_ARGS=("${@+"$@"}")

# Slug: "clickup:HAND_ITC-308" -> "clickup_hand_itc-308"
TASK_ID_SLUG=$(echo "$TASK_ID" | tr ':/[:upper:]' '__[:lower:]' | tr -c 'a-z0-9_-' '_' | sed 's/_*$//; s/^_*//')
ATTEMPT=1
REPO_SLUG=""
MODE_OVERRIDE=""
for a in ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"}; do
  case "$a" in
    --attempt=*) ATTEMPT="${a#*=}" ;;
    --repo=*)    REPO_SLUG="${a#*=}" ;;
    --mode=*)    MODE_OVERRIDE="${a#*=}" ;;
  esac
done
# Per-repo bundle file (multi-repo tasks write distinct bundles per repo).
BUNDLE_SUFFIX=""
[ -n "$REPO_SLUG" ] && BUNDLE_SUFFIX="-$REPO_SLUG"
BUNDLE_PATH="discovery/trp-bundle-${TASK_ID_SLUG}${BUNDLE_SUFFIX}.json"

LOG="discovery/trp-run-${TASK_ID_SLUG}.log"
mkdir -p discovery

echo "=== TRP-EE loop wrapper for $TASK_ID (attempt=$ATTEMPT) ==="

# Resolve TRP_TASK_MODE: explicit --mode wins; else auto-detect from bundle's
# intent_extract.is_spike (if bundle already exists from a prior workflow
# invocation); else default to solve. spike-writeup is the safest default for
# a fresh spike ticket — never mutates disk beyond the writeup + never pushes.
TASK_JSON_PATH="discovery/task-${TASK_ID_SLUG}.json"
if [ -n "$MODE_OVERRIDE" ]; then
  TRP_TASK_MODE="$MODE_OVERRIDE"
elif [ -f "$BUNDLE_PATH" ]; then
  # Bundle-based detection — most authoritative. Available on iteration 2+.
  IS_SPIKE=$(python3 -c "
import json, sys
try:
  b = json.loads(open('$BUNDLE_PATH').read())
  ie = b.get('intent_extract') or {}
  print('true' if (ie.get('is_spike') or b.get('is_spike')) else 'false')
except Exception:
  print('false')
" 2>/dev/null || echo false)
  if [ "$IS_SPIKE" = "true" ]; then
    TRP_TASK_MODE="spike-writeup"
  else
    TRP_TASK_MODE="solve"
  fi
elif [ -f "$TASK_JSON_PATH" ]; then
  # First-iteration detection: read the fetched task JSON directly. Look at
  # both the title (fastest signal: [SPIKE] prefix or spike-verb start) and
  # the description text_content for investigative-verb density.
  IS_SPIKE=$(python3 <<PY 2>/dev/null || echo false
import json, re
try:
  d = json.load(open("$TASK_JSON_PATH"))
  title = (d.get('name') or d.get('title') or '')
  desc  = (d.get('text_content') or d.get('description') or '')
  criteria_block = ''
  # ClickUp custom_fields sometimes carry an "Acceptance Criteria" field —
  # fold it in when present.
  for f in (d.get('custom_fields') or []):
    if 'acceptance' in (f.get('name','') or '').lower():
      criteria_block += '\n' + str(f.get('value','') or '')
  body = (title + '\n' + desc + '\n' + criteria_block).lower()
  # Rule 1: explicit [SPIKE] prefix in title.
  if re.search(r'\[spike\]', title, re.I):
    print('true'); raise SystemExit
  # Rule 2: title starts with a spike verb.
  if re.match(r'^\s*(spike|research|investigate|explore|figure[- _]?out)\b', title, re.I):
    print('true'); raise SystemExit
  # Rule 3: majority of investigative-verb hits vs code-shape hits in body.
  spike_verbs = re.findall(
    r'\b(propose|describe|state|estimate|investigate|identify how|research|recommend|evaluate|compare|assess|explore|figure[- _]?out|determine|spike|review|examine|analyse|analyze|understand|characteri[sz]e|benchmark|survey|audit|weigh|consider)\b',
    body)
  code_shape = re.findall(
    r'\b(endpoint returns|page renders|test turns green|route responds|add a test|write a test|component renders|api returns|migration adds|db writes)\b',
    body)
  if len(spike_verbs) >= max(2, len(code_shape) + 1):
    print('true'); raise SystemExit
  print('false')
except SystemExit:
  pass
except Exception:
  print('false')
PY
)
  if [ "$IS_SPIKE" = "true" ]; then
    TRP_TASK_MODE="spike-writeup"
  else
    TRP_TASK_MODE="solve"
  fi
else
  # No bundle AND no task JSON — cannot auto-detect. Default to solve; the
  # operator can override with --mode.
  TRP_TASK_MODE="solve"
fi
case "$TRP_TASK_MODE" in
  spike-writeup|spike-solve|spike-full|solve|reproduce|support) ;;
  *) echo "ERROR: --mode=$TRP_TASK_MODE not in {spike-writeup,spike-solve,spike-full,solve,reproduce,support}" >&2; exit 2 ;;
esac
export TRP_TASK_MODE
echo "   TRP_TASK_MODE=$TRP_TASK_MODE ($([ -n "$MODE_OVERRIDE" ] && echo 'explicit --mode' || echo 'auto-detected'))"

# Remote-mutation gate: halt before Stage 8+ (push/PR/ClickUp writes) unless
# TRP_ALLOW_REMOTE_MUTATE=true. Strip --push* args from the driver invocation
# when the gate is closed so downstream stages can't mutate remotes.
GATED_ARGS=()
STRIPPED_PUSH=""
if [ "${TRP_ALLOW_REMOTE_MUTATE:-false}" != "true" ]; then
  for a in ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"}; do
    case "$a" in
      --push|--push-force)
        STRIPPED_PUSH="$a"
        ;;
      *)
        GATED_ARGS+=("$a")
        ;;
    esac
  done
  if [ -n "$STRIPPED_PUSH" ]; then
    echo "   TRP: remote mutation blocked — set TRP_ALLOW_REMOTE_MUTATE=true to enable" | tee -a "$LOG" >&2
    echo "   TRP: dropped driver arg '$STRIPPED_PUSH'; Stage 8+ will not run" | tee -a "$LOG" >&2
  fi
else
  GATED_ARGS=(${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"})
fi

if [ "${TRP_ALLOW_REMOTE_MUTATE:-false}" != "true" ]; then
  ./scripts/fix-task.sh "$TASK_ID" \
    --after-workflow="$BUNDLE_PATH" \
    ${GATED_ARGS[@]+"${GATED_ARGS[@]}"}
  STATUS=$?
else
  ./scripts/fix-task.sh "$TASK_ID" \
    --after-workflow="$BUNDLE_PATH" \
    ${GATED_ARGS[@]+"${GATED_ARGS[@]}"}
  STATUS=$?
fi

case $STATUS in
  0)
    echo ""
    echo "=== TRP-EE: SUCCESS (attempt $ATTEMPT) ==="
    ;;
  66|67)
    NEXT_ATTEMPT=$((ATTEMPT + 1))
    STAGE=$( [ "$STATUS" = 66 ] && echo "Stage 5-8" || echo "post-push external review" )
    echo ""
    echo "=== TRP-EE: HALT (exit $STATUS — $STAGE) ==="
    echo "  Next step (main Claude session):"
    echo ""
    echo "  1. Prep REVISE args:"
    echo "     TASK_ID_SLUG=$TASK_ID_SLUG python3 scripts/prep-revise-input.py > /tmp/trp-revise-args.json"
    echo ""
    echo "  2. Invoke workflow with those args:"
    echo "     Workflow({ scriptPath: 'workflows/trp-fix-task.js',"
    echo "                args: <parsed JSON contents of /tmp/trp-revise-args.json> })"
    echo ""
    echo "  3. Write returned bundle:"
    echo "     python3 -c \"import json,sys,pathlib; pathlib.Path('discovery/trp-bundle-${TASK_ID_SLUG}.json').write_text(json.dumps(<result>))\""
    echo ""
    echo "  4. Re-run this wrapper:"
    local_push_arg=""
    for a in ${DRIVER_ARGS[@]+"${DRIVER_ARGS[@]}"}; do
      case "$a" in --push*) local_push_arg="$a" ;; esac
    done
    echo "     ./scripts/trp-run-loop.sh $TASK_ID $local_push_arg --attempt=$NEXT_ATTEMPT"
    echo ""
    exit $STATUS
    ;;
  *)
    echo ""
    echo "=== TRP-EE: HARD FAIL (exit $STATUS) ==="
    exit $STATUS
    ;;
esac
