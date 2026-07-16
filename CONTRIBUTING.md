# Contributing to claude-multiacct

Thanks for considering a contribution. This project is a bash + launchd
+ Electron toolkit for running multiple Claude Desktop instances on the
same Mac.

## Engineering rules

Every code change follows the 13 rules in [AGENTS.md](AGENTS.md). Rule 13
is the load-bearing one: approved work ships fully, no scope narrowed
silently.

## Pull request flow

- Open a PR against `main`. Fill out the template (Summary / Test plan /
  Live verification / Rule 13 checkboxes).
- Live-verify on a real Mac. Runtime behaviour changes need a description
  of what you actually clicked / ran, plus the `claude-multiacct doctor`
  output before + after when a mirror is involved.
- CI runs `qa lint + qa test` on every PR. The gate is required for
  merge; fix in-branch rather than opening follow-on PRs.

## Local gates before you push

```sh
bin/claude-multiacct qa lint    # shellcheck / gitleaks / yamllint
bin/claude-multiacct qa test    # bats
```

## Reporting security issues

Do NOT open a public issue for anything security-adjacent — see
[SECURITY.md](SECURITY.md) for the private-vulnerability-reporting path.
