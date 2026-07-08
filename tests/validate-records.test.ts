// Adversarial test suite for the registry record validator (STEP-3.1).
//
// Node's built-in runner (`node --test`), erasable TS syntax only. Each test
// builds a throwaway fixture registry in os.tmpdir(), runs the PURE core
// `validateRecords(root)`, asserts the exact rule code(s), and cleans up.
//
// Rule 9 — every test states WHY the behaviour matters, not just what fires:
// the registry's whole value is that a malformed / orphaned / wrong-parent /
// broken-supersession decision cannot merge. A test that only checked "some
// error appeared" would pass even if the validator conflated two invariants.
// So every negative fixture ALSO ships a sibling VALID record that must stay
// clean — proving the check discriminates the bad record, not the whole run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRecords } from "../scripts/validate-records.ts";
import type { RecordError } from "../scripts/validate-records.ts";

// --- fixture helpers --------------------------------------------------------

interface Frontmatter {
  id?: string;
  type?: string;
  title?: string;
  status?: string;
  owner?: string;
  date?: string;
  references?: string[];
  supersedes?: string | null;
  supersededBy?: string | null;
}

// A quoted, schema-valid baseline for each field. Individual fixtures override.
// Default owner is the governance lead (@lead-foundation) because unless a
// fixture says otherwise its records sit under records/governance/ — so the
// default owner must equal that domain's lead or every governance fixture would
// trip OWNER_DOMAIN_MISMATCH. Records placed in other domain dirs (build/,
// backend/, …) override `owner` to that domain's lead.
function fm(over: Frontmatter): Frontmatter {
  return {
    title: "A sufficiently long record title",
    status: "accepted",
    owner: LEAD_OF["governance"],
    date: "'2026-05-18'",
    ...over,
  };
}

// Serialise frontmatter to YAML by hand (so a test can inject deliberately
// malformed values like an UNquoted date without gray-matter re-quoting it).
function toYaml(f: Frontmatter): string {
  const lines: string[] = ["---"];
  const put = (k: string, v: string) => lines.push(`${k}: ${v}`);
  if (f.id !== undefined) put("id", f.id);
  if (f.type !== undefined) put("type", f.type);
  if (f.title !== undefined) put("title", f.title);
  if (f.status !== undefined) put("status", f.status);
  if (f.owner !== undefined) put("owner", `'${f.owner}'`);
  if (f.date !== undefined) put("date", f.date); // caller controls quoting
  if (f.references !== undefined) {
    if (f.references.length === 0) put("references", "[]");
    else lines.push("references:", ...f.references.map((r) => `  - ${r}`));
  }
  if ("supersedes" in f) put("supersedes", f.supersedes === null ? "null" : String(f.supersedes));
  if ("supersededBy" in f) put("supersededBy", f.supersededBy === null ? "null" : String(f.supersededBy));
  lines.push("---", "", "# Record body", "");
  return lines.join("\n");
}

interface FileSpec {
  // path relative to <root>, e.g. "governance/prd-0001-why.md"
  rel: string;
  frontmatter: Frontmatter;
  // when set, write this literal content instead of serialising frontmatter
  raw?: string;
}

// The nine governed domains and their leads (mirrors owners.yaml
// `branches[].key` / `branches[].lead`). Domain is structural now — a record
// lives under records/<domain>/ — so every fixture needs an owners.yaml the
// validator reads for BOTH the sanctioned domain set (DOMAIN_UNKNOWN) and each
// domain's lead (OWNER_DOMAIN_MISMATCH). A record's owner must equal its
// domain's lead or it trips OWNER_DOMAIN_MISMATCH, so fixtures set owner from
// this map.
const LEAD_OF: Record<string, string> = {
  governance: "@lead-foundation",
  build: "@lead-build",
  design: "@lead-design",
  frontend: "@lead-frontend",
  backend: "@lead-backend",
  infra: "@lead-infra",
  security: "@lead-security",
  data: "@lead-data",
  observability: "@lead-observability",
};
const DOMAIN_KEYS = Object.keys(LEAD_OF);

