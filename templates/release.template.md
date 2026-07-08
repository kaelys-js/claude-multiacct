<!--
─────────────────────────────────────────────────────────────────────────────
SHIPPED spine tier — append-only release log (release.md)

This is the SHIPPED tier of the spine (memo §11: "release … what shipped …
append-only"). It records what shipped, when, which records it realises, and
which client projects carry it.

  * It lives OUTSIDE the record registry — NOT under records/**. In practice a
    release log sits under releases/ (one append-only file, or one file per
    release), never among the records.
  * It is NOT a record.schema.json record and is NOT run through the STEP-3.1
    record validator. The record validator globs records/**/*.md only; this
    file is deliberately not reached by it.
  * It references specs/tasks by id (the up-chain link), but carries no record
    frontmatter and never appears in records/.

APPEND-ONLY INVARIANT
  Entries are ONLY ever appended to the bottom of the list. An existing entry is
  never edited in place and never deleted — the log is the immutable audit trail
  of what shipped. A correction is a NEW appended entry, not a rewrite of an old
  one.

Each entry carries:
  version   (required)  a version string or monotonic release id, e.g. v0.1.0 /
                        REL-0003. Strictly increasing down the list.
  date      (required)  ISO-8601 date the release shipped (YYYY-MM-DD).
  spec      (optional*) SPEC id(s) this release realises.
  tasks     (optional*) task id(s) (from a tasks.yaml) this release completes.
                        *at least one of spec / tasks must be present.
  changes   (required)  a short human summary of what shipped.
  clients   (required)  list of client projects carrying this release ([] if none yet).
─────────────────────────────────────────────────────────────────────────────
-->

# Release log

<!-- Append new entries to the BOTTOM. Never edit or remove an entry above. -->

## Filled example

- version: v0.1.0
  date: 2026-05-24
  spec:
    - SPEC-0001
  tasks:
    - T-001
    - T-002
  changes: >-
    First cut of the governance registry: record schema, the four record
    templates, and the up-chain parent-type contract landed.
  clients: []

- version: v0.2.0
  date: 2026-06-09
  spec:
    - SPEC-0001
  tasks:
    - T-003
    - T-004
  changes: >-
    Record validator (ajv + gray-matter) and the blocking CI check went live;
    malformed, orphaned, and duplicate records now fail the build.
  clients:
    - providence-living
    - handled-monorepo-poc
