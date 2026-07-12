#!/usr/bin/env bash
# Fake fix-task driver used by the trp-run-loop parity test. Prints exactly
# one line so both Bash and TS wrappers produce identical stdout.
set -euo pipefail
echo "FAKE_FIX_TASK: $*"
exit 0