function ownersYaml(keys: string[]): string {
  return (
    ["branches:", ...keys.map((k) => `  - key: ${k}\n    team: "@ttt/${k}"\n    lead: "${LEAD_OF[k]}"`)].join("\n") + "\n"
  );
}

// Build a temp registry, run the validator, return errors + a cleanup fn. Writes
// an owners.yaml at the base (one level above records/, where the validator
// resolves it via <root>/../owners.yaml). `keys` overridable so a test can prove
// the domain set is sourced from owners.yaml, not hardcoded.
async function runFixture(files: FileSpec[], keys: string[] = DOMAIN_KEYS): Promise<{ errors: RecordError[]; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "reg-"));
  const root = join(base, "records");
  await mkdir(root, { recursive: true });
  await writeFile(join(base, "owners.yaml"), ownersYaml(keys), "utf8");
  for (const f of files) {
    const full = join(root, f.rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, f.raw ?? toYaml(f.frontmatter), "utf8");
  }
  const errors = await validateRecords(root);
  return { errors, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function rules(errors: RecordError[], forPathContains?: string): string[] {
  return errors
    .filter((e) => forPathContains === undefined || e.path.includes(forPathContains))
    .map((e) => e.rule);
}

// A rooted, valid PRD any negative fixture can hang siblings off of.
const validPrd: FileSpec = {
  rel: "governance/prd-0001-why-the-foundation-exists.md",
  frontmatter: fm({ id: "PRD-0001", type: "PRD", references: [], supersedes: null }),
};

// A second independent valid record (an ADR citing the PRD) used as the
// "must stay clean" sibling in negative fixtures.
const validAdr: FileSpec = {
  rel: "build/adr-0009-a-clean-sibling.md",
  frontmatter: fm({ id: "ADR-0009", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }),
};

// --- baseline ---------------------------------------------------------------

test("baseline valid registry produces ZERO errors (the spine is legal end-to-end)", async () => {
  // WHY: if a correct PRD→(PDR,ADR)→SPEC chain with quoted dates and correct
  // filenames does not pass, the validator is useless — it would block every
  // real record. This is the discriminator for every negative test below.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/pdr-0001-static-index.md", frontmatter: fm({ id: "PDR-0001", type: "PDR", references: ["PRD-0001"], supersedes: null }) },
    validAdr,
    { rel: "governance/spec-0001-capabilities.md", frontmatter: fm({ id: "SPEC-0001", type: "SPEC", references: ["ADR-0009", "PDR-0001"], supersedes: null }) },
  ]);
  await cleanup();
  assert.deepEqual(errors, [], `expected clean baseline, got: ${JSON.stringify(errors, null, 2)}`);
});

// --- one negative fixture per rule code -------------------------------------

test("SCHEMA_INVALID fires on a bad enum (status not in the lifecycle set)", async () => {
  // WHY: shape is the first gate. A status outside {proposed,accepted,...} means
  // the record's lifecycle is undefined — CI must reject it.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-orchestrator.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", status: "in-force", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001").includes("SCHEMA_INVALID"), "bad status must be SCHEMA_INVALID");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("SCHEMA_INVALID fires on an UNQUOTED date coerced to a JS Date (enforces the quoted-date convention)", async () => {
  // WHY (STEP-2.5 decision): gray-matter turns an unquoted ISO date into a JS
  // Date. We deliberately do NOT coerce it back — a Date must FAIL `/date must
  // be string` so authors are forced to quote dates (templates ship quoted).
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-orchestrator.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", date: "2026-05-18", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const adrRules = rules(errors, "adr-0001");
  assert.ok(adrRules.includes("SCHEMA_INVALID"), "unquoted date must trip SCHEMA_INVALID (not silently coerced)");
  assert.ok(
    errors.some((e) => e.path.includes("adr-0001") && e.message.includes("must be string")),
    "the schema error must be the string-type failure on /date",
  );
  assert.ok(
    errors.some((e) => e.path.includes("adr-0001") && e.message.includes("quote it")),
    "a clearer companion diagnostic should point at quoting the date",
  );
  assert.deepEqual(rules(errors, "prd-0001"), [], "a quoted-date PRD (as templates ship) must stay clean");
});

