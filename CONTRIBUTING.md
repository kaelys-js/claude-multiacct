# Contributing to foundation-registry

Thanks for your interest. This document covers the local setup, expected
workflow, and quality bar for changes to this repo.

## Prerequisites

- macOS or Linux (Windows-via-WSL untested)
- Node 26.5.0 — pinned via `mise.toml` (auto-installs via `mise install`)
- pnpm 11.12.0
- `git` with SSH signing configured (see [AGENTS.md](AGENTS.md))

## Setup

```sh
git clone https://github.com/kaelys-js/foundation-registry ~/wherever/foundation-registry
cd ~/wherever/foundation-registry
mise install          # pins toolchain from mise.toml
pnpm install --frozen-lockfile
```

## Local gates (must pass before pushing)

```sh
pnpm qa:lint && pnpm qa:format:check && pnpm qa:test
```

CI runs the same gates — locally-green + pushed = CI-green.

## Development workflow

1. Branch from `main`: `git checkout -b type/short-description`
2. Commit with signoff: `git commit -s -m "type(scope): summary"` (conventional commits)
3. Push: `git push -u origin HEAD`
4. Open PR — GitHub picks up `.github/PULL_REQUEST_TEMPLATE.md` automatically
5. Wait for CI + review approval before merge

## Pull request checklist

Every PR must satisfy:

- [ ] Local gates green (see above)
- [ ] Commits signed (`git commit -s` — DCO gate blocks unsigned commits on merge)
- [ ] PR title follows conventional commits (`type(scope): summary`)
- [ ] Every changed line traces to the PR description
- [ ] No forbidden vocabulary — see the Rule 13 list below
- [ ] Every approved item shipped in full — no scope narrowed silently
- [ ] Tests verify INTENT (Rule 9), not just behaviour

## Rule 13 — no forbidden vocabulary

These words are Rule 13 forbidden — enforced in code review and by the
fleet `no-deflect` commit-msg gate in the
[kaelys-js/general](https://github.com/kaelys-js/general) meta-repo
(`.githooks/commit-msg` + `scripts/system/verify-no-deflection.mjs`):

`defer`, `follow-up`, `follow-on`, `MVP`, `for now`, `future PR`, `future work`, `out of scope`, `won't fit`, `separate PR`, `separate ticket`, `simplify to`, `punt`, `leave for now`, `will do next`, `later`, `tracked separately`

If you genuinely can't ship approved work in the current PR, surface the
blocker + ask; do not narrow scope silently.

## Code review

- All PRs need at least 1 approving review (fleet policy via branch protection)
- CODEOWNERS (`* @kaelys-js`) is auto-added as a reviewer
- Stale approvals dismiss on new pushes
- Last-push approval required (an approval must come after the final commit)

## Getting help

- Bug reports: [Issues](https://github.com/kaelys-js/foundation-registry/issues)
- Questions / ideas: [Discussions](https://github.com/kaelys-js/foundation-registry/discussions)
- Security: see [SECURITY.md](SECURITY.md) — do NOT file security bugs as public issues
- Conduct: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Response SLA

Solo maintainer, best-effort. Non-security PRs: ~1-3 business days.
Security reports: 24-48 hours via GitHub's private vulnerability reporting.

## License

Contributions are licensed under the repo's existing LICENSE
(proprietary — see [LICENSE](LICENSE)).

## The 13 rules

Every change follows the 13 rules in [AGENTS.md](AGENTS.md). Rule 3
(surgical), Rule 9 (tests verify intent), Rule 12 (fail loud), and Rule
13 (approved work ships fully) are the most-frequently-invoked in
review. Read AGENTS.md before your first PR.
