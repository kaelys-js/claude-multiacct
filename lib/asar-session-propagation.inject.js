/* claude-multiacct-session-propagation v1 */
// Injected by lib/asar-patch-clone.sh into
// /.vite/build/index.chunk-BpZff9Dw.js (the chunk that instantiates the
// LocalSessionManager singleton and re-exports it as
// `exports.claudeCodeSessionManager`).
//
// PURPOSE. Claude Desktop reads local_<sessId>.json under the userData's
// claude-code-sessions dir at startup into an in-memory Map keyed by sessionId
// and never watches that dir at runtime. When a peer Claude Desktop process
// (primary or another mirror) mutates a session file via the Layer-2 symlink
// shared with this instance, the on-disk state changes but this process's
// in-memory Map does not — the sidebar keeps rendering the pre-mutation state
// until the app is quit + relaunched. This injection installs an fs.watch on
// the storage dir (macOS resolves the recursive:true option via FSEvents which
// fires across the Layer-2 symlink), debounces bursts, rescans changed files,
// updates the in-memory Map, and calls hs.emitSessionUpdated / emit("event",
// {type:"deleted",sessionId}) — the SAME emit paths the manager uses for its
// own mutations, so every renderer subscription that already listens on the
// singleton reacts without any renderer-side patching.
//
// RUNTIME CONTEXT. The chunk's top-level scope has, at inject time:
//   E   — require("node:fs")
//   b   — require("node:path")
//   o   — require("./index.chunk-DD6nxfJK.js")  (o.LOCAL_SESSION_PREFIX,
//          o.SESSION_FILE_MAX_BYTES, o.logger)
//   k   — require("./index.chunk-D3da7joD.js")  (k.persistedToActive,
//          k.makeRemoteMcpServersIntern)
//   hs  — the LocalSessionManager singleton
// The IIFE below closes over these lexically; a Claude Desktop update that
// renames any of them will fail loud at watcher-install time (the try/catch
// on the outer level logs the error and no-ops; docs/architecture.md § 5
// documents the recovery path).
//
// SELF-SUPPRESSION. Every write hs makes to a session file first hits the
// intercepted saveSession wrapper below, which timestamps the sessionId in
// `ownWrites`. A subsequent fs.watch fire that names the SAME sessionId
// within CMA_OWN_WRITE_WINDOW_MS is treated as our own writeback and skipped
// — otherwise the debounced rescan would re-read our own writes and emit
// spurious duplicate session_updated events for local edits.
//
// DEBOUNCE. macOS FSEvents batches file mutations into 300–800 ms windows
// per Node's own docs. CMA_DEBOUNCE_MS=500 collapses a burst (e.g. Claude
// writing 74 sessions during initial sync) into a single rescan.
//
// DELETE DETECTION. Files present in the in-memory Map but absent on disk
// after a scan are emitted as {type:"deleted",sessionId}. A guard on
// `isRunning` skips sessions the user is actively driving — those persist
// via saveSession's own debounced write cycle and racing the scan against
// that would flag a live session as deleted for the brief interval between
// deletion of the temp file and rename of the new one. `deletingSessionIds`
// (owned by the manager) is also honoured so mid-flight teardowns don't
// double-emit deletions.
//
// LOAD-BEARING FAILURE MODES.
//   - No storage dir yet (user hasn't signed in): installWatcher no-ops and
//     the boot poll retries every 2 s.
//   - fs.watch throws (e.g. ENOSPC on the FSEvents descriptor): logged via
//     o.logger.warn and the boot poll retries.
//   - persistedToActive throws on a corrupt JSON blob: the file is skipped
//     for THIS scan; no state churn, next fs mutation retries.
//   - The whole IIFE throws before any watcher is installed: the outer
//     try/catch surfaces via console.error; the mirror continues to run in
//     stale-cache mode, which is the pre-Chunk-X-B behaviour.
(function claudeMultiacctSessionPropagation(){
  try {
    var CMA_DEBOUNCE_MS = 500;
    var CMA_OWN_WRITE_WINDOW_MS = 3000;
    var CMA_LOG_TAG = "[claude-multiacct-propagation]";
    var watcher = null;
    var debounceTimer = null;
    var lastWatchedDir = null;
    var ownWrites = new Map();

    var origSave = hs.saveSession && hs.saveSession.bind(hs);
    if (origSave) {
      hs.saveSession = function(session){
        if (session && session.sessionId) ownWrites.set(session.sessionId, Date.now());
        return origSave(session);
      };
    }

    function isOwnRecent(sid){
      var t = ownWrites.get(sid);
      return typeof t === "number" && (Date.now() - t) < CMA_OWN_WRITE_WINDOW_MS;
    }

    function scanOnce(){
      var dir = hs.getStorageDir && hs.getStorageDir();
      if (!dir) return;
      var files;
      try { files = E.readdirSync(dir); } catch (err) { return; }
      var foundIds = new Set();
      var intern;
      try { intern = k.makeRemoteMcpServersIntern(); } catch (err) { intern = null; }
      for (var i = 0; i < files.length; i++) {
        var fname = files[i];
        if (fname.indexOf(o.LOCAL_SESSION_PREFIX) !== 0) continue;
        if (fname.slice(-5) !== ".json") continue;
        var full = b.join(dir, fname);
        var content;
        try {
          var st = E.statSync(full);
          if (st.size > o.SESSION_FILE_MAX_BYTES) continue;
          content = E.readFileSync(full, "utf-8");
        } catch (err) { continue; }
        if (!content || !content.trim()) continue;
        var parsed;
        try { parsed = JSON.parse(content); } catch (err) { continue; }
        if (!parsed || !parsed.sessionId) continue;
        foundIds.add(parsed.sessionId);
        if (isOwnRecent(parsed.sessionId)) continue;
        if (hs.deletingSessionIds && hs.deletingSessionIds.has(parsed.sessionId)) continue;
        var active;
        try { active = k.persistedToActive(parsed, intern); } catch (err) { continue; }
        var existing = hs.sessions.get(parsed.sessionId);
        if (existing &&
            existing.lastActivityAt === active.lastActivityAt &&
            existing.isArchived === active.isArchived &&
            existing.title === active.title &&
            existing.cwd === active.cwd) {
          continue;
        }
        hs.sessions.set(parsed.sessionId, active);
        try { hs.emitSessionUpdated(parsed.sessionId); } catch (err) {}
      }
      var stale = [];
      hs.sessions.forEach(function(sess, sid){
        if (foundIds.has(sid)) return;
        if (sess && sess.isRunning) return;
        var guess = b.join(dir, o.LOCAL_SESSION_PREFIX + sid + ".json");
        try { if (E.existsSync(guess)) return; } catch (err) { return; }
        stale.push(sid);
      });
      for (var j = 0; j < stale.length; j++) {
        hs.sessions.delete(stale[j]);
        try { hs.emit("event", {type:"deleted", sessionId: stale[j]}); } catch (err) {}
      }
    }

    function scheduleScan(){
      if (debounceTimer) return;
      debounceTimer = setTimeout(function(){
        debounceTimer = null;
        try { scanOnce(); } catch (err) {
          try { o.logger.warn(CMA_LOG_TAG + " scan error " + (err && err.message)); } catch (e) {}
        }
      }, CMA_DEBOUNCE_MS);
    }

    function installWatcher(){
      var dir = hs.getStorageDir && hs.getStorageDir();
      if (!dir) return;
      var real;
      try { real = E.realpathSync(dir); } catch (err) { real = dir; }
      if (real === lastWatchedDir && watcher) return;
      if (watcher) { try { watcher.close(); } catch (e) {} watcher = null; }
      try {
        watcher = E.watch(real, {recursive:true}, function(evt, filename){
          if (!filename) return;
          var name = String(filename);
          if (name.slice(-5) !== ".json") return;
          var basename = name.split("/").pop();
          if (basename.indexOf(o.LOCAL_SESSION_PREFIX) !== 0) return;
          scheduleScan();
        });
        watcher.on("error", function(err){
          try { o.logger.warn(CMA_LOG_TAG + " fs.watch error " + (err && err.message)); } catch (e) {}
        });
        lastWatchedDir = real;
        try { o.logger.info(CMA_LOG_TAG + " watching " + real); } catch (e) {}
      } catch (err) {
        try { o.logger.warn(CMA_LOG_TAG + " install failed " + (err && err.message)); } catch (e) {}
      }
    }

    var bootInterval = setInterval(function(){
      var dir = hs.getStorageDir && hs.getStorageDir();
      if (dir) installWatcher();
    }, 2000);
    if (bootInterval && typeof bootInterval.unref === "function") bootInterval.unref();

    try {
      hs.on("event", function(ev){
        if (ev && ev.type === "initialized") installWatcher();
      });
    } catch (err) {}

    // First-shot install: getStorageDir() returns null pre-account, so the
    // real install fires from either the initialized listener or the boot
    // poll — this call is best-effort and no-ops when the dir isn't ready.
    installWatcher();
  } catch (err) {
    try { console.error("[claude-multiacct-propagation] init failed:", err); } catch (e) {}
  }
})();
