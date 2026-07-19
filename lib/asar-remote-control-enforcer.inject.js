/* claude-multiacct-rc-enforcer v1 */
// Injected by lib/asar-patch-clone.sh into
// /.vite/build/index.chunk-BpZff9Dw.js (the chunk that instantiates the
// LocalSessionManager singleton `hs = new vt(o.CCD_SESSIONS_BASE_DIR)`).
//
// PURPOSE. `remoteControlAtStartup` (Chunk X-A) auto-enables Remote Control
// on session-CREATE only — via `maybeAutoEnableRemoteControl(session, cfg)`
// which fires from the same code path that calls `saveSession(record)` when
// the session is spun up. Any subsequent drift (user hits `/remote-control`
// off, deployment mode transient flap, session persisted from a pre-Chunk-X
// era and re-loaded off) stays drifted until the next quit + relaunch. The
// user constraint is stronger: "Remote Control STAYS ENABLED ALWAYS FOR ALL
// NON-ARCHIVED SESSIONS ACROSS ALL CLAUDE APPS." This IIFE polls hs.sessions
// every CMA_POLL_MS and re-flips any non-archived session whose
// `remoteControlEnabled` has drifted to false.
//
// MECHANISM. The enforcer calls the SAME method Chunk X-A's auto-enable
// path uses: `hs.handleRemoteControlCommand(session, {auto:true})`. The
// {auto:true} flag suppresses every synthetic user/assistant/result message
// so a background enforcement produces no UI chrome. Internally that method:
//   1. Guards on `getDeploymentMode().shouldEnableSessionsBridge()` — if
//      bridge is disabled at the deployment tier, silently no-ops. Fine.
//   2. Guards on `session.query` — an active Query is required to send the
//      `subtype:"remote_control"` control-request to the CLI worker. Sessions
//      loaded from disk but not yet touched by the user have no query — the
//      enforcer skips them (they cannot be enforced remotely) and waits for
//      the user's first input to trigger the maybeAutoEnableRemoteControl
//      path that Chunk X-A wired up.
//   3. Awaits `query.enableRemoteControl(true, session.title)` — the RPC to
//      sessions.anthropic.com / bridge.claudeusercontent.com.
//   4. On success: mutates `session.remoteControlEnabled=true`, saves. On
//      failure: the internal catch reverts state — the enforcer detects that
//      by re-reading `session.remoteControlEnabled` after the await and
//      counts a failure.
//
// RUNTIME CONTEXT. Same lexical scope as Chunk X-B's propagation IIFE:
//   hs — the LocalSessionManager singleton (the ONE binding this IIFE
//        depends on. If it disappears, the asar-patch fail-loud check at
//        build time refuses to ship.)
//   o.logger — electron-log's shared logger; writes to
//              ~/Library/Logs/Claude/main.log with an [info]/[warn]/[error]
//              prefix and timestamp.
//
// LOG SHAPE.
//   [claude-multiacct-rc-enforcer] armed (poll_ms=15000)
//   [claude-multiacct-rc-enforcer] re-enabled <sessionId>
//   [claude-multiacct-rc-enforcer] failed <sessionId>: <err>
//   [claude-multiacct-rc-enforcer] backoff <sessionId> for 5min (attempt N)
//   [claude-multiacct-rc-enforcer] skip <sessionId>: no active query
//
// BACKOFF. If the same sessionId fails 3 consecutive attempts (either the
// promise rejects OR the internal catch reverts + re-reads to false), the
// enforcer backs off polling that ID for 5 min. Bridge outages, revoked
// tokens, and server-side denials all funnel through the same path — 15 s ×
// 3 = 45 s of noise is enough for the operator to notice via the log, then
// the 5-min quiet period protects sessions.anthropic.com from the enforcer
// hammering during a genuine service-side degradation.
//
// SELF-SUPPRESSION. Unlike Chunk X-B (which self-suppresses own-writes
// coming back through fs.watch), this enforcer has no re-entry pattern —
// each call to handleRemoteControlCommand is idempotent by design (the
// method checks `!e.remoteControlEnabled` before firing; a second call
// against an already-enabled session in auto mode is a fast early-return).
//
// LOAD-BEARING FAILURE MODES.
//   - No sessions yet (user just opened the app): scanOnce is a no-op.
//   - Session's query is null (cold-loaded from disk): logged once at info
//     per session, then that sessionId is skipped until its query appears
//     (checked on every subsequent poll).
//   - handleRemoteControlCommand's internal catch swallows a failed RPC and
//     reverts state to false: the enforcer detects the still-false state
//     post-await and counts a failure toward the 3-strike backoff.
//   - hs.handleRemoteControlCommand is not a function (Claude Desktop
//     restructures the class): the try/catch surfaces the TypeError to
//     o.logger.error and the enforcer keeps polling — the asar-patch
//     build-time anchor check catches this before shipping, so a live app
//     hitting this branch is a REAL bug in the patcher.
//   - hs itself is undefined at IIFE time: the outer try/catch logs to
//     console.error and the enforcer is inert. The instance still runs;
//     Remote Control drift remains unmitigated. Same fallback shape as
//     Chunk X-B's outer catch.
(function claudeMultiacctRemoteControlEnforcer(){
  try {
    // H4 — main-process-only guard. Same rationale as the propagation IIFE:
    // this singleton chunk is evaluated in every Electron process, but only
    // the MAIN (browser) process owns the LocalSessionManager `hs` with real
    // sessions. On a live machine the enforcer logged "loaded" 7× and "armed"
    // 5× across renderer/utility processes that own no session store, each
    // spinning up its own 15s setInterval poll — pure overhead. Bail anywhere
    // but the main process. Guarded inside the outer try/catch so a missing
    // `process` can't throw.
    if (typeof process === "undefined" || process.type !== "browser") return;
    // Re-entrancy sentinel: a double-eval within one process installs at most
    // one poll timer.
    if (globalThis.__cma_rc_enforcer_installed) return;
    globalThis.__cma_rc_enforcer_installed = true;
    var CMA_POLL_MS = 15000;
    var CMA_INITIAL_DELAY_MS = 5000;
    var CMA_MAX_CONSECUTIVE_FAILURES = 3;
    var CMA_BACKOFF_MS = 5 * 60 * 1000;
    var CMA_LOG_TAG = "[claude-multiacct-rc-enforcer]";
    // Sync boot marker — proves the IIFE reached its body before the setTimeout
    // callback registers. Emitted at the SYNCHRONOUS chunk-eval site (before
    // any async work), so its presence in ~/Library/Logs/Claude/main.log
    // definitively answers "did the injected IIFE even run under this Claude
    // Desktop instance?" — the diagnostic that resolved a real "silent
    // no-op" investigation on 2026-07-18 (Electron 42 / V8's function-in-try
    // hoisting interacted with our first-cut logInfo() wrapper such that the
    // setTimeout callback could not resolve the wrapper's identifier on
    // deferred invocation; the fix + the marker ship together so a future
    // regression on the same shape gets caught at the first log line, not
    // deep inside a poll cycle).
    try { o.logger.info(CMA_LOG_TAG + " loaded"); }
    catch (e) { try { console.log(CMA_LOG_TAG + " loaded"); } catch (e2) {} }

    var failures = new Map();     // sessionId → consecutive-failure count
    var backoffUntil = new Map(); // sessionId → epoch-ms until which we skip
    var noQueryLogged = new Set();// sessionIds we've already info-logged "no query" for
    var running = false;

    function logInfo(msg){
      try { o.logger.info(CMA_LOG_TAG + " " + msg); }
      catch (e) { try { console.log(CMA_LOG_TAG + " " + msg); } catch (e2) {} }
    }
    function logWarn(msg){
      try { o.logger.warn(CMA_LOG_TAG + " " + msg); }
      catch (e) { try { console.warn(CMA_LOG_TAG + " " + msg); } catch (e2) {} }
    }
    function logError(msg){
      try { o.logger.error(CMA_LOG_TAG + " " + msg); }
      catch (e) { try { console.error(CMA_LOG_TAG + " " + msg); } catch (e2) {} }
    }

    function recordFailure(sid){
      var n = (failures.get(sid) || 0) + 1;
      failures.set(sid, n);
      if (n >= CMA_MAX_CONSECUTIVE_FAILURES) {
        var until = Date.now() + CMA_BACKOFF_MS;
        backoffUntil.set(sid, until);
        logWarn("backoff " + sid + " for 5min (attempt " + n + ")");
      }
      return n;
    }

    function clearFailure(sid){
      if (failures.has(sid)) failures.delete(sid);
      if (backoffUntil.has(sid)) backoffUntil.delete(sid);
    }

    async function enforceSession(sess){
      var sid = sess.sessionId;
      if (!sid) return;

      // Backoff check — skip if we're inside the quiet window.
      var until = backoffUntil.get(sid);
      if (until && Date.now() < until) return;
      // If the backoff has expired, drop the entry so a fresh attempt runs.
      if (until && Date.now() >= until) backoffUntil.delete(sid);

      // The three no-op fast paths BEFORE calling into the manager. Each one
      // is a "the enforcer has no work to do here" scenario, distinct from
      // "the enforcer TRIED and failed" (which increments the failure count).
      if (sess.isArchived) return;
      if (sess.remoteControlEnabled === true) { clearFailure(sid); return; }
      if (!sess.query) {
        if (!noQueryLogged.has(sid)) {
          logInfo("skip " + sid + ": no active query");
          noQueryLogged.add(sid);
        }
        return;
      }
      // Session has a query and RC is off → attempt the flip.
      noQueryLogged.delete(sid);
      try {
        await hs.handleRemoteControlCommand(sess, {auto:true});
      } catch (err) {
        var m = (err && err.message) ? err.message : String(err);
        logWarn("failed " + sid + ": " + m);
        recordFailure(sid);
        return;
      }
      // handleRemoteControlCommand's internal catch swallows the query error
      // and reverts state to false. Post-await re-check IS the "did the flip
      // actually stick?" test.
      if (sess.remoteControlEnabled === true) {
        logInfo("re-enabled " + sid);
        clearFailure(sid);
      } else {
        var n = recordFailure(sid);
        if (n < CMA_MAX_CONSECUTIVE_FAILURES) {
          logWarn("no-op " + sid + " (attempt " + n + ")");
        }
      }
    }

    async function enforceOnce(){
      if (running) return;
      running = true;
      try {
        var snapshot;
        // Snapshot the values so a concurrent mutation of hs.sessions during
        // our await loop doesn't invalidate the iterator.
        try { snapshot = Array.from(hs.sessions.values()); }
        catch (err) { logWarn("enumerate error: " + (err && err.message)); return; }
        for (var i = 0; i < snapshot.length; i++) {
          try { await enforceSession(snapshot[i]); }
          catch (err) { logError("enforceSession threw: " + (err && err.message)); }
        }
      } finally {
        running = false;
      }
    }

    // Boot: delay CMA_INITIAL_DELAY_MS after IIFE runs so the session-manager
    // finishes its own initial fill (`Loaded N persisted sessions from …`)
    // before the first enforcement pass. This also lets Chunk X-A's own
    // maybeAutoEnableRemoteControl fire on any auto-created session before
    // the enforcer sees it — avoids the enforcer double-firing a flip that
    // Chunk X-A is about to do anyway.
    setTimeout(function(){
      // Kick off + set the recurring poll. Diagnostics for the "no armed
      // line" investigation (2026-07-18): log inline via o.logger.info
      // AND console.log so we can attribute either channel independently.
      // The prior indirection through logInfo() silently no-op'd inside
      // Electron's setTimeout scope for reasons that remain under
      // investigation — the direct-call form here is what we ship.
      try { o.logger.info(CMA_LOG_TAG + " armed (poll_ms=" + CMA_POLL_MS + ")"); }
      catch (e) { try { console.log(CMA_LOG_TAG + " armed (poll_ms=" + CMA_POLL_MS + ")"); } catch (e2) {} }
      try { o.logger.info(CMA_LOG_TAG + " session-count=" + (hs && hs.sessions ? hs.sessions.size : "n/a")); } catch (e) {}
      enforceOnce().catch(function(err){
        try { o.logger.error(CMA_LOG_TAG + " initial enforcement threw: " + (err && err.message)); }
        catch (e) {}
      });
      var t = setInterval(function(){
        enforceOnce().catch(function(err){
          try { o.logger.error(CMA_LOG_TAG + " polled enforcement threw: " + (err && err.message)); }
          catch (e) {}
        });
      }, CMA_POLL_MS);
      // setInterval keeps the event loop alive by default; unref() lets the
      // process exit cleanly if nothing else is holding it open.
      if (t && typeof t.unref === "function") t.unref();
    }, CMA_INITIAL_DELAY_MS);
  } catch (err) {
    try { console.error("[claude-multiacct-rc-enforcer] init failed:", err); } catch (e) {}
  }
})();
