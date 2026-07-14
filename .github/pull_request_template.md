<!-- Small PR? Ignore the sections that don't fit — but LEAVE the test plan. -->

## What + Why

<!-- One or two sentences on what this changes and why. Link an issue if there
is one. -->

## Test plan

<!-- What did you verify? Which of these did you run? -->
- [ ] `bin/claude-multiacct qa lint` — shellcheck / gitleaks / yamllint green
- [ ] `bin/claude-multiacct qa test` — bats green
- [ ] Live-verified end-to-end on a real Mac (describe below)

## Live verification

<!-- If this changes runtime behaviour, describe what you actually clicked /
ran to prove the change works. Include the `claude-multiacct doctor` output
before + after if a mirror is involved. -->

## Anything a reviewer should know

<!-- Sharp edges, follow-ups you deliberately deferred to a separate PR (if
any), incompatibilities with existing installs, etc. -->
