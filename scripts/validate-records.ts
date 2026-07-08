// Registry record validator — the STEP-3.1 CI gate (Appendix B.3).
//
// Loads every record under `records/**/*.md`, validates each record's YAML
// frontmatter against `schema/record.schema.json` (draft 2020-12), then asserts
// the cross-record invariants JSON Schema cannot express: id uniqueness,
// reference resolution, the parent-TYPE matrix (PT-1..PT-8), and supersession
// integrity (SS-1..SS-4). Pure, deterministic, no network, no model calls.
//
// Run natively by Node 26 (`node scripts/validate-records.ts`) — erasable TS
// syntax only (no enums/namespaces/param-properties); `tsc --noEmit` type-checks.
//
// RULE-CODE ROSTER (stable machine codes emitted on RecordError.rule):
//   SCHEMA_INVALID, ID_DUPLICATE, ID_PATTERN, REF_UNRESOLVED, REF_SELF,
//   REF_TO_REJECTED, PARENT_TYPE, PARENT_COUNT, SUPERSEDE_TYPE,
//   SUPERSEDE_STATUS, SUPERSEDE_BACKLINK, SUPERSEDE_FORK, SUPERSEDE_CYCLE,
//   FRONTMATTER_MISSING, FILENAME_MISMATCH, DOMAIN_UNKNOWN,
//   OWNER_DOMAIN_MISMATCH.

import { readFile, stat } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, exit, stderr, stdout } from "node:process";
import { parse as parseYaml } from "yaml";
// ajv and ajv-formats are CommonJS packages whose shipped `.d.ts` use ESM
// `export default`. Under nodenext with verbatimModuleSyntax (and no
// esModuleInterop) a bare `import X from "ajv/dist/2020.js"` resolves to the
// module NAMESPACE, not the class, so it is non-constructable at type level —
// the classic 2020-entrypoint interop trap. Ajv2020 also ships as a NAMED
// class export, so we import it by name (clean under both tsc and the Node
// runtime, which is why we MUST use `ajv/dist/2020.js`, not the draft-07
// default `ajv`). ajv-formats exposes only a default plugin, so we take it off
// the namespace and type it via its exported FormatsPlugin interface.
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import * as ajvFormatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import matter from "gray-matter";

// The CJS `.d.ts` types `.default` as the module namespace, not the plugin, so
// cast through unknown to the exported FormatsPlugin. Runtime-verified: this is
// the callable plugin (registers the `date` format in full mode below).
const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

export interface RecordError {
  path: string;
  recordId?: string;
  rule: string;
  message: string;
}

// The in-memory model of one record, built from frontmatter for the graph pass.
interface RecordNode {
  id: string;
  type: string;
  status: string;
  references: string[];
  supersedes: string | null;
  supersededBy: string | null;
  path: string;
  // Structural domain (first path segment beneath root) and the record's owner
  // handle from frontmatter — used by the OWNER_DOMAIN_MISMATCH invariant.
  domain: string | undefined;
  domainGoverned: boolean;
  owner: string | undefined;
}

// An operational fault (unreadable dir, bad glob) — distinct from a record
// error. Surfaced as exit code 2 so CI can tell "records wrong" from "validator
// broke". Uses a marker property instead of `instanceof` so it survives the
// erasable-syntax constraint cleanly.
interface OperationalFault {
  operational: true;
  message: string;
}

function isOperationalFault(e: unknown): e is OperationalFault {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { operational?: unknown }).operational === true
  );
}

// The enforceable projection of the parent_type_matrix (B.2). The JSON Schema
// type-branches are the first line of defence; this table is the authoritative
// second — it is what assertParentTypes reads.
interface ParentRule {
  allowed: string[];
  min: number;
  max: number;
  mustContain?: string[];
}

const PARENT_RULES: Record<string, ParentRule> = {
  PRD: { allowed: [], min: 0, max: 0 },
  PDR: { allowed: ["PRD"], min: 1, max: 1 },
  ADR: { allowed: ["PRD"], min: 1, max: 1 },
  SPEC: { allowed: ["ADR", "PDR"], min: 1, max: Infinity, mustContain: ["ADR"] },
};

