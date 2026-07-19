#!/usr/bin/env bats
# inject-guards.bats — H4: the two asar-injected IIFEs
# (lib/asar-session-propagation.inject.js + lib/asar-remote-control-
# enforcer.inject.js) are evaluated in EVERY Electron process that loads the
# LocalSessionManager singleton chunk — renderer + utility processes included.
# Only the MAIN (browser) process owns a real session store; the others own
# none. On a live machine this leaked watchers + 15s pollers across 7+
# processes ("loaded" 7×, "watching" 11×) — pure overhead on an already
# memory-pressured Mac.
#
# WHY these assertions (Rule 9): the fix is two guards that MUST both be
# present and MUST sit before any watcher/timer install, or the leak returns:
#   1. a main-process gate (`process.type !== "browser"` → bail), and
#   2. a globalThis re-entrancy sentinel (double-eval installs at most one
#      watcher + one timer per process).
# These are asar-injected payloads (not sourced by bash), so the test greps
# the payload files + pins the guard ordering by line number.

bats_require_minimum_version 1.5.0

setup() {
	REPO="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
	export REPO
	export PROP="$REPO/lib/asar-session-propagation.inject.js"
	export ENF="$REPO/lib/asar-remote-control-enforcer.inject.js"
}

@test "H4: session-propagation IIFE has the main-process guard token" {
	grep -qF 'process.type !== "browser"' "$PROP"
}

@test "H4: session-propagation IIFE has the globalThis re-entrancy sentinel" {
	grep -qF 'globalThis.__cma_session_propagation_installed' "$PROP"
}

@test "H4: rc-enforcer IIFE has the main-process guard token" {
	grep -qF 'process.type !== "browser"' "$ENF"
}

@test "H4: rc-enforcer IIFE has the globalThis re-entrancy sentinel" {
	grep -qF 'globalThis.__cma_rc_enforcer_installed' "$ENF"
}

@test "H4: each guard sits inside the outer try AND before the first watcher/timer install" {
	# A bailed process must never reach fs.watch / setInterval. Pin the guard
	# line strictly between the outer `try {` and the first resource-install
	# call in each payload.
	local prop_try prop_guard prop_watch
	prop_try="$(grep -n '^  try {' "$PROP" | head -1 | cut -d: -f1)"
	prop_guard="$(grep -n 'process.type !== "browser"' "$PROP" | head -1 | cut -d: -f1)"
	prop_watch="$(grep -n 'E.watch(' "$PROP" | head -1 | cut -d: -f1)"
	[ -n "$prop_try" ] && [ -n "$prop_guard" ] && [ -n "$prop_watch" ]
	[ "$prop_try" -lt "$prop_guard" ]
	[ "$prop_guard" -lt "$prop_watch" ]

	local enf_try enf_guard enf_interval
	enf_try="$(grep -n '^  try {' "$ENF" | head -1 | cut -d: -f1)"
	enf_guard="$(grep -n 'process.type !== "browser"' "$ENF" | head -1 | cut -d: -f1)"
	enf_interval="$(grep -n 'setInterval(' "$ENF" | head -1 | cut -d: -f1)"
	[ -n "$enf_try" ] && [ -n "$enf_guard" ] && [ -n "$enf_interval" ]
	[ "$enf_try" -lt "$enf_guard" ]
	[ "$enf_guard" -lt "$enf_interval" ]
}

# ── session-propagation delete-safety (A2) ────────────────────────────────
#
# WHY (Rule 9): a cross-process scan can transiently observe an EMPTY or
# mis-resolved storage listing (readdirSync → [] before the Layer-2 symlink
# resolves). The prior delete path — "in the in-memory Map but not in this
# listing → delete + emit deleted" — would then wipe every session and blank
# the sidebar (the "secondary sessions don't load" failure). The fix removes
# cross-process deletion entirely. This runtime harness drops the real payload
# into a Node stub of the LocalSessionManager and drives scanOnce twice:
#   A. 3 live sessions in the Map, storage dir lists NOTHING → ZERO deletions,
#      all 3 sessions survive.
#   B. a new session file appears in the listing → the addition still
#      propagates (emitSessionUpdated fires, the Map gains the session).
# A regression that re-adds a naive delete pass fails scenario A.