test("ID_DUPLICATE fires against BOTH files that declare the same id", async () => {
  // WHY: ids are the graph's primary key. Two records claiming ADR-0001 make
  // every reference to it ambiguous; the fix must name both offending paths.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-one.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
    { rel: "backend/adr-0001-two.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-backend", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const dup = errors.filter((e) => e.rule === "ID_DUPLICATE");
  assert.equal(dup.length, 2, "ID_DUPLICATE must be emitted against both paths");
  assert.ok(dup.some((e) => e.path.includes("adr-0001-one")) && dup.some((e) => e.path.includes("adr-0001-two")), "both duplicate paths must be named");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("ID_PATTERN fires on a malformed id (subsumed by SCHEMA_INVALID; see report)", async () => {
  // WHY: an id that does not match ^(PRD|PDR|ADR|SPEC)-\d{4}$ cannot be a stable
  // key. The schema pattern also rejects it, so SCHEMA_INVALID co-fires — this
  // test pins the dedicated ID_PATTERN code so the CI annotator stays precise.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-x-bad.md", frontmatter: fm({ id: "ADR-XX", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const badRules = rules(errors, "adr-x-bad");
  assert.ok(badRules.includes("ID_PATTERN"), "malformed id must trip ID_PATTERN");
  assert.ok(badRules.includes("SCHEMA_INVALID"), "and SCHEMA_INVALID (the schema pattern is identical) — documented as subsumed");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("REF_UNRESOLVED fires when a reference names a record that does not exist", async () => {
  // WHY: a dangling parent is an orphaned decision — the up-chain audit trail
  // is broken. Schema can't know PRD-9999 is absent; only the graph pass can.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-orchestrator.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-9999"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001").includes("REF_UNRESOLVED"), "reference to a non-existent id must be REF_UNRESOLVED");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("REF_SELF fires when a record references its own id (PT-6)", async () => {
  // WHY: a record cannot be its own parent — a self-loop is a nonsensical spine
  // edge and would also poison cycle detection downstream.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/spec-0001-caps.md", frontmatter: fm({ id: "SPEC-0001", type: "SPEC", references: ["SPEC-0001"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "spec-0001").includes("REF_SELF"), "self-reference must be REF_SELF");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("REF_TO_REJECTED fires when a parent's status is rejected (PT-7)", async () => {
  // WHY: a rejected record was never in force, so nothing may hang off it. This
  // is pure graph state the schema cannot see (the parent is shape-valid).
  const { errors, cleanup } = await runFixture([
    { rel: "governance/prd-0002-rejected-case.md", frontmatter: fm({ id: "PRD-0002", type: "PRD", status: "rejected", references: [], supersedes: null }) },
    validAdr, // ADR-0009 cites PRD-0001 (absent here) — but we want a clean sibling; use the real PRD too
    validPrd,
    { rel: "build/adr-0001-orchestrator.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0002"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001").includes("REF_TO_REJECTED"), "referencing a rejected record must be REF_TO_REJECTED");
  assert.deepEqual(rules(errors, "adr-0009-a-clean-sibling"), [], "the valid ADR sibling (cites PRD-0001) must stay clean");
});

test("GOLDEN: PARENT_TYPE fires when an ADR references a SPEC (the spine cannot invert)", async () => {
  // WHY (golden case): the spine runs PRD→ADR→SPEC downward. An ADR citing a
  // SPEC as its parent inverts the audit direction — a decision claiming to be
  // justified by a capability that post-dates it. Must be a hard error.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/spec-0002-some-capability.md", frontmatter: fm({ id: "SPEC-0002", type: "SPEC", references: ["ADR-0009"], supersedes: null }) },
    validAdr,
    { rel: "build/adr-0001-orchestrator.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["SPEC-0002"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001").includes("PARENT_TYPE"), "ADR→SPEC must be PARENT_TYPE (spine can't invert)");
  assert.deepEqual(rules(errors, "adr-0009-a-clean-sibling"), [], "the valid ADR sibling must stay clean");
});

test("GOLDEN: PARENT_COUNT fires when a SPEC cites only a PDR and no ADR (mustContain ADR)", async () => {
  // WHY (golden case): a capability spec must anchor to at least one accepted
  // ARCHITECTURE decision. A SPEC citing only a PDR is not grounded in an ADR —
  // the mustContain:["ADR"] rule turns that into PARENT_COUNT.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/pdr-0001-index.md", frontmatter: fm({ id: "PDR-0001", type: "PDR", references: ["PRD-0001"], supersedes: null }) },
    validAdr,
    { rel: "governance/spec-0001-caps.md", frontmatter: fm({ id: "SPEC-0001", type: "SPEC", references: ["PDR-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const specRules = rules(errors, "spec-0001");
  assert.ok(specRules.includes("PARENT_COUNT"), "SPEC with no ADR parent must be PARENT_COUNT (mustContain ADR)");
  assert.deepEqual(rules(errors, "adr-0009-a-clean-sibling"), [], "the valid ADR sibling must stay clean");
});

test("PARENT_COUNT fires when a PDR cites zero parents (needs exactly one PRD)", async () => {
  // WHY: a product decision realises exactly one business case. Zero parents
  // means an ungrounded decision; the count bounds [1,1] catch it.
  // NB: an empty PDR references also fails schema (minItems:1) — both fire; the
  // invariant PARENT_COUNT is the authoritative machine code asserted here.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/pdr-0001-index.md", frontmatter: fm({ id: "PDR-0001", type: "PDR", references: [], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "pdr-0001").includes("PARENT_COUNT"), "PDR with zero parents must be PARENT_COUNT");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("SUPERSEDE_TYPE fires when a record supersedes a DIFFERENT type", async () => {
  // WHY (SS-1): supersession replaces a record with a newer one of the SAME
  // type. An ADR superseding a PDR is a category error — the successor is not a
  // like-for-like replacement.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "governance/pdr-0001-old.md", frontmatter: fm({ id: "PDR-0001", type: "PDR", status: "superseded", references: ["PRD-0001"], supersededBy: "ADR-0001" }) },
    validAdr,
    { rel: "build/adr-0001-new.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: "PDR-0001" }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001-new").includes("SUPERSEDE_TYPE"), "cross-type supersession must be SUPERSEDE_TYPE");
  assert.deepEqual(rules(errors, "adr-0009-a-clean-sibling"), [], "the valid ADR sibling must stay clean");
});

test("SUPERSEDE_STATUS fires when the superseded target is not marked superseded (SS-2a)", async () => {
  // WHY: the target of a live supersedes MUST carry status 'superseded'. If the
  // old record still reads 'accepted', two records claim to be in force.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-old.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", status: "accepted", references: ["PRD-0001"], supersededBy: null }) },
    { rel: "build/adr-0002-new.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: "ADR-0001" }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0002-new").includes("SUPERSEDE_STATUS"), "target not marked superseded must be SUPERSEDE_STATUS");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("GOLDEN: SUPERSEDE_BACKLINK fires when a superseded record lacks the supersededBy backlink (SS-2b)", async () => {
  // WHY (golden case): supersession is BIDIRECTIONAL. If ADR-0002 supersedes
  // ADR-0001 but ADR-0001.supersededBy does not point back to ADR-0002, the
  // link is half-formed and readers can't find the successor.
  // The old record IS status:superseded (so SS-2a is satisfied) but its
  // supersededBy points at the wrong id — isolating the backlink failure.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-old.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", status: "superseded", references: ["PRD-0001"], supersededBy: "ADR-0007" }) },
    { rel: "build/adr-0002-new.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: "ADR-0001" }) },
  ]);
  await cleanup();
  const newRules = rules(errors, "adr-0002-new");
  assert.ok(newRules.includes("SUPERSEDE_BACKLINK"), "broken backlink must be SUPERSEDE_BACKLINK");
  assert.ok(!newRules.includes("SUPERSEDE_STATUS"), "SS-2a is satisfied here, so only the backlink should fail");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("SUPERSEDE_FORK fires when two live records supersede the same target (SS-3)", async () => {
  // WHY: at most one successor may claim a superseded record. Two forks mean an
  // ambiguous lineage — which record is 'the' replacement?
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-old.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", status: "superseded", references: ["PRD-0001"], supersededBy: "ADR-0002" }) },
    { rel: "build/adr-0002-new.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: "ADR-0001" }) },
    { rel: "build/adr-0003-fork.md", frontmatter: fm({ id: "ADR-0003", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: "ADR-0001" }) },
  ]);
  await cleanup();
  const forkErrs = errors.filter((e) => e.rule === "SUPERSEDE_FORK");
  assert.ok(forkErrs.length >= 2, "both forking superseders must be flagged SUPERSEDE_FORK");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("SUPERSEDE_CYCLE fires when supersedes forms a cycle (SS-4)", async () => {
  // WHY: a supersession chain is a history, not a loop. A→B→A means neither is
  // 'current' — an infinite regress the walker must catch.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-a.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", status: "superseded", references: ["PRD-0001"], supersededBy: "ADR-0002", supersedes: "ADR-0002" }) },
    { rel: "build/adr-0002-b.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-build", status: "superseded", references: ["PRD-0001"], supersededBy: "ADR-0001", supersedes: "ADR-0001" }) },
  ]);
  await cleanup();
  assert.ok(errors.some((e) => e.rule === "SUPERSEDE_CYCLE"), "a supersedes cycle must be SUPERSEDE_CYCLE");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("FRONTMATTER_MISSING fires on a file with no frontmatter mapping", async () => {
  // WHY: a .md under records/ with no frontmatter is not a record — treat it as
  // missing frontmatter (a reportable error), never crash the scan.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-empty.md", frontmatter: {}, raw: "# Just a heading, no frontmatter at all\n" },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001-empty").includes("FRONTMATTER_MISSING"), "no-frontmatter file must be FRONTMATTER_MISSING");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("FILENAME_MISMATCH fires when the basename does not encode the id", async () => {
  // WHY: the index and humans rely on id ⇄ path lockstep. A record whose file
  // is named wrongly (id ADR-0001 in wrong-name.md) breaks that contract.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/wrong-name-here.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  assert.ok(rules(errors, "wrong-name-here").includes("FILENAME_MISMATCH"), "mismatched basename must be FILENAME_MISMATCH");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("FILENAME_MISMATCH fires when the slug is not lowercase-kebab (uppercase + space + punctuation)", async () => {
  // WHY: the filename slug must be lowercase-kebab so id⇄path is unambiguous and
  // the slug is URL/anchor-safe for the static index. A name like
  // 'adr-0001-Bad Slug!.md' has the right id prefix but an illegal slug — it must
  // still fail FILENAME_MISMATCH, with a message that names the slug problem.
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-Bad Slug!.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
    { rel: "build/adr-0002-clean-slug.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const badErrs = errors.filter((e) => e.path.includes("Bad Slug") && e.rule === "FILENAME_MISMATCH");
  assert.equal(badErrs.length, 1, "a malformed slug must be FILENAME_MISMATCH");
  assert.ok(badErrs[0].message.includes("slug"), "the message must distinguish the slug-format failure");
  assert.deepEqual(rules(errors, "adr-0002-clean-slug"), [], "the clean-slug sibling must pass");
});

test("OWNER_DOMAIN_MISMATCH fires when a record's owner is not its domain's lead", async () => {
  // WHY: ownership must match placement — a record under records/backend/ is
  // owned by the backend lead. A backend record owned by @lead-design has an
  // accountable author who does not own that branch; CODEOWNERS routing and the
  // record's stated owner would disagree. A sibling backend record owned by the
  // real backend lead must stay clean (discriminator).
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "backend/adr-0001-wrong-owner.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-design", references: ["PRD-0001"], supersedes: null }) },
    { rel: "backend/adr-0002-right-owner.md", frontmatter: fm({ id: "ADR-0002", type: "ADR", owner: "@lead-backend", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const mismatch = rules(errors, "adr-0001-wrong-owner");
  assert.ok(mismatch.includes("OWNER_DOMAIN_MISMATCH"), "owner != domain lead must be OWNER_DOMAIN_MISMATCH");
  assert.deepEqual(rules(errors, "adr-0002-right-owner"), [], "the record owned by the real backend lead must stay clean");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the governance PRD (owner = governance lead) must stay clean");
});

test("DOMAIN_UNKNOWN fires when a record sits under a non-governed domain directory", async () => {
  // WHY: domain is now STRUCTURAL — a record's owning branch IS its directory
  // (records/<domain>/…), which must be one of the nine owners.yaml branch keys.
  // A record under records/notadomain/ has no accountable owner/CODEOWNERS route,
  // so it must be rejected; a sibling under a valid domain dir must stay clean
  // (proving the check discriminates the directory, not the whole run).
  const { errors, cleanup } = await runFixture([
    validPrd, // records/governance/… — a governed domain
    { rel: "notadomain/adr-0001-orphan-domain.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
  ]);
  await cleanup();
  const badRules = rules(errors, "notadomain");
  assert.ok(badRules.includes("DOMAIN_UNKNOWN"), "record under a non-governed domain must be DOMAIN_UNKNOWN");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the sibling under a valid domain dir must stay clean");
});

test("DOMAIN_UNKNOWN's allowed set is sourced from owners.yaml, not hardcoded", async () => {
  // WHY: the sanctioned domains must track owners.yaml so the manifest and the
  // validator cannot drift. If owners.yaml declares 'governance' but NOT 'build',
  // a build/ record must fail DOMAIN_UNKNOWN even though 'build' is a real key in
  // the production manifest — the validator reads the fixture's manifest.
  const { errors, cleanup } = await runFixture(
    [
      validPrd, // governance — present in the restricted set
      { rel: "build/adr-0001-orch.md", frontmatter: fm({ id: "ADR-0001", type: "ADR", owner: "@lead-build", references: ["PRD-0001"], supersedes: null }) },
    ],
    ["governance"], // owners.yaml here declares ONLY governance
  );
  await cleanup();
  assert.ok(rules(errors, "build/adr-0001").includes("DOMAIN_UNKNOWN"), "a domain absent from THIS owners.yaml must be DOMAIN_UNKNOWN");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the governance record (in the set) must stay clean");
});

test("a record carrying a bare 'domain:' frontmatter key is now SCHEMA_INVALID (domain removed from schema)", async () => {
  // WHY: domain became structural, so the schema property was deleted. With
  // unevaluatedProperties:false, a record that still sets domain: is rejected —
  // this pins that the old optional field can no longer sneak in.
  const withDomain = [
    "---",
    "id: ADR-0001",
    "type: ADR",
    "title: A record that still sets a domain key",
    "status: accepted",
    "owner: '@lead-build'",
    "date: '2026-05-18'",
    "domain: build",
    "references:",
    "  - PRD-0001",
    "supersedes: null",
    "---",
    "",
    "# body",
    "",
  ].join("\n");
  const { errors, cleanup } = await runFixture([
    validPrd,
    { rel: "build/adr-0001-has-domain.md", frontmatter: {}, raw: withDomain },
  ]);
  await cleanup();
  assert.ok(rules(errors, "adr-0001-has-domain").includes("SCHEMA_INVALID"), "a stray domain: key must now be SCHEMA_INVALID");
  assert.deepEqual(rules(errors, "prd-0001"), [], "the valid PRD sibling must stay clean");
});

test("a plain PRD supersession chain (no cycle, correct backlink) is CLEAN", async () => {
  // WHY: proves the supersession checks don't false-positive on a legal
  // A-superseded-by-B pair — the discriminator for all the SUPERSEDE_* tests.
  const { errors, cleanup } = await runFixture([
    { rel: "governance/prd-0001-old.md", frontmatter: fm({ id: "PRD-0001", type: "PRD", status: "superseded", references: [], supersededBy: "PRD-0002" }) },
    { rel: "governance/prd-0002-new.md", frontmatter: fm({ id: "PRD-0002", type: "PRD", references: [], supersedes: "PRD-0001" }) },
  ]);
  await cleanup();
  assert.deepEqual(errors, [], `a legal supersession pair must be clean, got: ${JSON.stringify(errors, null, 2)}`);
});