const SCHEMA_PATH = "schema/record.schema.json";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// gray-matter coerces an UNQUOTED YAML date to a JS Date. Per the STEP-2.5
// decision we do NOT coerce it back to a string: a Date must fail schema
// (`/date must be string`), which enforces the quoted-date convention. Detect it
// so we can also emit a clearer companion message.
function dateFieldIsJsDate(data: Record<string, unknown>): boolean {
  return Object.prototype.toString.call(data["date"]) === "[object Date]";
}

function schemaErrorToMessage(e: ErrorObject): string {
  const where = e.instancePath || "/";
  let msg = `${where} ${e.message ?? "is invalid"}`;
  // Surface the params that make an enum/const failure actionable.
  if (e.params && typeof e.params === "object") {
    const p = e.params as Record<string, unknown>;
    if (Array.isArray(p["allowedValues"])) {
      msg += ` (allowed: ${(p["allowedValues"] as unknown[]).join(", ")})`;
    } else if ("allowedValue" in p) {
      msg += ` (allowed: ${String(p["allowedValue"])})`;
    } else if ("additionalProperty" in p) {
      msg += ` (unexpected property: ${String(p["additionalProperty"])})`;
    } else if ("missingProperty" in p) {
      msg += ` (missing: ${String(p["missingProperty"])})`;
    }
  }
  return msg;
}

// FILENAME_CHECK (B.3 step 3): basename must be `<id-lowercased>-<slug>.md`,
// e.g. `adr-0001-build-orchestrator.md`. The slug (everything after the
// `<id-lowercased>-` prefix) must be lowercase-kebab so the id⇄path lockstep is
// unambiguous and URL/anchor-safe for the index. Returns a specific failure
// reason so the caller's FILENAME_MISMATCH message distinguishes a wrong
// id-prefix from a malformed slug.
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// undefined = ok; otherwise a human reason for the mismatch.
function filenameMismatchReason(path: string, id: string): string | undefined {
  const base = basename(path);
  if (!base.endsWith(".md")) {
    return `basename '${base}' must be a .md file`;
  }
  const stem = base.slice(0, -".md".length);
  const prefix = `${id.toLowerCase()}-`;
  if (!stem.startsWith(prefix) || stem.length <= prefix.length) {
    return `basename must be '<id-lowercased>-<slug>.md' for ${id} (expected prefix '${prefix}')`;
  }
  const slug = stem.slice(prefix.length);
  if (!SLUG_RE.test(slug)) {
    return `slug '${slug}' must be lowercase-kebab (^[a-z0-9]+(-[a-z0-9]+)*$): no uppercase, spaces, punctuation, or leading/trailing/double hyphens`;
  }
  return undefined;
}

// DOMAIN_UNKNOWN support: the sanctioned domain set is the `branches[].key`
// values in owners.yaml (the SAME structural source CODEOWNERS uses). Domain is
// now structural — a record's domain IS the first path segment beneath root
// (records/<domain>/…), not an optional frontmatter field — so the allowed set
// must come from owners.yaml, not be hardcoded. owners.yaml lives at the repo
// root, one level above the records root: <root>/../owners.yaml.
//
// The manifest also carries each branch's `lead` handle; we capture a
// domain->lead map alongside the allowed-domain set so OWNER_DOMAIN_MISMATCH can
// assert a record's `owner` equals the lead of its domain directory.
interface OwnersManifest {
  domains: Set<string>;
  leadOf: Map<string, string>;
}

