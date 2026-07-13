# AGENTS.md -- engineering rules + orientation

_Part of the [claude-multiacct](README.md) docs._

> **What this file is.** The engineering rules every AI agent follows when doing CODE work in this repo (refactors, feature work, docs, code review). It's deliberately short -- read these first. The rules apply to interactive Claude Code sessions and to any workflow sub-agents spawned from this repo.

## Orientation

**claude-multiacct** installs and maintains any number of Claude Desktop instances under different Anthropic accounts on the same Mac, without the OAuth token / keychain / userData collisions that clicking through Claude's own login UI would cause. It also arranges cross-instance session sharing: the JSONL conversation log, the desktop UI's session metadata, and the agent-mode subagent metadata all resolve to the primary instance's on-disk store via symlinks; the Chromium IndexedDB / Local Storage / Session Storage are rsynced primary→mirrors on primary-close via a `launchd` `WatchPaths` agent.

- **Layout**: `bin/` is the CLI + the sync worker; `lib/` is per-instance install helpers; `launchd/` is the WatchPaths plist template; `config/` holds the sample instance config; `docs/` explains architecture + sync model + Dock-icon repair; `tests/` is a hermetic bats smoke suite that installs+uninstalls under a scratch `$HOME`.
- **Toolchain (self-contained)**: pinned in this repo's own `mise.toml` and installs into repo-scoped `.mise/installs`. Clone + `mise install` gets shellcheck + bats + gitleaks with no machine-global dependency.
- **Lint / test**: `bin/qa lint` runs shellcheck + gitleaks. `bin/qa test` runs `bats tests/`. Both invoke via `mise exec --`.
- **Config file of record**: `~/.config/claude-multiacct/instances.yaml`. One source of truth for every instance's `configDir` / `userData` / `email` / `label`.
- **Never sync**: `Cookies` (per-account OAuth), `Preferences` (per-instance window state), `Network Persistent State`, `Crashpad`. These are correctly per-instance and syncing them would break auth or corrupt window state.
- **Never symlink**: Chromium `IndexedDB` / `Local Storage` / `Session Storage`. LevelDB opens are exclusive locks -- symlinks between concurrent processes cause data loss.
- **Idempotent install**: every install step (symlinks, codesign, xattr, lsregister, launchd bootstrap) is safe to re-run. `repair` and `doctor` subcommands exist to fix drift without full reinstall.
- **Backups on destructive ops**: every write that touches an existing on-disk file first snapshots the original into `~/.claude-multiacct-backups/<timestamp>/`.
- **Git hooks / secrets**: `.gitleaks.toml` at the root. Default branch `main`, provider GitHub.

## 13 rules

These apply to every code task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work. Use judgment on trivial tasks.

### Rule 1 -- Think before coding

State assumptions explicitly. If uncertain, ask rather than guess.
Present multiple interpretations when ambiguity exists.
Push back when a simpler approach exists.
Stop when confused. Name what's unclear.

### Rule 2 -- Simplicity first

Minimum code that solves the problem. Nothing speculative.
No features beyond what was asked. No abstractions for single-use code.
Test: would a senior engineer say this is overcomplicated? If yes, simplify.

### Rule 3 -- Surgical changes

Touch only what you must. Clean up only your own mess.
Don't "improve" adjacent code, comments, or formatting.
Don't refactor what isn't broken. Match existing style.

### Rule 4 -- Goal-driven execution

Define success criteria. Loop until verified.
Don't follow steps. Define success and iterate.
Strong success criteria let you loop independently.

### Rule 5 -- Use the model only for judgment calls

Use me for: classification, drafting, summarization, extraction.
Do NOT use me for: routing, retries, deterministic transforms.
If code can answer, code answers.

### Rule 6 -- Token budgets are not advisory

Inline single-agent work: 4,000 tokens per task, 30,000 per session.
Explicitly-approved multi-agent workflow runs are exempt from these numbers,
never from the duty to surface cost.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

### Rule 7 -- Surface conflicts, don't average them

If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.
Don't blend conflicting patterns.

### Rule 8 -- Read before you write

Before adding code, read exports, immediate callers, shared utilities.
"Looks orthogonal" is dangerous. If unsure why code is structured a way, ask.

### Rule 9 -- Tests verify intent, not just behaviour

Tests must encode WHY behaviour matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

### Rule 10 -- Checkpoint after every significant step

Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.
If you lose track, stop and restate.

### Rule 11 -- Match the codebase's conventions, even if you disagree

Conformance > taste inside the codebase.
If you genuinely think a convention is harmful, surface it. Don't fork silently.

### Rule 12 -- Fail loud

"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

### Rule 13 -- Approved work ships fully

When you hit friction on approved work -- an API mismatch, an unfamiliar config shape, a missing test fixture, anything -- the response is "investigate the docs/source until you find the right shape and implement it fully". NOT "downgrade scope to a follow-up".

Forbidden vocabulary on approved work:
`MVP`, `defer`, `out of scope`, `won't fit`, `future PR`, `future work`, `separate ticket`, `separate PR`, `follow-up`, `simplify to`, `for now`, `punt`, `leave for now`.

If something genuinely can't be done with current resources, explain the constraint with evidence (e.g. "this needs credentials that don't exist in this repo") and ASK for permission before narrowing scope. Don't narrow unilaterally. A deferral is legitimate only when the user has explicitly approved it for that specific piece of work.
