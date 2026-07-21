# Auto-detect

On daemon boot (`launchctl load com.claude-multiacct.bridge-daemon`), `discoverAccounts()` scans three source classes for OAuth tokens and auto-registers every unique one:

1. **Main `/Applications/Claude.app`** — reads Local Storage + IndexedDB LevelDB under `~/Library/Application Support/Claude/`. Values with a `v10` prefix are decrypted via Chromium's AES-128-CBC scheme using the `Claude Safe Storage` keychain key (PBKDF2-SHA1, `saltysalt` salt, 1003 iterations). Decrypted JSON with an `access_token` field is treated as an OAuth token.
2. **Clone apps** — `~/Applications/Claude Account *.app`. Each clone has its own `~/Library/Application Support/Claude-<label>/`; the same `Claude Safe Storage` key decrypts them (Electron reuses the parent product's Keychain service).
3. **`claude` CLI keychain slots** — `security dump-keychain` grep `Claude Code-credentials-*`. Each slot's raw value is a JSON OAuth blob — no Chromium wrapping.

## Dedup

Each candidate token is SHA-256'd; matches against already-registered accounts are skipped. Idempotent — re-running the daemon does not create duplicate entries.

## Failure modes

- **Missing `Claude Safe Storage` key** — main Claude.app never launched, or key was deleted. Discovery logs a warning + skips the main + clone scans; continues to CLI slots.
- **Corrupted LevelDB entries** — value bytes-scanned + attempted-decrypt; failures silently skipped (many LevelDB entries aren't `v10`-encrypted).
- **`security` refuses without unlock** — daemon running under launchd may hit interactive-required errors on keychain writes; the layered token store falls back to file-based AES-256-GCM storage.

## Disabling

Discovery is disabled by unsetting `CLAUDE_MULTIACCT_ENABLE_SHIM` (the whole system is flag-gated). To keep discovery off while other subsystems run, set `CMA_SKIP_DISCOVERY=1` before starting the daemon.

## Verifying

```sh
tail -f ~/.claude-multiacct/logs/daemon.err.log | grep '\[discovery\]'
```

Sample output:

```text
[discovery] scanned mainApp=42 cloneApps=0 cliCredentials=1 registered=2 skipped=0 failed=0
```