async function loadOwners(root: string): Promise<OwnersManifest> {
  const ownersPath = join(root, "..", "owners.yaml");
  let text: string;
  try {
    text = await readFile(ownersPath, "utf8");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw { operational: true, message: `cannot read owners.yaml at ${ownersPath}: ${message}` } satisfies OperationalFault;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw { operational: true, message: `cannot parse owners.yaml at ${ownersPath}: ${message}` } satisfies OperationalFault;
  }
  const branches = isPlainObject(parsed) ? parsed["branches"] : undefined;
  if (!Array.isArray(branches)) {
    throw { operational: true, message: `owners.yaml at ${ownersPath} has no 'branches' array` } satisfies OperationalFault;
  }
  const domains = new Set<string>();
  const leadOf = new Map<string, string>();
  for (const b of branches) {
    if (isPlainObject(b) && typeof b["key"] === "string") {
      const key = b["key"];
      domains.add(key);
      if (typeof b["lead"] === "string") {
        leadOf.set(key, b["lead"]);
      }
    }
  }
  if (domains.size === 0) {
    throw { operational: true, message: `owners.yaml at ${ownersPath} declared no branch keys` } satisfies OperationalFault;
  }
  return { domains, leadOf };
}

// The record's domain is the FIRST path segment beneath root
// (records/<domain>/file.md -> "<domain>"). A file directly under root has no
// domain segment -> undefined (reported as DOMAIN_UNKNOWN).
function domainOf(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  const segments = rel.split(sep).filter((s) => s.length > 0);
  // segments[last] is the filename; a domain requires at least [domain, file].
  if (segments.length < 2) return undefined;
  return segments[0];
}

/**
 * Pure core: validate every record under `root` and return the full error list.
 * Deterministic; never calls process.exit. On an operational fault it throws an
 * OperationalFault (the CLI maps that to exit code 2).
 */
