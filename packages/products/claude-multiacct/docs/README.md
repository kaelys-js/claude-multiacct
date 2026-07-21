# claude-multiacct

Pool the plan-usage limits of several Anthropic accounts across your
Claude Code sessions on a **single, unmodified** `/Applications/Claude.app`.
Non-primary accounts exist only to give you more usage; every user-facing
identity in Claude Desktop stays exactly what it always was.

## How it works, at a glance

```text
Claude Desktop (unmodified /Applications/Claude.app)
   │
   ├─ Code tab loads a Chrome extension (RDT anchor id)
   │     │
   │     └─ picker + usage widget in the Code tab
   │
   ├─ Code tab spawns  claude  → PR2 shim
   │     │
   │     └─ shim swaps CLAUDE_CODE_OAUTH_TOKEN per session
   │
   └─ Background bridge daemon (PR5a) mediates the shared secret
```

- The extension only injects UI inside the Code tab (shadow DOM). It
  does not touch anything else in the app.
- The CLI shim replaces one binary (`claude` → `claude.real` and a
  ~2 KB shim in its place) inside the CLI copies Claude Desktop lays
  down under `~/Library/Application Support/Claude/claude-code/<version>/`.
- The single `/Applications/Claude.app` bundle is never modified. It
  updates through Claude's normal auto-update path.

## Install

```bash
# 1) Bootstrap config
cma init

# 2) Add each account. `cma account add` prompts interactively for the
#    OAuth token (hidden echo). Pipe via `--stdin` in non-TTY contexts.
cma account add --label personal
cma account add --label work
cma account add --label backup

# 3) Flip the shim on and install every mutating subsystem in one step
cma install

# 4) Launch Claude through the wrapper (verifies the daemon is alive first)
cma launch
```

## Uninstall

```bash
cma uninstall
```

Reverses the four install steps in reverse order (best-effort — a
mid-step failure keeps subsequent steps running), then flips
`config.enabled = false`.

## Health

```bash
cma status    # read-only snapshot of config + registry + Claude.app
cma doctor    # same fields, with a fix suggestion attached to each finding
```

Both commands are always safe to run. `doctor` exits non-zero if any
finding is error-tier.

## Migrating from the old bash tool

If your machine still carries artifacts from the pre-rewrite
bash-based `claude-multiacct` (YAML config, mirror `.app` clones under
`~/Applications`, launchd agents under `com.user.claude-*`, or an
in-place patch to `/Applications/Claude.app`), see
[migration-from-old-bash-tool.md](migration-from-old-bash-tool.md).

## Security

- OAuth tokens are never accepted on `argv` (they would leak to `ps`).
  Every path that reads a token uses the interactive TTY prompt or
  `--stdin`.
- Tokens live in the macOS Keychain, keyed by account UUID. The
  registry file on disk stores only `keychain:<uuid>` references.
- Non-primary Anthropic accounts exist only to widen your usage
  budget. Everything the app surface presents comes from the primary.