@test "session-propagation: an empty scan never deletes sessions; additions still propagate" {
	local harness="$BATS_TEST_TMPDIR/prop-harness.js"
	cat >"$harness" <<'HARNESS'
const path = require('node:path');
const EventEmitter = require('node:events');
// H4 — the payload bails unless it runs in the Electron MAIN process.
process.type = 'browser';

let watchCb = null;
const deleted = [];
const updated = [];

// Minimal fs stub. `__listing` drives readdirSync; `__contents` maps a full
// path to its JSON body. watch() captures the callback so the harness can
// simulate an FSEvents fire.
const E = {
  readdirSync() { return E.__listing; },
  statSync() { return { size: 10 }; },
  readFileSync(f) { return E.__contents[f] || ''; },
  existsSync(f) { return (E.__listing || []).indexOf(path.basename(f)) !== -1; },
  realpathSync(d) { return d; },
  watch(dir, opts, cb) { watchCb = cb; return { on() {}, close() {} }; },
};
E.__listing = [];
E.__contents = {};

const b = path;
const o = {
  LOCAL_SESSION_PREFIX: 'local_',
  SESSION_FILE_MAX_BYTES: 1e9,
  logger: { info() {}, warn() {} },
};
const k = {
  makeRemoteMcpServersIntern() { return null; },
  persistedToActive(parsed) { return parsed; },
};

class Stub extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.deletingSessionIds = new Set();
  }
  getStorageDir() { return '/fake/dir'; }
  emitSessionUpdated(id) { updated.push(id); }
}
const hs = new Stub();
// Record any 'deleted' event the payload might emit (it must emit none).
const _emit = hs.emit.bind(hs);
hs.emit = function (evt, p) {
  if (evt === 'event' && p && p.type === 'deleted') deleted.push(p.sessionId);
  return _emit(evt, p);
};

// ── payload ──
__PAYLOAD__
// ── /payload ──

// Fire the captured fs.watch callback, then wait past the payload's debounce
// (CMA_DEBOUNCE_MS = 500) so the scheduled scanOnce runs.
async function drive() {
  if (watchCb) watchCb('rename', 'local_probe.json');
  await new Promise(r => setTimeout(r, 700));
}

(async () => {
  // Scenario A — empty listing, 3 non-running sessions already in the Map.
  hs.sessions.set('A', { sessionId: 'A', isRunning: false });
  hs.sessions.set('B', { sessionId: 'B', isRunning: false });
  hs.sessions.set('C', { sessionId: 'C', isRunning: false });
  E.__listing = [];
  await drive();
  const survivedEmptyScan = hs.sessions.size === 3;
  const deletedCount = deleted.length;

  // Scenario B — a new session file appears; the addition must propagate.
  hs.sessions.clear();
  const nf = '/fake/dir/local_NEW.json';
  E.__listing = ['local_NEW.json'];
  E.__contents[nf] = JSON.stringify({ sessionId: 'NEW', lastActivityAt: 1, isArchived: false, title: 't', cwd: '/' });
  await drive();
  const added = hs.sessions.has('NEW') && updated.indexOf('NEW') !== -1;

  console.log(JSON.stringify({ survivedEmptyScan, deletedCount, added }));
  process.exit(0);
})();
HARNESS
	# Splice the real payload file in. Use a function replacer so any `$` in
	# the payload isn't interpreted as a replacement pattern.
	CMA_HARNESS="$harness" CMA_PAYLOAD_FILE="$PROP" node -e '
const fs = require("fs");
const t = fs.readFileSync(process.env.CMA_HARNESS, "utf8");
const p = fs.readFileSync(process.env.CMA_PAYLOAD_FILE, "utf8");
fs.writeFileSync(process.env.CMA_HARNESS, t.replace("__PAYLOAD__", () => p));
'
	local result last
	result="$(node "$harness")"
	last="$(printf '%s\n' "$result" | tail -n 1)"
	[[ "$last" == '{"survivedEmptyScan":true,"deletedCount":0,"added":true}' ]]
}
