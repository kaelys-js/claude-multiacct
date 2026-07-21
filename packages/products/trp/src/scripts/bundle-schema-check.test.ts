// Behaviour tests for `bundle-schema-check.ts` (the TS port of the SRP-X
// Python detector). The only exported surface is `main()`; every parse
// branch and every finding shape is reached through it. Tests write a
// throwaway bundle + schema tree to a per-test tempdir, chdir into it so
// the module's relative `discovery/…` write lands in scratch space, and
// spy on `process.stdout.write` to assert the operator-visible lines.
//
// No live IO -- no network, no @foundation/shell subprocess. The module
// only touches `node:fs` + env + stdout, all of which are stubbable in
// place.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bundle-schema-check.ts";

const HERE = import.meta.dirname;
const TS_SCRIPT = resolve(HERE, "bundle-schema-check.ts");
const SAFE_PATH = process.env.PATH ?? "";

// Build a tempdir with a pre-created `discovery/` sink, chdir into it so
// the module's relative report write goes here. Returned so tests can
// nest fixtures underneath.
function scratchCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "bundle-schema-check-"));
	mkdirSync(join(dir, "discovery"));
	return dir;
}

// Write a schema fixture at `subpath` relative to `root`, mkdir-p'ing its
// parent so tests can drop schemas anywhere under a nested `prisma/`
// tree without a lot of setup ceremony.
function writeSchema(root: string, subpath: string, contents: string): void {
	const full = join(root, subpath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

// Serialise a bundle and return the path -- callers hand that path to
// BUNDLE_JSON. The module reads with `JSON.parse` and expects a
// `files_to_modify` array; we accept `unknown` so tests can also poke at
// malformed shapes.
function writeBundle(root: string, bundle: unknown): string {
	const path = join(root, "bundle.json");
	writeFileSync(path, JSON.stringify(bundle));
	return path;
}

describe("bundle-schema-check main()", () => {
	let prevCwd: string;
	let scratch: string;
	let stdout: string;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		prevCwd = process.cwd();
		scratch = scratchCwd();
		process.chdir(scratch);
		stdout = "";
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
		) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stdout.write);
		delete process.env.BUNDLE_JSON;
		delete process.env.FIX_SRC;
		delete process.env.TASK_ID_SLUG;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		process.chdir(prevCwd);
		rmSync(scratch, { recursive: true, force: true });
		delete process.env.BUNDLE_JSON;
		delete process.env.FIX_SRC;
		delete process.env.TASK_ID_SLUG;
	});

	// ----- env-var gate ---------------------------------------------------

	it("throws when BUNDLE_JSON is unset", async () => {
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-01";
		await expect(main()).rejects.toThrow(/BUNDLE_JSON, FIX_SRC, TASK_ID_SLUG/u);
	});

	it("throws when FIX_SRC is unset", async () => {
		process.env.BUNDLE_JSON = join(scratch, "b.json");
		process.env.TASK_ID_SLUG = "sec-01";
		await expect(main()).rejects.toThrow(/BUNDLE_JSON, FIX_SRC, TASK_ID_SLUG/u);
	});

	it("throws when TASK_ID_SLUG is unset", async () => {
		process.env.BUNDLE_JSON = join(scratch, "b.json");
		process.env.FIX_SRC = scratch;
		await expect(main()).rejects.toThrow(/BUNDLE_JSON, FIX_SRC, TASK_ID_SLUG/u);
	});

	// ----- schema discovery skip paths -----------------------------------

	it("returns 0 and prints skip message when no schema.prisma is found", async () => {
		// The fix-src root exists but contains no `schema.prisma` at any depth.
		writeSchema(scratch, "src/foo.ts", "// not a schema");
		process.env.BUNDLE_JSON = writeBundle(scratch, { files_to_modify: [] });
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-01";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("no prisma schemas found");
	});

	it("returns 0 when FIX_SRC does not exist (readdir throws)", async () => {
		// findSchemaFiles wraps readdirSync in try/catch — a bogus root
		// yields zero schemas, not an unhandled exception.
		process.env.BUNDLE_JSON = writeBundle(scratch, { files_to_modify: [] });
		process.env.FIX_SRC = join(scratch, "does-not-exist");
		process.env.TASK_ID_SLUG = "sec-01";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("no prisma schemas found");
	});

	it("returns 0 when schema.prisma has no model blocks", async () => {
		// A schema that is comments + generator only parses to zero models.
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			'// generator only\ngenerator client { provider = "prisma-client-js" }\n',
		);
		process.env.BUNDLE_JSON = writeBundle(scratch, { files_to_modify: [] });
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-01";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("prisma schemas found but no models parsed");
	});

	// ----- happy path: PASS ----------------------------------------------

	it("returns 0 PASS with empty files_to_modify against a real schema", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		process.env.BUNDLE_JSON = writeBundle(scratch, { files_to_modify: [] });
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-99";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("SRP-X prisma check: PASS");
		expect(stdout).toContain("1 models scanned");
	});

	it("returns 0 PASS when prisma access uses only known models + fields", async () => {
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			"model User {\n  id   String @id\n  name String\n}\n",
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/known.ts",
					full_content:
						'const u = await prisma.user.findFirst({ where: { id: "x", name: "y" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-02";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	// ----- missing model / missing field findings ------------------------

	it("returns 5 with a missing-prisma-model finding for an unknown model", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [
				{
					path: "src/ghost.ts",
					full_content: 'await prisma.ghost.findFirst({ where: { id: "x" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-03";
		const code = await main();
		expect(code).toBe(5);

		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-03.json"), "utf8"),
		) as {
			findings: Array<{ kind: string; severity: string; summary: string }>;
			models_scanned: string[];
		};
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.kind).toBe("missing-prisma-model");
		expect(report.findings[0]!.severity).toBe("high");
		expect(report.findings[0]!.summary).toContain("Ghost");
		expect(report.models_scanned).toEqual(["User"]);
		expect(stdout).toContain("[HIGH]");
		expect(stdout).toContain("src/ghost.ts");
	});

	it("returns 5 with a missing-prisma-field finding for an undeclared field", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model InternalUser {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [
				{
					path: "src/entra.ts",
					full_content: 'await prisma.internalUser.findFirst({ where: { entraOid: "abc" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-04";
		const code = await main();
		expect(code).toBe(5);

		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-04.json"), "utf8"),
		) as { findings: Array<{ kind: string; summary: string; severity: string }> };
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.kind).toBe("missing-prisma-field");
		expect(report.findings[0]!.summary).toContain("InternalUser.entraOid");
		expect(report.findings[0]!.severity).toBe("high");
	});

	it("skips prisma operator keywords in the where clause", async () => {
		// Where body contains OR / AND / contains / mode / not -- all of
		// which live in the PRISMA_KEYWORDS allow-list and MUST NOT surface
		// as missing-field findings even though the schema doesn't declare
		// them. `id` and `name` are real fields so they pass.
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			"model User {\n  id   String @id\n  name String\n}\n",
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/ops.ts",
					full_content:
						'await prisma.user.findFirst({ where: { OR: 1, AND: 2, NOT: 3, contains: "x", mode: "insensitive", id: "y", name: "z" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-kw";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	// ----- raw SQL -------------------------------------------------------

	it("passes when raw $queryRaw table name maps to a known model via pascal + strip-s", async () => {
		// SQL `FROM users` -> strip trailing 's' -> "user" -> PascalCase
		// "User" -- must match the declared model, so no finding.
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [
				{
					path: "src/raw-ok.ts",
					full_content: "await prisma.$queryRaw`SELECT id FROM users WHERE id = 1`;\n",
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-raw-ok";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	it("flags raw SQL that references a table with no matching Prisma model", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [
				{
					path: "src/raw-bad.ts",
					full_content:
						"await prisma.$executeRawUnsafe(SELECT * FROM ghost_records JOIN spirits);\n",
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-raw-bad";
		const code = await main();
		expect(code).toBe(5);

		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-raw-bad.json"), "utf8"),
		) as { findings: Array<{ kind: string; severity: string; summary: string }> };
		// Two identifiers extracted: `ghost_records` (FROM) + `spirits` (JOIN).
		expect(report.findings.length).toBeGreaterThanOrEqual(2);
		const kinds = report.findings.map((f) => f.kind);
		expect(kinds.every((k) => k === "raw-sql-unknown-table")).toBe(true);
		expect(report.findings.every((f) => f.severity === "medium")).toBe(true);
		const summaries = report.findings.map((f) => f.summary).join("\n");
		expect(summaries).toContain("ghost_records");
		expect(summaries).toContain("spirits");
		expect(stdout).toContain("[MEDIUM]");
	});

	it("PascalCase conversion handles tables that do not end in 's' and tables with empty split segments", async () => {
		// Two branches of the pascal-cased-table synthesis:
		//   * `table.endsWith("s") ? slice(0,-1) : table` — false branch:
		//     `product_data` has no trailing `s`, so `stripped === table`.
		//   * `w.length > 0 ? capitalize : w` — false branch: `_leading_snake`
		//     splits into `["", "leading", "snake"]`; the leading empty segment
		//     goes through the ternary's else arm unchanged.
		// The schema declares both PascalCase forms so no findings surface --
		// this test is a branch-hitter, not a defect exercise.
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			[
				"model ProductData {",
				"  id String @id",
				"}",
				"model LeadingSnake {",
				"  id String @id",
				"}",
				"",
			].join("\n"),
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/raw-branches.ts",
					full_content: [
						"await prisma.$queryRaw`SELECT * FROM product_data`;",
						"await prisma.$queryRaw`SELECT * FROM _leading_snake`;",
					].join("\n"),
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-pascal";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	// ----- entry-level skips + edge shapes -------------------------------

	it("skips entries whose full_content is empty or undefined", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [{ path: "src/empty.ts", full_content: "" }, { path: "src/no-content.ts" }],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-skip";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	it("does not treat @@-attribute lines or // comments as fields", async () => {
		// If the parser mistook `@@index` for a field then a bundle
		// referencing an actual field would pass but a lookup for `index`
		// would incorrectly succeed -- and worse, real fields on the same
		// line would be double-parsed. Prove: an unknown field still fires
		// even though the schema is full of attribute/comment noise.
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			[
				"model User {",
				"  // leading comment",
				"  id String @id",
				"  @@index([id])",
				'  @@map("users")',
				"}",
				"",
			].join("\n"),
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/probe.ts",
					full_content: 'await prisma.user.findFirst({ where: { indexField: "x" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-attr";
		const code = await main();
		expect(code).toBe(5);
		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-attr.json"), "utf8"),
		) as { findings: Array<{ kind: string; summary: string }> };
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]!.summary).toContain("indexField");
	});

	it("handles nested braces inside a model block via depth counter", async () => {
		// A default value containing `{}` bumps and un-bumps the brace
		// counter; if depth-tracking is wrong, the model block truncates
		// early and the `keyField` we reference below WOULD read as unknown.
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			[
				"model Cfg {",
				"  id       String @id",
				'  payload  Json   @default("{}")',
				"  keyField String",
				"}",
				"",
			].join("\n"),
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/cfg.ts",
					full_content: 'await prisma.cfg.findFirst({ where: { keyField: "x" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-brace";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	it("merges fields from multiple schema.prisma files under the fix-src tree", async () => {
		// Two schemas, same model, disjoint fields. A reference to the
		// second schema's field must succeed once the parser has visited
		// both files (the setdefault(...).update(...) equivalent).
		writeSchema(scratch, "apps/api/prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		writeSchema(
			scratch,
			"apps/worker/prisma/schema.prisma",
			"model User {\n  extraField String\n}\n",
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/merge.ts",
					full_content: 'await prisma.user.findFirst({ where: { extraField: "x" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-merge";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	it("emits multiple findings and lists all severities in the trailer", async () => {
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundle = {
			files_to_modify: [
				{
					path: "src/multi.ts",
					full_content: [
						'await prisma.ghost.findFirst({ where: { id: "x" } });',
						"await prisma.$queryRaw`SELECT * FROM ghosts`;",
					].join("\n"),
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-multi";
		const code = await main();
		expect(code).toBe(5);
		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-multi.json"), "utf8"),
		) as { findings: Array<{ kind: string }> };
		const kinds = new Set(report.findings.map((f) => f.kind));
		expect(kinds.has("missing-prisma-model")).toBe(true);
		expect(kinds.has("raw-sql-unknown-table")).toBe(true);
		// Trailer lists every finding.
		expect(stdout).toMatch(/finding\(s\)/u);
		expect(stdout).toContain("src/multi.ts");
	});

	// ----- integration: end-to-end trailer format ------------------------

	// ----- filesystem edge: unreadable entry --------------------------------

	it("skips filesystem entries whose stat() throws (broken symlink)", async () => {
		// Drop a symlink pointing at nothing under the fix-src tree. The
		// walker readdirs it fine but statSync throws ENOENT -- the module's
		// try/catch continues to the next entry rather than crashing the run.
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		symlinkSync("/does-not-exist-target", join(scratch, "prisma/broken-link"));
		process.env.BUNDLE_JSON = writeBundle(scratch, { files_to_modify: [] });
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-sym";
		const code = await main();
		expect(code).toBe(0);
		expect(stdout).toContain("PASS");
	});

	// ----- CLI-invoked branch (invokedDirectly) ---------------------------

	it("CLI: prints PASS and exits 0 when invoked directly on a clean bundle", () => {
		// Cover the `invokedDirectly` block (main().then(exit)) that a
		// programmatic `import { main }` skips. Runs the .ts file under
		// node's native type-stripping.
		writeSchema(scratch, "prisma/schema.prisma", "model User {\n  id String @id\n}\n");
		const bundlePath = writeBundle(scratch, { files_to_modify: [] });
		const res = spawnSync("node", [TS_SCRIPT], {
			cwd: scratch,
			env: {
				...process.env,
				BUNDLE_JSON: bundlePath,
				FIX_SRC: scratch,
				TASK_ID_SLUG: "sec-cli-ok",
			},
			encoding: "utf8",
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("PASS");
	});

	it("CLI: exits 1 and prints the throw message when env vars are missing", () => {
		// Cover the .catch(err => stderr + exit(1)) tail of the CLI block.
		const res = spawnSync("node", [TS_SCRIPT], {
			cwd: scratch,
			env: {
				// Deliberately strip the three required env vars.
				PATH: SAFE_PATH,
			},
			encoding: "utf8",
		});
		expect(res.status).toBe(1);
		expect(res.stderr).toContain("BUNDLE_JSON, FIX_SRC, TASK_ID_SLUG");
	});

	it("writes the report to `discovery/bundle-schema-<slug>.json` with models_scanned", async () => {
		writeSchema(
			scratch,
			"prisma/schema.prisma",
			"model User {\n  id String @id\n}\nmodel Post {\n  id String @id\n}\n",
		);
		const bundle = {
			files_to_modify: [
				{
					path: "src/bad.ts",
					full_content: 'await prisma.ghost.findFirst({ where: { id: "x" } });\n',
				},
			],
		};
		process.env.BUNDLE_JSON = writeBundle(scratch, bundle);
		process.env.FIX_SRC = scratch;
		process.env.TASK_ID_SLUG = "sec-report";
		const code = await main();
		expect(code).toBe(5);
		const report = JSON.parse(
			readFileSync(join(scratch, "discovery/bundle-schema-sec-report.json"), "utf8"),
		) as { models_scanned: string[]; findings: unknown[] };
		expect(report.models_scanned.toSorted()).toEqual(["Post", "User"]);
		expect(report.findings.length).toBeGreaterThan(0);
		expect(stdout).toContain("discovery/bundle-schema-sec-report.json");
	});
});
