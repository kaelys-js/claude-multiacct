# Cross-Mac setup

Running the same `claude-multiacct` instances on more than one Mac.

## How this works

`claude-multiacct` is a **local** tool: it installs mirror `.app` bundles and
`configDir` / `userData` paths on ONE Mac. It does not replicate that state
across your fleet — Anthropic's cloud does that job.

The moving parts:

- **Anthropic's cloud already syncs each account's sessions across every device
  the account is signed into.** When you sign into `claude-multiacct`'s `b`
  mirror on Mac A and later sign into the same account on Mac B's `b` mirror,
  the sessions you started on A appear on B (with normal cloud-sync latency).
- **On each Mac, `claude-multiacct`'s local symlinks make ALL mirror accounts
  visible inside the PRIMARY Claude Desktop.** That layer is per-Mac — every
  Mac runs its own symlink installer against its own local `~/.claude/…`.

So the workflow across two Macs is: run the same `add-instance` commands on
each Mac, sign into each mirror with the same OAuth account, and Anthropic's
cloud does the rest. Local state (launchd agents, `.app` clones, symlinks)
lives on each Mac and is not shared.

## Setup on the second Mac

Do the [Quick start](../README.md#quick-start) on Mac B end-to-end. Two things
to align it with Mac A:

1. **Match the labels.** If Mac A has `add-instance b` and `add-instance work`,
   run the identical `add-instance` commands on Mac B. Labels are how the CLI
   identifies mirrors; different labels on the two Macs would give you two
   independent mirror sets rather than one shared set.

2. **Sign into each mirror with the same OAuth account as Mac A.** Launch the
   mirror's `.app` (`open ~/Applications/Claude\ Account\ B.app`) and complete
   the sign-in flow. Anthropic's cloud sync then propagates the sessions Mac A
   already has under this account.

Wait for cloud sync to catch up. Typical latency is minutes; larger session
histories can take longer on the first sync.

## Verify — diff the two Macs' `doctor` reports

`claude-multiacct doctor --json` emits a structured JSON report suitable for
diffing. Run it on both Macs and compare:

```sh
# Mac A
claude-multiacct doctor --json > mac-a.json

# Mac B
claude-multiacct doctor --json > mac-b.json

# Then, on either Mac (assuming both files are copied to it):
diff <(jq -S . mac-a.json) <(jq -S . mac-b.json)
```

What the JSON contains and what each field means for the diff:

| Field | Should match | Why |
|---|---|---|
| `repo` | NO (per-Mac path) | Each Mac's clone lives at a different path. |
| `config` | NO (per-Mac path) | Same — `$HOME` differs. |
| `logs`, `backups` | NO (per-Mac path) | Same. |
| `launchd_agents` | YES — all three `loaded` | The three agents (`sessions-sync`, `clone-refresh`, `metadata-symlink`) MUST be `loaded` on any Mac running mirrors. If one shows `not-loaded`, run `claude-multiacct repair` on that Mac. |
| `instances[].label` | YES | Same label set on both Macs proves the same mirror inventory. |
| `instances[].email` | YES | Same email per label proves each mirror is signed into the same account. |
| `instances[].configDir` / `.userData` | NO (per-Mac path) | Absolute paths under `$HOME`. |
| `instances[].health` | YES — `ok` on both | Any `degraded` reveals a per-Mac issue in the `issues` array below. |
| `instances[].issues` | YES — empty `[]` on both | Non-empty `issues` names the exact fix (`shared-symlinks-missing`, `metadata-symlink-missing`, `bundle-id-drift`, `codesign-broken`, `ls-not-registered`, `never-launched`, etc.). |

A cleanly-set-up fleet has `launchd_agents` all `loaded` on every Mac, the same
labels and emails everywhere, and empty `issues` arrays.

## Troubleshooting

- **Sessions from Mac A don't appear on Mac B yet.**
  Cloud sync latency. Wait a few minutes; on very large session histories the
  first sync after sign-in can take longer. Launch and re-launch the mirror
  after a few minutes — Claude Desktop's sidebar re-reads on start.

- **Account UUIDs differ between the two Macs' `doctor` output** (the human
  form of `doctor`, not `--json`).
  Usually a sign-in mismatch: one Mac signed into a different OAuth account
  under this label. Sign out on the offending Mac, sign back in with the
  correct account, wait for the metadata-symlink agent to re-install symlinks.

- **`launchd_agents` shows `not-loaded` for one or more agents on Mac B.**
  Run `claude-multiacct repair` on Mac B — it re-renders the launchd plists
  and reloads the agents. If one agent still won't load, `launchctl print
  gui/$(id -u)/com.user.claude-<name>` shows the reason (usually a permission
  or WatchPaths issue).

- **`instances[].health = degraded` on one Mac but not the other.**
  The `issues` array names the exact fix; typical entries:
  - `shared-symlinks-missing` → `claude-multiacct repair <label>`
  - `metadata-symlink-missing` → open the mirror, sign in fully, wait for the
    metadata-symlink agent; or `claude-multiacct repair <label>` as a fallback
  - `bundle-id-drift` → `claude-multiacct refresh-clones` (rebuild all mirrors
    from the current `/Applications/Claude.app`)
  - `codesign-broken` → `claude-multiacct refresh-clones`
  - `never-launched` → launch the mirror once and sign in
