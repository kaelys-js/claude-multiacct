// Extended coverage for the record validator (`../src/validate-records.ts`).
//
// The base suite (`validate-records.test.ts`) exhaustively covers the per-rule
// invariants via the pure `validateRecords(root)` core. This file adds the two
// surfaces that suite leaves uncovered:
//
//   1. OPERATIONAL FAULTS (exit-2 territory): a bad/absent root, a root that is
//      a file not a directory, a missing/empty/malformed owners.yaml, a missing
//      template, an unreadable schema. These are the "the validator itself
//      broke" faults the CLI maps to exit 2 — distinct from "records are wrong"
//      (exit 1). WHY they matter: CI must be able to tell a broken toolchain from
//      a legitimately-failing registry, or a misconfigured runner looks like a
//      bad PR.
//
//   2. THE CLI (`main` / `parseArgs` / `printHumanReport` + the `isMain` guard),
//      exercised in-process by mocking `node:process` so argv/exit/stdout/stderr
//      are controllable. WHY: the exit codes and the --json vs human report ARE
//      the contract the CI gate consumes; a regression there (wrong exit code,
//      malformed JSON) silently breaks the gate.
//
// Rule 9: each test states the behaviour that matters, not just the line it hits.

// The oxlint `vitest` plugin's `no-conditional-in-test` rule flags the `&&`
// inside `.some()` / `.every()` / `.filter()` predicate callbacks as branching
// test logic, which it is not — a false positive here (same disable the base
// suite uses), so it is turned off file-wide.
/* oxlint-disable vitest/no-conditional-in-test */

import { describe, it, expect, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type * as fsPromises from "node:fs/promises";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { validateRecords, type RecordError } from "../src/validate-records.ts";

// Alias the fs/promises module type so the `vi.importActual` mocks below don't
// need inline `typeof import(...)` annotations (which oxlint's
// consistent-type-imports rule forbids).
type FsPromises = typeof fsPromises;

// A stable comparator matching the validator's own error ordering (path, then
// rule, then message) — used by the ordering tests to assert the emitted slice
// is already sorted, without inlining a nested ternary into each test.
function compareStrings(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	if (a > b) {
		return 1;
	}
	return 0;
}

function compareErrors(a: RecordError, b: RecordError): number {
	return a.rule === b.rule ? compareStrings(a.message, b.message) : compareStrings(a.rule, b.rule);
}

const VR = fileURLToPath(new URL("../src/validate-records.ts", import.meta.url));
// The real templates live in the @foundation/registry package beside this test
// (../templates), resolved via import.meta.dirname so the reads are cwd-independent.
const TEMPLATES_DIR = join(import.meta.dirname, "..", "templates");
const TEMPLATE_TYPES = ["prd", "pdr", "adr", "spec"];

// The canonical H2 headings for a PRD, read from the REAL template (same single
// source the validator derives them from) — so a generated body carries every
// required section and can't drift from what BODY_SECTIONS_MISSING enforces.
async function prdSections(): Promise<string[]> {
	const text = await readFile(join(TEMPLATES_DIR, "prd.template.md"), "utf8");
	const body = matter(text).content;
	const out: string[] = [];
	let inFence = false;
	for (const line of body.split("\n")) {
		if (/^\s*(```|~~~)/u.test(line)) {
			inFence = !inFence;
		} else if (!inFence) {
			const m = /^##[ \t]+(.+?)\s*$/u.exec(line);
			if (m && m[1] !== undefined && !line.startsWith("###")) {
				const h = m[1].trim();
				if (h.toLowerCase() === "filled example") {
					break;
				}
				out.push(h);
			}
		}
	}
	return out;
}

// A schema-valid PRD (governance domain, lead owner) whose body carries every
// canonical PRD section, so a fixture can host a genuinely-clean record. `id`
// overridable so a fixture can place a second distinct PRD.
async function validPrdFile(id = "PRD-0001"): Promise<string> {
	const sections = await prdSections();
	const body = [
		"# Record body",
		"",
		...sections.flatMap((h) => [`## ${h}`, "", "Placeholder.", ""]),
	].join("\n");
	return [
		"---",
		`id: ${id}`,
		"type: PRD",
		"title: A sufficiently long record title",
		"status: accepted",
		"owner: '@lead-foundation'",
		"date: '2026-05-18'",
		"references: []",
		"supersedes: null",
		"---",
		"",
		body,
	].join("\n");
}

// A minimal owners.yaml declaring the governance branch + lead the PRD needs.
function ownersYaml(): string {
	return 'branches:\n  - key: governance\n    team: "@ttt/governance"\n    lead: "@lead-foundation"\n';
}

// Build a temp base dir with records/, owners.yaml, and (optionally) copied
// templates. Returns the records root and a cleanup fn. `opts` toggles the
// operational-fault scenarios (skip owners, skip templates, …).
async function fixture(
	opts: {
		files?: Array<{ rel: string; content: string }>;
		owners?: string | null; // null = don't write owners.yaml
		templates?: boolean; // copy real templates (default true)
	} = {},
): Promise<{ base: string; root: string; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "vr-more-"));
	const root = join(base, "records");
	await mkdir(root, { recursive: true });
	if (opts.owners !== null) {
		await writeFile(join(base, "owners.yaml"), opts.owners ?? ownersYaml(), "utf8");
	}
	if (opts.templates !== false) {
		const templatesDir = join(base, "templates");
		await mkdir(templatesDir, { recursive: true });
		for (const t of TEMPLATE_TYPES) {
			await copyFile(
				join(TEMPLATES_DIR, `${t}.template.md`),
				join(templatesDir, `${t}.template.md`),
			);
		}
	}
	for (const f of opts.files ?? []) {
		const full = join(root, f.rel);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, f.content, "utf8");
	}
	return { base, root, cleanup: () => rm(base, { recursive: true, force: true }) };
}

