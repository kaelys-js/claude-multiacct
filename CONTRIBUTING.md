# Contributing

## Local gates (must pass before pushing)

```sh
mise install
pnpm qa:lint && pnpm qa:format:check && pnpm qa:test
```

## Pull request checklist

- [ ] Local gates green (see above)
- [ ] Commits signed (`git commit -s`)
- [ ] PR title follows conventional commits (`type(scope): summary`)
- [ ] No forbidden vocabulary (`defer`, `follow-up`, `MVP`, `for now`, `future PR`, `out of scope`, `won't fit`)
- [ ] Every approved item shipped in full — no scope narrowed silently

See [AGENTS.md](AGENTS.md) for the full 13 rules.
