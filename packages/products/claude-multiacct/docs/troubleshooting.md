# Troubleshooting

## Picker doesn't appear next to `Opus 4.7`

1. Confirm the extension loaded: renderer stderr in `~/Library/Logs/Claude/*.log` should contain `[profile] React DevTools loaded via installer: claude-multiacct code-tab picker` and `[cma-content] executed at https://claude.ai/…`.
2. Confirm the bridge daemon is running: `launchctl list | grep com.claude-multiacct.bridge-daemon`.
3. Confirm the daemon has accounts: `cat ~/.config/claude-multiacct/bridge.json` gets you `{port, secret, …}`; `curl -H "x-cma-bridge-secret: $SECRET" -H "Origin: https://claude.ai" http://127.0.0.1:$PORT/accounts` should return a non-empty accounts array.

If accounts is empty but you have Claude Desktop signed in, discovery didn't find them. Check `~/.claude-multiacct/logs/daemon.err.log` for `[discovery]` lines.

## `cma install` prompts about legacy artifacts

Expected on any machine that ran the older bash-based multi-clone tool. Type `y` to remove them (or run with `CMA_YES=1` to skip the prompt). Removal is best-effort; per-artifact failures are logged and the install continues.

## `TypeError: Failed to fetch` in the extension

Means the daemon isn't reachable. Two common causes:

1. Chrome Private Network Access (PNA) preflight — the daemon must respond with `Access-Control-Allow-Private-Network: true`. Fixed in the current build; if you're on an older shim, rebuild.
2. Daemon not running — `launchctl kickstart -k gui/$(id -u)/com.claude-multiacct.bridge-daemon`.

## Account switch clicks in the picker but nothing happens

Check `~/.claude-multiacct/sessions/<uuid>.pid` exists for the current session. If missing, the shim isn't writing it — likely a Claude Desktop version mismatch that skipped the shim wrapper. Re-run `cma install`.

## Uninstall gets rid of new state but leaves legacy artifacts

`cma uninstall` only removes what `cma install` created. To remove legacy artifacts run:

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node dist/cma.js legacy-cleanup --yes
```

## Diagnostics dump

```sh
CLAUDE_MULTIACCT_ENABLE_SHIM=1 node dist/cma.js doctor
```

Runs every subsystem's self-check and prints a machine-readable report.