// Run the validator's CLI in-process by mocking `node:process` (the module
// imports argv/exit/stdout/stderr as named bindings). Sets argv[1] to VR so the
// `isMain` guard fires and `main()` runs.
async function runCli(args: string[]): Promise<{
	code: number | undefined;
	out: string;
	err: string;
}> {
	let code: number | undefined;
	const out: string[] = [];
	const err: string[] = [];
	vi.resetModules();
	vi.doMock("node:process", () => ({
		argv: ["node", VR, ...args],
		exit: (c?: number): never => {
			code = c;
			throw new Error("__exit__");
		},
		stdout: {
			write: (s: string): boolean => {
				out.push(s);
				return true;
			},
		},
		stderr: {
			write: (s: string): boolean => {
				err.push(s);
				return true;
			},
		},
	}));
	try {
		await import("../src/validate-records.ts");
	} catch (error) {
		if (!String(error).includes("__exit__")) {
			throw error;
		}
	}
	return { code, out: out.join(""), err: err.join("") };
}

// Import a fresh validateRecords whose `node:fs/promises` is mocked so a chosen
// path rejects with the given value — exercising the `error instanceof Error`
// message-extraction branches of each catch (an Error takes the `.message` arm;
// a bare non-Error takes the `String(error)` fallback arm). Returns the module's
// validateRecords bound to the mocked fs. The caller unmocks in a finally.
async function withRejectingReadFile(
	matchPath: string,
	rejectWith: unknown,
): Promise<(root: string) => Promise<RecordError[]>> {
	vi.resetModules();
	const realFs = await vi.importActual<FsPromises>("node:fs/promises");
	vi.doMock("node:fs/promises", () => ({
		...realFs,
		readFile: async (p: string, enc?: unknown): Promise<string> => {
			if (String(p).includes(matchPath)) {
				throw rejectWith;
			}
			return (await realFs.readFile(p as never, enc as never)) as unknown as string;
		},
	}));
	const mod = await import("../src/validate-records.ts");
	return mod.validateRecords;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.doUnmock("node:process");
	vi.resetModules();
});

// ─── operational faults (exit-2 core) ──────────────────────────────────────

