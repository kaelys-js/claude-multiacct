# Mid-session hot-swap

Switching accounts in the picker mid-session works. The mechanism:

1. On shim spawn, the shim writes its PID to `~/.claude-multiacct/sessions/<sessionUuid>.pid` (mode 0600).
2. When the user clicks a different account in the picker, the extension `POST /choice/:sessionUuid` to the daemon.
3. Daemon persists the choice AND `process.kill(pid, "SIGHUP")` to the owning shim (using `signalSwap()`).
4. Shim traps `SIGHUP`, kills the child `claude` (SIGTERM, 3-second grace, then SIGKILL), respawns it with a freshly-computed `CLAUDE_CODE_OAUTH_TOKEN` env from the new choice.
5. Child stdio is inherited from the parent, so the user's Code-tab view keeps its console position — only the model's identity changes.

## User experience

- **In-flight prompt** on old account → completes normally; the SIGHUP handler waits for the current child to exit (or up to 3 seconds) before respawning.
- **Next prompt** after the switch → runs against the new account.
- **No session restart** — the same `sessionUuid` continues; Claude Desktop's window doesn't need to close.

## Diagnostics

```sh
tail -f ~/.claude-multiacct/logs/daemon.out.log | grep '\[bridge\]'
```

Look for lines like:

```text
[bridge] POST /choice/f47ac10b… origin=https://claude.ai → 200
```

Followed within milliseconds by an outcome log from the shim:

```text
[cma-shim] SIGHUP swap: killed pid=6789, respawning with new token
```

## Failure modes

- **PID file missing** (shim exited between the choice and the signal) → `signalSwap()` returns `no-owner`; the choice persists but nothing switches until the next `claude` spawn.
- **PID stale** (shim crashed) → `signalSwap()` returns `stale` and deletes the file; picker will show as switched but the next spawn is what actually applies it.
- **Child ignores SIGTERM** → 3-second timeout, then SIGKILL. Any prompt in flight is aborted with exit-code 137.
