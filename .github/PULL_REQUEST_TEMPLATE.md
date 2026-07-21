## Summary

<!-- 1-3 sentences on what changed and why -->

## Test plan

- [ ] `bin/claude-multiacct qa lint` — shellcheck / gitleaks / yamllint green
- [ ] `bin/claude-multiacct qa test` — bats green
- [ ] Live-verified end-to-end on a real Mac (describe below)

## Live verification

<!-- If this changes runtime behaviour, describe what you actually clicked /
ran to prove the change works. Include the `claude-multiacct doctor` output
before + after if a mirror is involved. -->

## Anything a reviewer should know

<!-- Sharp edges, known limitations, incompatibilities with existing installs, etc. -->

## Rule 13 checklist

- [ ] No forbidden vocabulary (`defer`, `follow-up`, `MVP`, `for now`, `future PR`, `out of scope`, `won't fit`, etc.)
- [ ] Every approved item shipped in full — no scope narrowed silently
- [ ] Local gates green (`bin/claude-multiacct qa lint` + `qa test`)