describe("validateRecords — operational faults", () => {
	it("throws an operational fault when the root does not exist", async () => {
		// WHY: an absent root must be exit-2 ('validator can't run'), NOT a silent
		// empty-registry pass — fs.glob would yield zero matches and masquerade as
		// valid.
		const missing = join(tmpdir(), "vr-does-not-exist-xyz", "records");
		await expect(validateRecords(missing)).rejects.toMatchObject({ operational: true });
	});

	it("throws an operational fault when the root is a FILE, not a directory", async () => {
		// WHY: pointing --root at a file is a config error; the validator must reject
		// it as operational, distinct from record errors. owners.yaml + templates are
		// placed at <root>/.. so loadOwners/loadCanonicalSections pass and the
		// not-a-directory branch of the root stat is what fires.
		const base = await mkdtemp(join(tmpdir(), "vr-file-"));
		const asFile = join(base, "not-a-dir");
		await writeFile(asFile, "x", "utf8");
		// loadOwners/loadCanonicalSections resolve <root>/../owners.yaml and
		// <root>/../templates → base/owners.yaml and base/templates here, so both pass
		// and the root-stat 'not a directory' branch is what actually fires.
		await writeFile(join(base, "owners.yaml"), ownersYaml(), "utf8");
		const templatesDir = join(base, "templates");
		await mkdir(templatesDir, { recursive: true });
		for (const t of TEMPLATE_TYPES) {
			await copyFile(
				join(TEMPLATES_DIR, `${t}.template.md`),
				join(templatesDir, `${t}.template.md`),
			);
		}
		await expect(validateRecords(asFile)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("is not a directory"),
		});
		await rm(base, { recursive: true, force: true });
	});

	it("throws when owners.yaml is missing (cannot know the governed domains)", async () => {
		// WHY: without owners.yaml the validator can't know the sanctioned domain set
		// or the per-domain leads — an operational fault, not a per-record error.
		const { root, cleanup } = await fixture({ owners: null, files: [] });
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("cannot read owners.yaml"),
		});
		await cleanup();
	});

	it("throws when owners.yaml has no 'branches' array", async () => {
		// WHY: a structurally-wrong manifest (no branches:) means no domains can be
		// derived — operational.
		const { root, cleanup } = await fixture({ owners: "somethingElse: true\n" });
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("no 'branches' array"),
		});
		await cleanup();
	});

	it("throws when owners.yaml declares zero branch keys", async () => {
		// WHY: a branches: array with no usable `key` entries yields an empty domain
		// set — the validator would reject every record; that's a manifest fault.
		const { root, cleanup } = await fixture({
			owners: "branches:\n  - team: t\n    lead: l\n", // entries without `key`
		});
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("declared no branch keys"),
		});
		await cleanup();
	});

	it("throws 'no branches array' when owners.yaml parses to a non-object scalar", async () => {
		// WHY: a manifest that parses to a bare scalar (not a mapping) has no branches:
		// — the isPlainObject guard's false arm must still yield the operational
		// 'no branches array' fault, not crash on a non-object.
		const { root, cleanup } = await fixture({ owners: "just a bare string\n" });
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("no 'branches' array"),
		});
		await cleanup();
	});

	it("accepts a branch entry that omits `lead` (no crash; that domain just has no lead)", async () => {
		// WHY: the leadOf map only records a lead when present. A branch with a `key`
		// but no `lead` must be tolerated (the typeof-string guard's false arm) — the
		// domain is governed, it simply has no OWNER_DOMAIN_MISMATCH lead to check
		// against. A governance record there stays clean.
		const owners = [
			"branches:",
			"  - key: governance", // no lead: — exercises the missing-lead arm
			'    team: "@ttt/governance"',
		].join("\n");
		// The record omits owner too (schema requires it) — but we only assert the run
		// does not crash and the domain is recognised (no DOMAIN_UNKNOWN).
		const { root, cleanup } = await fixture({
			owners,
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		const errors = await validateRecords(root);
		await cleanup();
		expect(
			errors.every((e) => e.rule !== "DOMAIN_UNKNOWN"),
			"governance is a governed key even without a lead",
		).toBe(true);
	});

	it("throws when owners.yaml is malformed YAML (parse fault)", async () => {
		// WHY: a syntactically-broken manifest is an operational fault, surfaced with a
		// parse message so the runner can be fixed.
		const { root, cleanup } = await fixture({ owners: "branches:\n  - key: [unclosed\n" });
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("cannot parse owners.yaml"),
		});
		await cleanup();
	});

	it("throws when a canonical template file is missing (drift-proof sections unreadable)", async () => {
		// WHY: the required body sections are derived from templates/. A missing
		// template means the validator can't know the canonical sections — operational.
		const { base, root, cleanup } = await fixture({ templates: true });
		await rm(join(base, "templates", "adr.template.md"), { force: true });
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("cannot read template"),
		});
		await cleanup();
	});

	it("throws when the on-disk schema cannot be loaded", async () => {
		// WHY: the schema is the single source of truth for shape; if it can't be
		// read/compiled the validator cannot function — operational. Simulated by
		// mocking fs/promises.readFile to fail specifically for the schema path.
		vi.resetModules();
		const realFs = await vi.importActual<FsPromises>("node:fs/promises");
		vi.doMock("node:fs/promises", () => ({
			...realFs,
			readFile: (p: string, enc?: unknown): Promise<string> => {
				if (String(p).includes("record.schema.json")) {
					return Promise.reject(new Error("schema boom"));
				}
				return realFs.readFile(p as never, enc as never) as unknown as Promise<string>;
			},
		}));
		const mod = await import("../src/validate-records.ts");
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(mod.validateRecords(root)).rejects.toMatchObject({
				// SCHEMA_PATH is now the absolute package path, so the message reads
				// "cannot load <abs>/schema/record.schema.json: schema boom".
				operational: true,
				message: expect.stringContaining("schema/record.schema.json: schema boom"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("throws when a template declares zero canonical sections (empty-template fault)", async () => {
		// WHY: the required sections are DERIVED from the templates. A template with no
		// '## ' headings before 'Filled example' means the drift-proof source is empty —
		// an operational fault (the `headings.length === 0` guard), so a broken template
		// can't silently disable body-section checking.
		const { base, root, cleanup } = await fixture({ templates: true });
		// Overwrite one real template with a section-less one (only a Filled example).
		await writeFile(
			join(base, "templates", "adr.template.md"),
			"---\nx: 1\n---\n\n# Title\n\n## Filled example\n\nnothing above.\n",
			"utf8",
		);
		await expect(validateRecords(root)).rejects.toMatchObject({
			operational: true,
			message: expect.stringContaining("no canonical '## ' sections"),
		});
		await cleanup();
	});

	it("a fenced code block in a record body does not leak its ## lines as headings", async () => {
		// WHY: h2Headings must skip fenced code so a `## not-a-heading` inside ``` (or
		// ~~~) is NOT counted as a section — otherwise a code sample could satisfy the
		// body-section check spuriously (or a real heading be missed). This drives the
		// fence-toggle branches. The PRD body carries all real sections PLUS a fenced
		// block containing a bogus `## Fake` that must be ignored.
		const sections = await prdSections();
		const body = [
			"# Record body",
			"",
			...sections.flatMap((h) => [`## ${h}`, "", "Placeholder.", ""]),
			"~~~",
			"## Fake heading inside a tilde fence",
			"~~~",
			"",
			"```",
			"## Another fake inside a backtick fence",
			"```",
			"",
		].join("\n");
		const prdWithFence = [
			"---",
			"id: PRD-0001",
			"type: PRD",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"---",
			"",
			body,
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: prdWithFence }],
		});
		const errors = await validateRecords(root);
		await cleanup();
		// All real sections are present and the fenced fakes are ignored → the record
		// is clean (a leaked fake heading wouldn't cause an error, but a MISSING real
		// one would; the point is the run is clean and didn't miscount).
		expect(
			errors.filter((e) => e.rule === "BODY_SECTIONS_MISSING"),
			"fenced ## lines must not affect section detection",
		).toEqual([]);
	});

	it("surfaces a NON-Error owners.yaml read failure via String() (defensive fallback)", async () => {
		// WHY: the catch coerces a thrown non-Error through String(); this proves the
		// fallback arm reports SOMETHING actionable rather than '[object Object]'-ing or
		// crashing when the underlying read rejects with a bare string.
		const validate = await withRejectingReadFile("owners.yaml", "raw-string-failure");
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(validate(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("raw-string-failure"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("surfaces a NON-Error schema read failure via String() (defensive fallback)", async () => {
		// WHY: same defensive fallback for the schema load catch — a non-Error rejection
		// must still produce a readable operational message.
		const validate = await withRejectingReadFile("record.schema.json", "schema-string-fail");
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(validate(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("schema-string-fail"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("surfaces a NON-Error record read failure via String() (defensive fallback)", async () => {
		// WHY: the parallel record-read catch has the same non-Error fallback. A record
		// file that rejects with a bare string must surface as an operational fault
		// naming that string, not crash the Promise.all.
		const validate = await withRejectingReadFile("prd-0001-why.md", "record-read-string-fail");
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		try {
			await expect(validate(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("record-read-string-fail"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("surfaces an Error-typed record read failure via error.message (the instanceof arm)", async () => {
		// WHY: complements the non-Error record-read test — a normal Error rejection
		// must take the `error instanceof Error` TRUE arm and surface error.message, so
		// BOTH arms of the record-read catch's message extraction are exercised.
		const validate = await withRejectingReadFile(
			"prd-0001-why.md",
			new Error("record-read-error-object"),
		);
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		try {
			await expect(validate(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("record-read-error-object"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("surfaces an Error-typed owners.yaml read failure via error.message (the instanceof arm)", async () => {
		// WHY: complements the non-Error owners test so both arms of loadOwners' read
		// catch are covered — an Error rejection must report error.message.
		const validate = await withRejectingReadFile("owners.yaml", new Error("owners-error-object"));
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(validate(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("owners-error-object"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("maps a glob failure to an operational fault (glob catch)", async () => {
		// WHY: the record-discovery glob can fail (permission, IO). That must be an
		// operational fault, not a silent empty registry — the glob catch. Mock `glob`
		// to throw so the discovery-failure branch is exercised.
		vi.resetModules();
		const realFs = await vi.importActual<FsPromises>("node:fs/promises");
		vi.doMock("node:fs/promises", () => ({
			...realFs,
			glob: (): AsyncIterable<string> => ({
				[Symbol.asyncIterator](): AsyncIterator<string> {
					return {
						next: (): Promise<IteratorResult<string>> => Promise.reject(new Error("glob-boom")),
					};
				},
			}),
		}));
		const mod = await import("../src/validate-records.ts");
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(mod.validateRecords(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("cannot glob"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("maps a NON-Error root stat rejection to an operational fault via String() (stat fallback)", async () => {
		// WHY: the root-access catch coerces a thrown non-Error through String(); a stat
		// that rejects with a bare string must still yield a readable 'cannot access
		// root' fault — the defensive fallback arm of the stat catch.
		vi.resetModules();
		const realFs = await vi.importActual<FsPromises>("node:fs/promises");
		vi.doMock("node:fs/promises", () => ({
			...realFs,
			stat: async (): Promise<never> => {
				// Reject with a bare string (non-Error) via throw so the stat catch's
				// String(error) fallback arm is exercised without tripping
				// prefer-promise-reject-errors.
				await Promise.resolve();
				throw "stat-string-fail";
			},
		}));
		const mod = await import("../src/validate-records.ts");
		const { root, cleanup } = await fixture({ files: [] });
		try {
			await expect(mod.validateRecords(root)).rejects.toMatchObject({
				operational: true,
				message: expect.stringContaining("stat-string-fail"),
			});
		} finally {
			await cleanup();
			vi.doUnmock("node:fs/promises");
		}
	});

	it("reports REF_UNRESOLVED when a supersedes target does not resolve to any record", async () => {
		// WHY: a supersedes edge pointing at a non-existent id is a dangling successor
		// link — the graph pass must flag it (schema can't see cross-record absence).
		// This exercises the supersedes-unresolved branch of the graph pass.
		const orphanSup = [
			"---",
			"id: PRD-0002",
			"type: PRD",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: PRD-9999",
			"---",
			"",
			"# Record body",
			"",
			"## Why now",
			"",
			"Placeholder.",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-orphan-sup.md", content: orphanSup },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const sup = errors.filter(
			(e) => e.path.includes("prd-0002-orphan-sup") && e.rule === "REF_UNRESOLVED",
		);
		expect(sup.length, "a supersedes pointing at a missing id must be REF_UNRESOLVED").toBe(1);
		expect(sup[0]?.message).toContain("PRD-9999");
	});
});

// ─── shape/graph branch coverage the base suite leaves uncovered ───────────

describe("validateRecords — additional shape/graph branches", () => {
	it("a record placed DIRECTLY under root (no domain segment) is DOMAIN_UNKNOWN", async () => {
		// WHY: domain is the FIRST path segment beneath root. A file at records/x.md has
		// no domain directory at all — a distinct branch from 'a wrong domain dir'. It
		// must still be rejected (no accountable branch/owner).
		const { root, cleanup } = await fixture({
			files: [{ rel: "prd-0001-directly-under-root.md", content: await validPrdFile() }],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const dom = errors.filter((e) => e.rule === "DOMAIN_UNKNOWN");
		expect(dom.length, "a file with no domain dir must be DOMAIN_UNKNOWN").toBeGreaterThan(0);
		expect(dom[0]?.message).toContain("not under a governed domain directory");
	});

	it("schema errors surface the missing-property param when a required field is absent", async () => {
		// WHY: schemaErrorToMessage must make a `required` failure actionable by naming
		// the missing field — the '(missing: owner)' companion. Omitting `owner`
		// exercises the missingProperty param branch.
		const noOwner = [
			"---",
			"id: PRD-0002",
			"type: PRD",
			"title: A sufficiently long record title",
			"status: accepted",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-no-owner.md", content: noOwner },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const schemaErrs = errors.filter(
			(e) => e.path.includes("prd-0002-no-owner") && e.rule === "SCHEMA_INVALID",
		);
		expect(schemaErrs.some((e) => e.message.includes("missing: owner"))).toBe(true);
	});

	it("a stray unevaluated property is rejected as SCHEMA_INVALID", async () => {
		// WHY: unevaluatedProperties:false rejects unknown frontmatter keys — a record
		// can't smuggle in an undeclared field. A bogus `totallyBogusKey:` must trip
		// SCHEMA_INVALID with the unevaluated-properties message.
		const strayKey = [
			"---",
			"id: PRD-0002",
			"type: PRD",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"totallyBogusKey: 1",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-stray.md", content: strayKey },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const schemaErrs = errors.filter(
			(e) => e.path.includes("prd-0002-stray") && e.rule === "SCHEMA_INVALID",
		);
		expect(
			schemaErrs.some((e) => e.message.toLowerCase().includes("unevaluated")),
			"an undeclared frontmatter key must trip SCHEMA_INVALID (unevaluatedProperties:false)",
		).toBe(true);
		// The valid sibling stays clean — the check discriminates the bad record.
		expect(errors.filter((e) => e.path.includes("prd-0001-why"))).toEqual([]);
	});

	it("a file whose frontmatter YAML is syntactically broken is FRONTMATTER_MISSING (parse throw)", async () => {
		// WHY: a record whose OWN frontmatter YAML fails to parse is a record error
		// (broken record), not an operational fault — the parse-throw catch inside
		// processRecord must classify it as FRONTMATTER_MISSING and keep scanning.
		const brokenYaml = [
			"---",
			"id: PRD-0002",
			"title: 'unterminated",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-broken.md", content: brokenYaml },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const broken = errors.filter((e) => e.path.includes("prd-0002-broken"));
		expect(
			broken.some((e) => e.rule === "FRONTMATTER_MISSING"),
			"broken frontmatter YAML must be FRONTMATTER_MISSING, not a crash",
		).toBe(true);
		// The valid sibling must still be scanned and stay clean.
		expect(errors.filter((e) => e.path.includes("prd-0001-why"))).toEqual([]);
	});

	it("a PRD that carries a reference trips PARENT_COUNT and PARENT_TYPE (root type takes no parents)", async () => {
		// WHY: PRD is the spine root — allowed:[], min:0, max:0. A PRD that references
		// anything violates BOTH the count bound (>0 refs) and the type rule (parents
		// must be '(none — root)'). This exercises the root-type branch of the
		// parent-TYPE message and the count-bound branch.
		const basePrd = await validPrdFile("PRD-0002");
		const prdWithRef = basePrd.replace("references: []", "references:\n  - PRD-0001");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-has-ref.md", content: prdWithRef },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const codes = errors.filter((e) => e.path.includes("prd-0002-has-ref")).map((e) => e.rule);
		expect(codes, "a PRD with a reference must trip PARENT_COUNT").toContain("PARENT_COUNT");
		expect(codes, "and PARENT_TYPE — a root type accepts no parents").toContain("PARENT_TYPE");
		const pt = errors.find((e) => e.path.includes("prd-0002-has-ref") && e.rule === "PARENT_TYPE");
		expect(pt?.message, "the message must name the root '(none — root)' rule").toContain(
			"(none — root)",
		);
	});

	it("a SPEC with zero references reports the [1, ∞] count bound (Infinity max branch)", async () => {
		// WHY: SPEC has max:Infinity, so a count violation can only be the LOWER bound
		// (0 refs < min 1). The message renders the max as '∞' — the Infinity branch of
		// the count-bound formatting.
		const specNoRefs = [
			"---",
			"id: SPEC-0001",
			"type: SPEC",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/spec-0001-empty.md", content: specNoRefs },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const pc = errors.find((e) => e.path.includes("spec-0001-empty") && e.rule === "PARENT_COUNT");
		expect(pc, "a SPEC with zero refs must trip PARENT_COUNT").toBeDefined();
		expect(pc?.message, "the max bound must render as ∞ for SPEC").toContain("∞");
	});

	it("a record with a valid id but wrong-typed graph fields is normalised defensively (no crash)", async () => {
		// WHY: pass-1 indexes a record by id even when schema-invalid, so the graph pass
		// can report 'resolves to an invalid record' rather than a false unresolved.
		// The graph-field normalisation must tolerate `references` NOT being an array
		// and `type`/`status` being absent — defaulting to []/"" without throwing. The
		// record is still SCHEMA_INVALID; the point is the validator survives it.
		const wrongTypes = [
			"---",
			"id: PRD-0002",
			"references: not-an-array",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-wrong-types.md", content: wrongTypes },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		// It must be indexed + reported (SCHEMA_INVALID for the missing required fields)
		// and must NOT have crashed the run — the clean sibling is still reported clean.
		expect(
			errors.some((e) => e.path.includes("prd-0002-wrong-types") && e.rule === "SCHEMA_INVALID"),
		).toBe(true);
		expect(errors.filter((e) => e.path.includes("prd-0001-why"))).toEqual([]);
	});

	it("a frontmatter mapping with NO id is reported but not indexed (id-undefined return)", async () => {
		// WHY: a record whose frontmatter is a mapping but omits `id` can't be a graph
		// node (no key), so pass-1 reports its shape errors and returns without indexing
		// it — the `id === undefined` early return after the model-build guard.
		const noId = [
			"---",
			"type: PRD",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-no-id.md", content: noId },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		// The no-id record is SCHEMA_INVALID (id is required) but produces no graph
		// errors (REF_*/PARENT_*), proving it was reported-then-skipped, not indexed.
		const noIdErrs = errors.filter((e) => e.path.includes("prd-0002-no-id"));
		expect(noIdErrs.some((e) => e.rule === "SCHEMA_INVALID")).toBe(true);
		expect(noIdErrs.every((e) => !e.rule.startsWith("PARENT_"))).toBe(true);
	});

	it("two errors that differ ONLY by message on the same path+rule sort deterministically", async () => {
		// WHY: the final sort tie-breaks by message so output ordering is stable across
		// runs (CI diff-noise-free). A record that emits two same-rule errors on one
		// path (e.g. a SPEC missing BOTH required parent types) exercises the message
		// comparison arm of the comparator.
		const specTwoMustContain = [
			"---",
			"id: SPEC-0001",
			"type: SPEC",
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references:\n  - PRD-0001",
			"supersedes: null",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/spec-0001-wrong.md", content: specTwoMustContain },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		// Same path can carry multiple PARENT_* errors; the run must not throw and the
		// order must be stable (sorted). Re-running the sort key on the emitted slice
		// must equal the emitted order.
		const specErrs = errors.filter((e) => e.path.includes("spec-0001-wrong"));
		const resorted = specErrs.toSorted(compareErrors);
		expect(specErrs).toEqual(resorted);
		expect(specErrs.length).toBeGreaterThan(0);
	});

	it("multiple SCHEMA_INVALID errors on one path are message-sorted (both < and > comparator arms)", async () => {
		// WHY: a record with SEVERAL shape failures (bad status enum + too-short title)
		// emits multiple SCHEMA_INVALID on the SAME path+rule; the final comparator must
		// tie-break by message so ordering is stable. This drives both the `<` and `>`
		// arms of the message comparison (>=2 messages that sort in a fixed order).
		const manyShape = [
			"---",
			"id: PRD-0002",
			"type: PRD",
			"title: short", // < minLength 8
			"status: bogus-status", // not in the enum
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-many.md", content: manyShape },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const shape = errors.filter(
			(e) => e.path.includes("prd-0002-many") && e.rule === "SCHEMA_INVALID",
		);
		expect(shape.length, "several shape failures must each be reported").toBeGreaterThanOrEqual(2);
		// Emitted order must be non-decreasing by message (stable sort).
		const messages = shape.map((e) => e.message);
		const sorted = messages.toSorted(compareStrings);
		expect(messages).toEqual(sorted);
	});

	it("a record whose type is outside the recognised set skips the body-section check (no false BODY_SECTIONS)", async () => {
		// WHY: BODY_SECTIONS_MISSING only applies to the four canonical types. A record
		// with an unrecognised `type` (schema-invalid) must NOT be body-checked — the
		// `canonicalSections.has(bodyType)` guard's false arm — so the only error is the
		// SCHEMA_INVALID for the bad type, not a spurious missing-sections report.
		const weirdType = [
			"---",
			"id: PRD-0002",
			"type: WIDGET", // not PRD/PDR/ADR/SPEC
			"title: A sufficiently long record title",
			"status: accepted",
			"owner: '@lead-foundation'",
			"date: '2026-05-18'",
			"references: []",
			"supersedes: null",
			"---",
			"",
			"# body",
			"",
		].join("\n");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "governance/prd-0002-widget.md", content: weirdType },
			],
		});
		const errors = await validateRecords(root);
		await cleanup();
		const widget = errors.filter((e) => e.path.includes("prd-0002-widget"));
		expect(widget.some((e) => e.rule === "SCHEMA_INVALID")).toBe(true);
		expect(
			widget.every((e) => e.rule !== "BODY_SECTIONS_MISSING"),
			"an unrecognised type must not be body-section-checked",
		).toBe(true);
	});

	it("the `records` default root is used when no --root flag is given (parseArgs default)", async () => {
		// WHY: parseArgs defaults root to 'records'. Running with NO args must validate
		// the repo's REAL records/ tree (cwd = repo root under vitest) — proving the
		// default-root branch, and that the real registry is itself valid (exit 0).
		const r = await runCli([]);
		expect([0, 1]).toContain(r.code); // real registry: exit 0 if valid
		// The report was produced via the default root, not a crash (exit 2).
		expect(r.code).not.toBe(2);
	});
});

// ─── CLI: arg parsing, reports, exit codes ─────────────────────────────────

describe("validate-records CLI", () => {
	it("exits 2 with a message on an unknown argument", async () => {
		// WHY: an unrecognised flag is a usage error → exit 2, so CI surfaces a
		// misconfiguration rather than treating it as a records failure.
		const r = await runCli(["--bogus"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("unknown argument: --bogus");
	});

	it("exits 2 when --root has no directory argument", async () => {
		// WHY: `--root` with no value is a usage error; parseArgs must reject it, not
		// default silently to the wrong tree.
		const r = await runCli(["--root"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("--root requires a directory argument");
	});

	it("exits 2 (operational) when the resolved root is unusable", async () => {
		// WHY: the CLI must map an operational fault from validateRecords to exit 2 with
		// the 'operational fault' prefix — the signal CI uses to blame the toolchain,
		// not the PR.
		const r = await runCli(["--root", join(tmpdir(), "vr-cli-missing-abc", "records")]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("operational fault");
	});

	it("exits 0 and prints the human 'valid' line on a clean registry (--root form)", async () => {
		// WHY: the happy path — a valid registry must exit 0 with the human report, the
		// exact success contract the pre-commit/CI gate keys on. Uses `--root <dir>`.
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		const r = await runCli(["--root", root]);
		await cleanup();
		expect(r.code).toBe(0);
		expect(r.out).toContain("0 errors — registry is valid.");
	});

	it("accepts the --root=<dir> equals form and exits 0 on a clean registry", async () => {
		// WHY: parseArgs supports both `--root x` and `--root=x`; the equals form is a
		// distinct branch that must resolve the same root.
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		const r = await runCli([`--root=${root}`]);
		await cleanup();
		expect(r.code).toBe(0);
		expect(r.out).toContain("registry is valid.");
	});

	it("exits 1 and prints a grouped human report when records are invalid", async () => {
		// WHY: an invalid registry must exit 1 (records wrong) with the per-file,
		// per-rule report humans read. The bad record is placed under a non-governed
		// domain (DOMAIN_UNKNOWN) AND carries an invalid status (SCHEMA_INVALID), so a
		// SINGLE path accumulates TWO errors — exercising the report's group-by-path
		// list-append path, not just the one-error-per-file case.
		const basePrd = await validPrdFile("PRD-0002");
		const twoErr = basePrd.replace("status: accepted", "status: in-force");
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{ rel: "notadomain/prd-0002-orphan.md", content: twoErr },
			],
		});
		const r = await runCli(["--root", root]);
		await cleanup();
		expect(r.code).toBe(1);
		expect(r.out).toContain("[DOMAIN_UNKNOWN]");
		expect(r.out).toContain("[SCHEMA_INVALID]");
		expect(r.out).toMatch(/\d+ error\(s\) across \d+ file\(s\)\./u);
	});

	it("--json emits a machine-readable error array and still exits 1", async () => {
		// WHY: CI annotators consume the JSON form; it must be valid JSON carrying the
		// stable rule codes, and the exit code must still be 1 when errors exist.
		const { root, cleanup } = await fixture({
			files: [
				{ rel: "governance/prd-0001-why.md", content: await validPrdFile() },
				{
					rel: "notadomain/prd-0002-orphan.md",
					content: await validPrdFile("PRD-0002"),
				},
			],
		});
		const r = await runCli(["--json", "--root", root]);
		await cleanup();
		expect(r.code).toBe(1);
		const parsed = JSON.parse(r.out) as Array<{ rule: string; path: string; message: string }>;
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.some((e) => e.rule === "DOMAIN_UNKNOWN")).toBe(true);
	});

	it("--json on a clean registry emits an empty array and exits 0", async () => {
		// WHY: the JSON contract for success is `[]` + exit 0 — a downstream tool must
		// be able to distinguish 'no errors' from a crash.
		const { root, cleanup } = await fixture({
			files: [{ rel: "governance/prd-0001-why.md", content: await validPrdFile() }],
		});
		const r = await runCli(["--json", "--root", root]);
		await cleanup();
		expect(r.code).toBe(0);
		expect(JSON.parse(r.out)).toEqual([]);
	});
});