export async function validateRecords(root: string): Promise<RecordError[]> {
  const errors: RecordError[] = [];

  // Load the owners manifest (domain set + domain->lead map) BEFORE scanning
  // records — if owners.yaml is missing/unparseable the validator cannot know
  // the domains or leads, which is an operational fault (exit 2), not a
  // per-record error.
  const owners = await loadOwners(root);
  const allowedDomains = owners.domains;

  // --- Load + compile the schema ONCE (single source of truth, from disk) ---
  let validate: ValidateFunction;
  try {
    const schemaText = await readFile(SCHEMA_PATH, "utf8");
    const schema = JSON.parse(schemaText) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv, { mode: "full" });
    validate = ajv.compile(schema);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw { operational: true, message: `cannot load ${SCHEMA_PATH}: ${message}` } satisfies OperationalFault;
  }

  // --- DISCOVER: enumerate record files with Node's built-in fs.glob ---
  // fs.glob silently yields zero matches for a missing/unreadable root, which
  // would masquerade as a valid empty registry. An unreadable/absent root is an
  // OPERATIONAL fault (exit 2), distinct from "records are wrong" (exit 1) — so
  // assert the root is a real directory first.
  try {
    const st = await stat(root);
    if (!st.isDirectory()) {
      throw { operational: true, message: `root is not a directory: ${root}` } satisfies OperationalFault;
    }
  } catch (e) {
    if (isOperationalFault(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw { operational: true, message: `cannot access root directory ${root}: ${message}` } satisfies OperationalFault;
  }

  const files: string[] = [];
  try {
    for await (const entry of glob(`${root}/**/*.md`)) {
      files.push(entry);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw { operational: true, message: `cannot glob ${root}/**/*.md: ${message}` } satisfies OperationalFault;
  }
  // Deterministic order regardless of filesystem iteration order.
  files.sort();

  // --- Pass 1: parse, schema-check, filename-check, build the model ---
  const model = new Map<string, RecordNode>();
  // Track ids seen so a duplicate can be reported against BOTH paths.
  const idToPaths = new Map<string, string[]>();

  for (const path of files) {
    // DOMAIN_UNKNOWN (structural): a record's domain is the first path segment
    // beneath root and MUST be a governed branch key. This is path-based, so it
    // is asserted independently of frontmatter validity.
    const domain = domainOf(root, path);
    const domainGoverned = domain !== undefined && allowedDomains.has(domain);
    if (domain === undefined) {
      errors.push({ path, rule: "DOMAIN_UNKNOWN", message: `${path} is not under a governed domain directory (records/<domain>/…)` });
    } else if (!domainGoverned) {
      errors.push({ path, rule: "DOMAIN_UNKNOWN", message: `${path} is not a governed domain (${domain} is not a branch key in owners.yaml)` });
    }

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw { operational: true, message: `cannot read ${path}: ${message}` } satisfies OperationalFault;
    }

    let data: unknown;
    try {
      const parsed = matter(raw);
      data = parsed.data;
    } catch (e) {
      // A record's OWN malformed frontmatter is a record error, not an
      // operational fault — the file is a record and its YAML is broken.
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ path, rule: "FRONTMATTER_MISSING", message: `frontmatter YAML failed to parse: ${message}` });
      continue;
    }

    // Non-object / empty data -> FRONTMATTER_MISSING, skip graph insertion.
    if (!isPlainObject(data) || Object.keys(data).length === 0) {
      errors.push({ path, rule: "FRONTMATTER_MISSING", message: "no frontmatter, or frontmatter is not a mapping" });
      continue;
    }

    const id = typeof data["id"] === "string" ? (data["id"] as string) : undefined;

    // Companion diagnostic for the quoted-date convention (SCHEMA_INVALID still
    // fires below because a Date is not a string).
    if (dateFieldIsJsDate(data)) {
      errors.push({
        path,
        recordId: id,
        rule: "SCHEMA_INVALID",
        message: "/date parsed as a Date — quote it in the frontmatter (e.g. date: '2026-01-01')",
      });
    }

    // SCHEMA validation.
    const ok = validate(data);
    if (!ok && validate.errors) {
      for (const e of validate.errors) {
        errors.push({ path, recordId: id, rule: "SCHEMA_INVALID", message: schemaErrorToMessage(e) });
      }
    }

    // FILENAME check (only meaningful when we have an id string).
    if (id !== undefined) {
      const reason = filenameMismatchReason(path, id);
      if (reason !== undefined) {
        errors.push({ path, recordId: id, rule: "FILENAME_MISMATCH", message: reason });
      }
    }

    // ID_PATTERN: a dedicated check so a schema-clean-but-malformed id still has
    // a stable code. The schema pattern is the first line of defence; this is a
    // targeted second so the machine code is precise for the index/CI annotator.
    if (id !== undefined && !/^(PRD|PDR|ADR|SPEC)-[0-9]{4}$/.test(id)) {
      errors.push({
        path,
        recordId: id,
        rule: "ID_PATTERN",
        message: `id '${id}' does not match ^(PRD|PDR|ADR|SPEC)-[0-9]{4}$`,
      });
    }

    // BUILD MODEL — index by id even if schema-invalid (so downstream ref checks
    // can report "resolves to an invalid record" rather than a false
    // REF_UNRESOLVED). Requires a usable id string.
    if (id === undefined) {
      continue;
    }

    const seenPaths = idToPaths.get(id);
    if (seenPaths) {
      seenPaths.push(path);
    } else {
      idToPaths.set(id, [path]);
    }

    // Normalise the graph-relevant fields defensively; schema already reported
    // any shape problems above.
    const references = Array.isArray(data["references"])
      ? (data["references"] as unknown[]).filter((r): r is string => typeof r === "string")
      : [];
    const supersedes = typeof data["supersedes"] === "string" ? (data["supersedes"] as string) : null;
    const supersededBy = typeof data["supersededBy"] === "string" ? (data["supersededBy"] as string) : null;
    const type = typeof data["type"] === "string" ? (data["type"] as string) : "";
    const status = typeof data["status"] === "string" ? (data["status"] as string) : "";
    const owner = typeof data["owner"] === "string" ? (data["owner"] as string) : undefined;

    // First occurrence wins in the model; duplicates are reported below.
    if (!model.has(id)) {
      model.set(id, { id, type, status, references, supersedes, supersededBy, path, domain, domainGoverned, owner });
    }
  }

  // ID_DUPLICATE — emit against every path carrying the id (fix is unambiguous).
  for (const [id, paths] of idToPaths) {
    if (paths.length > 1) {
      const sorted = [...paths].sort();
      for (const p of sorted) {
        errors.push({
          path: p,
          recordId: id,
          rule: "ID_DUPLICATE",
          message: `id ${id} is declared in ${sorted.length} files: ${sorted.join(", ")}`,
        });
      }
    }
  }

  // --- Pass 2: graph invariants ---
  // Reverse index for SUPERSEDE_FORK: target -> [superseder ids].
  const supersededByWho = new Map<string, string[]>();

  for (const node of model.values()) {
    const self = node.id;

    // OWNER_DOMAIN_MISMATCH: a record's `owner` must equal its domain's lead in
    // owners.yaml — the record-level enforcement that ownership matches
    // placement. Skip when the domain is not governed (DOMAIN_UNKNOWN already
    // covers that) or when `owner` is absent (schema `required` covers it) — no
    // double-reporting.
    if (node.domainGoverned && node.domain !== undefined && node.owner !== undefined) {
      const lead = owners.leadOf.get(node.domain);
      if (lead !== undefined && node.owner !== lead) {
        errors.push({
          path: node.path,
          recordId: self,
          rule: "OWNER_DOMAIN_MISMATCH",
          message: `record owner '${node.owner}' does not match the '${node.domain}' domain lead '${lead}' in owners.yaml`,
        });
      }
    }

    // (B) reference resolution + (PT-6) self + (PT-7) rejected parent.
    for (const ref of node.references) {
      if (ref === self) {
        errors.push({ path: node.path, recordId: self, rule: "REF_SELF", message: `${self} references itself` });
        continue;
      }
      const target = model.get(ref);
      if (!target) {
        errors.push({ path: node.path, recordId: self, rule: "REF_UNRESOLVED", message: `${self} references ${ref} which does not resolve to any record` });
        continue;
      }
      if (target.status === "rejected") {
        errors.push({ path: node.path, recordId: self, rule: "REF_TO_REJECTED", message: `${self} references ${ref} whose status is 'rejected' (a rejected record was never in force)` });
      }
    }

    // (C) parent-TYPE + count (PT-1..PT-5, PT-8).
    const rule = PARENT_RULES[node.type];
    if (rule) {
      // Type of each resolvable parent must be allowed for this child type.
      for (const ref of node.references) {
        if (ref === self) continue;
        const target = model.get(ref);
        if (!target) continue; // unresolved already reported
        if (!rule.allowed.includes(target.type)) {
          const allowedStr = rule.allowed.length ? rule.allowed.join("|") : "(none — root)";
          errors.push({
            path: node.path,
            recordId: self,
            rule: "PARENT_TYPE",
            message: `${self} references ${ref} but ${node.type} parents must be ${allowedStr}`,
          });
        }
      }

      // Count bounds.
      const n = node.references.length;
      if (n < rule.min || n > rule.max) {
        const maxStr = rule.max === Infinity ? "∞" : String(rule.max);
        errors.push({
          path: node.path,
          recordId: self,
          rule: "PARENT_COUNT",
          message: `${node.type} ${self} has ${n} reference(s); required range is [${rule.min}, ${maxStr}]`,
        });
      }

      // mustContain (SPEC must anchor >=1 ADR).
      if (rule.mustContain) {
        for (const requiredType of rule.mustContain) {
          const has = node.references.some((ref) => {
            const t = model.get(ref);
            return t !== undefined && t.type === requiredType;
          });
          if (!has) {
            errors.push({
              path: node.path,
              recordId: self,
              rule: "PARENT_COUNT",
              message: `${node.type} ${self} must reference >=1 ${requiredType}`,
            });
          }
        }
      }
    }

    // (D) supersession integrity (SS-1, SS-2a, SS-2b).
    if (node.supersedes !== null) {
      const target = model.get(node.supersedes);
      if (!target) {
        errors.push({ path: node.path, recordId: self, rule: "REF_UNRESOLVED", message: `${self} supersedes ${node.supersedes} which does not resolve to any record` });
      } else {
        if (target.type !== node.type) {
          errors.push({ path: node.path, recordId: self, rule: "SUPERSEDE_TYPE", message: `${self} (type ${node.type}) supersedes ${target.id} (type ${target.type}); supersession is same-type only` });
        }
        if (target.status !== "superseded") {
          errors.push({ path: node.path, recordId: self, rule: "SUPERSEDE_STATUS", message: `${self} supersedes ${target.id} whose status is '${target.status}', but a superseded target must have status 'superseded'` });
        }
        if (target.supersededBy !== self) {
          errors.push({ path: node.path, recordId: self, rule: "SUPERSEDE_BACKLINK", message: `${target.id}.supersededBy is '${target.supersededBy ?? "null"}' but must be '${self}' (bidirectional supersession link is broken)` });
        }
        // Record the edge for the fork check.
        const who = supersededByWho.get(node.supersedes);
        if (who) who.push(self);
        else supersededByWho.set(node.supersedes, [self]);
      }
    }
  }

  // (SS-3) SUPERSEDE_FORK: >1 live record superseding the same target.
  for (const [targetId, superseders] of supersededByWho) {
    if (superseders.length > 1) {
      const sorted = [...superseders].sort();
      for (const s of sorted) {
        const node = model.get(s);
        if (!node) continue;
        errors.push({
          path: node.path,
          recordId: s,
          rule: "SUPERSEDE_FORK",
          message: `${targetId} is superseded by ${sorted.length} records (${sorted.join(", ")}); at most one is allowed`,
        });
      }
    }
  }

  // (SS-4) SUPERSEDE_CYCLE: walk each supersedes chain; a revisit is a cycle.
  for (const start of model.values()) {
    if (start.supersedes === null) continue;
    const seen = new Set<string>();
    let currentId: string | null = start.id;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        errors.push({
          path: start.path,
          recordId: start.id,
          rule: "SUPERSEDE_CYCLE",
          message: `supersession chain starting at ${start.id} revisits ${currentId} — supersedes must not form a cycle`,
        });
        break;
      }
      seen.add(currentId);
      const cur: RecordNode | undefined = model.get(currentId);
      currentId = cur ? cur.supersedes : null;
    }
  }

  // Deterministic ordering: by path, then rule, then message.
  errors.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  return errors;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  root: string;
  json: boolean;
}

