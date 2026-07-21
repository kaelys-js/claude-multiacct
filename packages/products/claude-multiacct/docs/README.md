# claude-multiacct docs

Product documentation for `packages/products/claude-multiacct`. Structured per Diátaxis (May 2026 doc-tooling best practice): tutorials, how-to guides, reference, explanation kept in separate files with a small, discoverable root.

- **[architecture.md](architecture.md)** — daemon + shim + extension + registry: what each component does + how they talk (mermaid diagrams).
- **[install-and-uninstall.md](install-and-uninstall.md)** — how-to for `cma install` / `cma uninstall`, including auto-cleanup of the legacy bash-tool.
- **[auto-detect.md](auto-detect.md)** — where the daemon discovers OAuth tokens (Claude.app LevelDB, clone apps, `claude` CLI keychain) and how to opt in / opt out.
- **[hot-swap.md](hot-swap.md)** — mid-session account switching: how the daemon signals the shim, and what a user sees.
- **[upstream-sync.md](upstream-sync.md)** — how the fork stays synced with `kaelys-js/foundation-registry` (workflow + local escape hatch).
- **[troubleshooting.md](troubleshooting.md)** — common failure modes + diagnostics.

The top-level [`README.md`](../../../README.md) at the repo root is the product's public front page — quick-start, features, security disclosure. This docs/ dir is for depth.
