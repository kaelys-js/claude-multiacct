# Security Policy

## Reporting a vulnerability

If you find a security issue in this repo, please report it privately through
GitHub's private vulnerability reporting:

**[Report a vulnerability](https://github.com/kaelys-js/claude-multiacct/security/advisories/new)**

Private reports let us investigate and coordinate a fix before the issue is
public. Please avoid opening a public issue for anything that could be exploited.

## Scope

This tool manipulates macOS on-disk state under `~/.claude`, `~/Applications`,
`~/Library/Application Support/Claude*`, and installs `launchd` agents under
`~/Library/LaunchAgents`. In-scope issues include:

- Local privilege escalation triggered by any CLI subcommand.
- Data-exfiltration paths (e.g. metadata symlinks accidentally exposing another
  user's account state).
- Injection into the shell wrappers we generate (`bin/claude-account-<label>`
  or the per-clone `MacOS/Claude` shell wrapper).
- Malformed input to `install-instance.sh` / `build-clone-app.sh` /
  `metadata-symlinks.sh` producing paths that escape the mirror sandbox.
- Any command that silently disables an existing security control on the
  primary Claude Desktop install (e.g. weakens Gatekeeper, breaks
  quarantine, removes codesign on `/Applications/Claude.app`).

Known limitations:

- The upstream Claude Desktop app's behavior — please report those to Anthropic.
- Bugs affecting only your own local install with no security impact.

## Supported versions

The `main` branch is the only supported version. If you're running an older
tag or commit, please update before reporting.