function parseArgs(args: string[]): CliOptions {
  let root = "records";
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--root") {
      const next = args[i + 1];
      if (next === undefined) {
        throw { operational: true, message: "--root requires a directory argument" } satisfies OperationalFault;
      }
      root = next;
      i++;
    } else if (a.startsWith("--root=")) {
      root = a.slice("--root=".length);
    } else {
      throw { operational: true, message: `unknown argument: ${a}` } satisfies OperationalFault;
    }
  }
  return { root, json };
}

function printHumanReport(errors: RecordError[]): void {
  if (errors.length === 0) {
    stdout.write("0 errors — registry is valid.\n");
    return;
  }
  // Group by path (already sorted by path then rule).
  const byPath = new Map<string, RecordError[]>();
  for (const e of errors) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  for (const [path, list] of byPath) {
    for (const e of list) {
      stdout.write(`${path}: [${e.rule}] ${e.message}\n`);
    }
  }
  stdout.write(`\n${errors.length} error(s) across ${byPath.size} file(s).\n`);
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv.slice(2));
  } catch (e) {
    if (isOperationalFault(e)) {
      stderr.write(`validate-records: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  let errors: RecordError[];
  try {
    errors = await validateRecords(options.root);
  } catch (e) {
    if (isOperationalFault(e)) {
      stderr.write(`validate-records: operational fault: ${e.message}\n`);
      return 2;
    }
    const message = e instanceof Error ? e.stack ?? e.message : String(e);
    stderr.write(`validate-records: operational fault: ${message}\n`);
    return 2;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(errors, null, 2)}\n`);
  } else {
    printHumanReport(errors);
  }

  return errors.length > 0 ? 1 : 0;
}

// import.meta-style main guard: only run the CLI when executed directly, not
// when imported by the test suite.
const isMain = (() => {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  // Resolve root relative to the process CWD so `pnpm validate` (run at repo
  // root) finds `records/`.
  void main().then((code) => {
    exit(code);
  });
}
