# Tolaria compatibility

Any product doc tree under `packages/products/<name>/docs/` in this monorepo can render inside Tolaria via its standard vault reader. This file records the conventions the repo follows so those trees stay compatible with `tttstudios/memex` (the reference vault) and with the [Tolaria](https://github.com/refactoringhq/tolaria) app itself.

## Convention chosen

Folder landing pages are `README.md`. That matches:

- The Tolaria default vault's own layout (single top-level `README.md`).
- `tttstudios/memex`'s top-level `README.md`.
- GitHub's own convention: any `README.md` at a path renders as that path's landing page.

Every subfolder under a product's `docs/` therefore ships a `README.md`. Do not add `index.md` files.

## Frontmatter

Every note carries YAML frontmatter with the shared keys:

- `title` — display title fallback. Tolaria reads the first H1 preferentially; `title:` is inert but kept for compatibility with editors that read it.
- `tags` — a list.
- `generated` — `true` when a CLI writes the file; `false` when a human owns the prose.
- `owner` — one of `<name>` (the product owner handle), `cli`, `cron`.

Products may add product-specific keys (e.g. a phase or day marker) alongside the shared set. `type:` (memex's classifier) is not used here — product-specific axes carve the classification instead.

Memex-bound notes under a product's `docs/memex/entries/` also carry `author` and `author_handle`, matching the seed entries' shape byte-for-byte.

## Wikilinks

Memex uses `[[wikilinks]]` for internal navigation. Products here use standard Markdown links (`[label](./relative/path.md)`) because:

- Docs live inside a monorepo alongside TypeScript source. Markdown links resolve in every editor (VS Code, JetBrains, GitHub, Tolaria).
- Tolaria reads `[[wikilinks]]` and Markdown links, so no compatibility is lost.
- Every internal link is validated by an audit; broken links fail the audit.

## Filename conventions

Kebab-case, all lowercase, `.md` suffix. Matches memex and Tolaria. Applies to every file except folder landings (`README.md`).

## What Tolaria renders

Tolaria supports:

- H1-derived titles, plus `title:` frontmatter as fallback.
- YAML frontmatter properties (including custom keys).
- Markdown links resolved relative to file location.
- `[[wikilinks]]` (unused in the trees here, kept as an option).
- Attachments in an `attachments/` folder (unused here).

Tolaria does NOT render:

- Custom Mermaid diagrams (falls back to code block).
- HTML embedded in Markdown beyond the standard subset.
- Files without a `.md` suffix (except assets in `attachments/`).

## Cross-references

Each product's `docs/README.md` is the entry point for that product. Every subfolder README lists its own contents and links back to the parent with `../README.md`. Products that generate their READMEs (see `packages/products/cole-30-60-90` for the reference implementation) keep the whole tree in one voice by rewriting the READMEs on every refresh.
