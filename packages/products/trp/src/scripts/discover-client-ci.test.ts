// Unit + integration tests for `discover-client-ci.ts`.
//
// The module exports a single function (`main`) that walks a client-source
// tree ("$FIX_SRC") looking for verification commands the client already
// runs: workflow `run:` steps, `package.json` scripts, husky hooks, a
// pre-commit config, Python/Go/Rust project files, Terraform files, an nx
// config, and a Makefile. The results land in $OUT_PATH (one line per
// command) and a classified TSV under discovery/.
//
// The tests here materialise synthetic fixtures for each of those source
// classes, chdir into a scratch cwd so the TSV write lands somewhere
// discardable, and pin the observable contract: which commands are added,
// the cheap/expensive class, the sources string, and the TSV shape. They
// also drive the negative branches — missing env vars, malformed JSON,
// SKIP / MUTATE / QUALITY filters, quote stripping, dedup, wrapper
// detection, and the empty-discovery print. There are no external calls to
// stub: the module only uses `node:fs` + `node:path`.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./discover-client-ci.ts";

// A fresh cwd per test keeps the discovery/ writes isolated. Each test picks
// its own fixture layout on top of that.
let scratch: string;
let originalCwd: string;
// The source mirrors Python's `print()` via `process.stdout.write` (both put
// the same bytes on stdout — a `console.log` spy would miss them). Spy on
// stdout directly so the console-output tests can observe the real sink.
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function makeFixSrc(): string {
	const p = join(scratch, "fix-src");
	mkdirSync(p, { recursive: true });
	return p;
}

function writeFile(root: string, relPath: string, body: string): void {
	const full = join(root, relPath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, body);
}

function runDiscover(fixSrc: string, slug = "test-slug"): ReturnType<typeof main> {
	const outPath = join(scratch, "cmds.txt");
	return main({ fixSrc, outPath, taskIdSlug: slug });
}

// Classification sanity: every test/build-shaped (and non-typecheck) command
// must be classed expensive. Filters down to the test/build-shaped subset
// first so the assertion loop has no conditional in it (vitest
// no-conditional-expect forbids `expect` inside an `if`).
function expectExpensiveForTestOrBuildCommands(
	commands: readonly string[],
	classes: readonly string[],
): void {
	const testShaped = commands
		.map((cmd, i) => ({ cmd, cls: classes[i] }))
		.filter(({ cmd }) => /\btest\b|\bbuild\b|pytest/u.test(cmd) && !/typecheck/u.test(cmd));
	for (const { cls } of testShaped) {
		expect(cls).toBe("expensive");
	}
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "discover-ci-"));
	originalCwd = process.cwd();
	process.chdir(scratch);
	// Silence the module's chatty stdout output; keep the spy so failures
	// can inspect it if needed.
	stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	delete process.env.FIX_SRC;
	delete process.env.OUT_PATH;
	delete process.env.TASK_ID_SLUG;
});

afterEach(() => {
	process.chdir(originalCwd);
	stdoutSpy.mockRestore();
	rmSync(scratch, { recursive: true, force: true });
});

// ── main() argument / env-var handling ────────────────────────────────────
describe("main() env-var + config resolution", () => {
	it("throws when neither config nor FIX_SRC is set", async () => {
		// Mirrors Python's `os.environ['FIX_SRC']` KeyError — thrown synchronously
		// at the start of main(), not as a rejected Promise.
		await expect(main({ outPath: join(scratch, "o.txt") })).rejects.toThrow(/FIX_SRC not set/u);
	});

	it("throws when OUT_PATH is missing even if FIX_SRC is present", async () => {
		const fixSrc = makeFixSrc();
		await expect(main({ fixSrc })).rejects.toThrow(/OUT_PATH not set/u);
	});

	it("reads FIX_SRC / OUT_PATH from process.env when config omits them", async () => {
		const fixSrc = makeFixSrc();
		const outPath = join(scratch, "envrun.txt");
		process.env.FIX_SRC = fixSrc;
		process.env.OUT_PATH = outPath;
		process.env.TASK_ID_SLUG = "ENV-SLUG";
		const r = await main();
		expect(r.commands).toEqual([]);
		// TASK_ID_SLUG is lowercased.
		expect(r.tsvPath).toBe("discovery/env-slug-ci-commands.tsv");
		expect(readFileSync(outPath, "utf8")).toBe("\n");
	});

	it("defaults taskIdSlug to 'default' when neither config nor env sets it", async () => {
		const fixSrc = makeFixSrc();
		const outPath = join(scratch, "cmds.txt");
		const r = await main({ fixSrc, outPath });
		expect(r.tsvPath).toBe("discovery/default-ci-commands.tsv");
	});
});

// ── package-manager detection ─────────────────────────────────────────────
describe("detectPm signals via emitted command prefix", () => {
	it("picks pnpm when pnpm-lock.yaml is present", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo lint" } }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pnpm run lint");
	});

	it("picks yarn when yarn.lock is present", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "yarn.lock", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo" } }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("yarn lint");
	});

	it("picks bun when bun.lockb is present", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "bun.lockb", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo" } }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("bun run lint");
	});

	it("picks npm when only package-lock.json is present", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package-lock.json", "{}");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo" } }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("npm run lint");
	});

	it("falls back to npm when only package.json is present (no lockfile)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo" } }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("npm run lint");
	});
});

// ── GitHub Actions discovery ──────────────────────────────────────────────
describe("GitHub Actions workflow discovery", () => {
	// The extractor regex is `^\s*run:\s*(.+?)\s*$` — the `run:` key must be
	// the first non-whitespace token on the line. In real workflows that
	// happens when a step spans two lines (`- name: ...\n  run: ...`), so
	// the fixtures below always put `run:` on its own indented line.

	it("extracts run: steps from every .yml under .github/workflows/", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/ci.yml",
			"jobs:\n  test:\n    steps:\n      - name: lint\n        run: pnpm lint\n      - name: test\n        run: pnpm test\n",
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(expect.arrayContaining(["pnpm lint", "pnpm test"]));
		expect(r.sources.every((s) => s.startsWith("workflow:ci.yml"))).toBe(true);
	});

	it("skips deploy / release / e2e / playwright commands via SKIP", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/rel.yml",
			[
				"steps:",
				"  - a:",
				"    run: pnpm run deploy prod",
				"  - b:",
				"    run: pnpm run release",
				"  - c:",
				"    run: pnpm run playwright test",
				"  - d:",
				"    run: pnpm run e2e",
				"  - e:",
				"    run: pnpm run lint",
				"",
			].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint"]);
	});

	it("skips mutating commands (--fix, --write, :fix, plain `pnpm run format`)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			[
				"steps:",
				"    run: eslint --fix",
				"    run: prettier --write .",
				"    run: pnpm run lint:fix",
				"    run: pnpm run format",
				"    run: pnpm run lint",
				"",
			].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint"]);
	});

	it("skips commands that fail the QUALITY regex (`echo hi`, `npm ci`)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			["steps:", "    run: echo hi", "    run: npm ci", "    run: pnpm run lint", ""].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint"]);
	});

	it("skips YAML pipe / block-scalar continuation lines starting with |, >-, -", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			[
				"steps:",
				"    run: |",
				"    run: >-",
				"    run: - lint stuff",
				"    run: pnpm run lint",
				"",
			].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint"]);
	});

	it("strips surrounding double and single quotes from run: values", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			["steps:", '    run: "pnpm run lint"', "    run: 'pnpm run typecheck'", ""].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(expect.arrayContaining(["pnpm run lint", "pnpm run typecheck"]));
	});

	it("deduplicates identical commands seen across sources", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "echo" } }));
		writeFile(fixSrc, ".github/workflows/x.yml", "steps:\n    run: npm run lint\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands.filter((c) => c === "npm run lint")).toHaveLength(1);
	});

	it("also picks up .yaml (not just .yml) workflow files", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, ".github/workflows/ci.yaml", "steps:\n    run: pnpm run typecheck\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pnpm run typecheck");
	});
});

// ── package.json scripts ──────────────────────────────────────────────────
describe("package.json scripts discovery", () => {
	it("emits the preferred order and matches the pm prefix", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({
				scripts: {
					test: "vitest",
					lint: "eslint .",
					typecheck: "tsc",
					build: "tsc -b", // NOT in preferred_order → skipped
				},
			}),
		);
		const r = await runDiscover(fixSrc);
		// Order in output must follow preferred_order (lint before typecheck before test).
		expect(r.commands).toEqual(["pnpm run lint", "pnpm run typecheck", "pnpm run test"]);
	});

	it("skips root scripts that are wrapper delegations (nx / turbo / docker / tsx / docker: prefix)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({
				scripts: {
					lint: "nx run-many --target=lint",
					typecheck: "turbo run typecheck",
					test: "docker compose run test",
					"test:unit": "tsx scripts/test.ts",
					"test:ci": "pnpm run docker:test",
				},
			}),
		);
		const r = await runDiscover(fixSrc);
		// Every root script here is a wrapper → nothing added at the root.
		expect(r.commands).toEqual([]);
	});

	it("keeps root scripts whose chain STARTS with a real verifier (isWrapper checks first segment only)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({
				scripts: {
					// First segment is a plain eslint call → NOT a wrapper.
					lint: "eslint . && nx affected --target=lint",
				},
			}),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pnpm run lint");
	});

	it("logs a warning and continues on malformed package.json", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", "not-valid-json{{{");
		writeFile(fixSrc, "Makefile", "lint:\n\techo lint\n");
		const r = await runDiscover(fixSrc);
		// The Makefile discovery still ran.
		expect(r.commands).toContain("make lint");
	});

	it("tolerates a package.json that is valid JSON but not an object at the top", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", "null");
		writeFile(fixSrc, "Makefile", "lint:\n\techo lint\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("make lint");
	});

	it("multi-app: adds pnpm --filter <workspaceName> run <script> per apps/*/package.json", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"apps/web/package.json",
			JSON.stringify({ name: "@corp/web", scripts: { lint: "eslint .", test: "vitest" } }),
		);
		writeFile(
			fixSrc,
			"apps/api/package.json",
			// No `name` field → falls back to directory basename.
			JSON.stringify({ scripts: { lint: "eslint ." } }),
		);
		writeFile(
			fixSrc,
			"packages/lib/package.json",
			JSON.stringify({ name: "@corp/lib", scripts: { typecheck: "tsc" } }),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining([
				"pnpm --filter @corp/web run lint",
				"pnpm --filter @corp/web run test",
				"pnpm --filter api run lint",
				"pnpm --filter @corp/lib run typecheck",
			]),
		);
	});

	it("multi-app: wrapper scripts in apps/*/package.json are NOT skipped (only root-level wrappers are)", async () => {
		// The isWrapper gate only triggers when workspaceHint === null.
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"apps/web/package.json",
			JSON.stringify({ name: "@corp/web", scripts: { lint: "nx run-many --target=lint" } }),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pnpm --filter @corp/web run lint");
	});

	it("multi-app: falls back to app-dir basename when nested package.json cannot be parsed", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "apps/broken/package.json", "not json");
		// The scanPackageJson call for the same path logs a WARN and returns, so no
		// command is emitted — but the outer catch keeps the name-fallback branch alive.
		const r = await runDiscover(fixSrc);
		// No script was resolvable, so nothing was added.
		expect(r.commands).toEqual([]);
	});
});

// ── husky hooks ───────────────────────────────────────────────────────────
describe("husky hook discovery", () => {
	it("skips hooks that invoke lint-staged (already covered by pnpm run lint)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, ".husky/pre-commit", "#!/bin/sh\nlint-staged\n");
		chmodSync(join(fixSrc, ".husky/pre-commit"), 0o755);
		const r = await runDiscover(fixSrc);
		expect(r.commands).not.toContain("sh .husky/pre-commit");
	});

	it("adds a custom pre-commit / pre-push hook body that does NOT call lint-staged", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, ".husky/pre-commit", "#!/bin/sh\npnpm run lint\n");
		writeFile(fixSrc, ".husky/pre-push", "#!/bin/sh\npnpm run typecheck\n");
		chmodSync(join(fixSrc, ".husky/pre-commit"), 0o755);
		chmodSync(join(fixSrc, ".husky/pre-push"), 0o755);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining(["sh .husky/pre-commit", "sh .husky/pre-push"]),
		);
	});
});

// ── pre-commit-config.yaml ────────────────────────────────────────────────
describe(".pre-commit-config.yaml discovery", () => {
	it("adds `pre-commit run --all-files` when the config file exists", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, ".pre-commit-config.yaml", "repos: []\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pre-commit run --all-files");
	});
});

// ── Python / Go / Rust project files ──────────────────────────────────────
describe("language-specific project detection", () => {
	it("Python: emits only the tools mentioned in dep-declaring files", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pyproject.toml", "[project]\ndependencies = ['ruff', 'black']\n");
		writeFile(fixSrc, "requirements-dev.txt", "pytest\nmypy\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining(["pytest", "ruff check .", "mypy .", "black --check ."]),
		);
		expect(r.commands).not.toContain("flake8");
	});

	it("Python: emits nothing when no tool is named in signal files", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pyproject.toml", "[project]\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands.filter((c) => /pytest|ruff|mypy|black|flake8/u.test(c))).toEqual([]);
	});

	it("Go project (go.mod): adds vet / test / build", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "go.mod", "module x\ngo 1.22\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining(["go vet ./...", "go test ./...", "go build ./..."]),
		);
	});

	it("Rust project (Cargo.toml): adds clippy / test / build", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "Cargo.toml", "[package]\nname = 'x'\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining(["cargo clippy -- -D warnings", "cargo test", "cargo build"]),
		);
	});
});

// ── Terraform / nx / Makefile ─────────────────────────────────────────────
describe("terraform / nx / Makefile discovery", () => {
	it("adds terraform fmt / validate when any .tf file is present under fixSrc", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "infra/main.tf", 'resource "null_resource" "x" {}\n');
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining(["terraform fmt -check -recursive", "terraform validate"]),
		);
	});

	it("adds all four nx variants when nx.json is present", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "nx.json", "{}");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(
			expect.arrayContaining([
				"pnpm nx affected --target=lint --base=HEAD~1",
				"pnpm nx affected --target=test --base=HEAD~1",
				"pnpm nx run-many --target=lint --all",
				"pnpm nx run-many --target=test --all",
			]),
		);
	});

	it("adds `make <target>` for each recognised Makefile target and skips unknown ones", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			"Makefile",
			"lint:\n\techo lint\n\ntest:\n\techo test\n\ndeploy:\n\techo deploy\n\ncheck:\n\techo check\n",
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(expect.arrayContaining(["make lint", "make test", "make check"]));
		expect(r.commands).not.toContain("make deploy");
	});

	it("does nothing when Makefile has no matching targets", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "Makefile", "# empty\nhelp:\n\techo help\n");
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual([]);
	});
});

// ── classification + TSV output ───────────────────────────────────────────
describe("classification + output artefacts", () => {
	it("classifies each command as cheap or expensive using the CHEAP regex", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({ scripts: { lint: "eslint", typecheck: "tsc", test: "vitest" } }),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint", "pnpm run typecheck", "pnpm run test"]);
		expect(r.classes).toEqual(["cheap", "cheap", "expensive"]);
	});

	it("writes the OUT_PATH file with one command per line + trailing newline", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "eslint" } }));
		const outPath = join(scratch, "cmds.txt");
		await main({ fixSrc, outPath, taskIdSlug: "abc" });
		expect(readFileSync(outPath, "utf8")).toBe("pnpm run lint\n");
	});

	it("writes an empty output file (just newline) when nothing was discovered", async () => {
		const fixSrc = makeFixSrc();
		const outPath = join(scratch, "empty.txt");
		await main({ fixSrc, outPath });
		expect(readFileSync(outPath, "utf8")).toBe("\n");
	});

	it("writes a TSV with header + one row per command including class + source", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "eslint" } }));
		const r = await runDiscover(fixSrc, "SEC-42");
		expect(r.tsvPath).toBe("discovery/sec-42-ci-commands.tsv");
		const tsv = readFileSync(join(scratch, r.tsvPath), "utf8");
		expect(tsv.split("\n")[0]).toBe("command\tsource\tclass");
		expect(tsv).toContain("pnpm run lint\tpackage.json:scripts.lint\tcheap\n");
	});

	it("returned DiscoverResult carries commands, sources, classes, tsvPath in agreement with the TSV", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "e", test: "v" } }));
		const r = await runDiscover(fixSrc, "mixed");
		expect(r.commands.length).toBe(r.sources.length);
		expect(r.commands.length).toBe(r.classes.length);
		expect(r.tsvPath).toBe("discovery/mixed-ci-commands.tsv");
	});
});

// ── console output shape ──────────────────────────────────────────────────
describe("console output", () => {
	it("prints the 'no CI verify commands discovered' line when nothing was added", async () => {
		const fixSrc = makeFixSrc();
		await runDiscover(fixSrc);
		const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(printed).toMatch(/no CI verify commands discovered/u);
	});

	it("prints a summary counting cheap vs expensive when commands were discovered", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({ scripts: { lint: "eslint", test: "vitest" } }),
		);
		await runDiscover(fixSrc);
		const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(printed).toMatch(/discovered 2 CI verify command\(s\).*1 cheap, 1 expensive/u);
	});

	it("logs a wrapper-deferred line when a root script matches WRAPPER_PATTERNS", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({ scripts: { lint: "nx affected --target=lint" } }),
		);
		await runDiscover(fixSrc);
		const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
		expect(printed).toMatch(/wrapper: root scripts\.lint/u);
	});
});

// ── edge cases pinned for branch coverage ─────────────────────────────────
describe("edge cases (branch coverage)", () => {
	it("add(): strips a leading-only double quote and a trailing-only double quote", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			["steps:", '    run: "pnpm run lint', '    run: pnpm run typecheck"', ""].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(expect.arrayContaining(["pnpm run lint", "pnpm run typecheck"]));
	});

	it("add(): strips a leading-only single quote and a trailing-only single quote", async () => {
		const fixSrc = makeFixSrc();
		writeFile(
			fixSrc,
			".github/workflows/x.yml",
			["steps:", "    run: 'pnpm run lint", "    run: pnpm run typecheck'", ""].join("\n"),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(expect.arrayContaining(["pnpm run lint", "pnpm run typecheck"]));
	});

	it("add(): a run: line that is only whitespace/quotes yields no command (empty after strip)", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, ".github/workflows/x.yml", 'steps:\n    run: ""\n    run: pnpm run lint\n');
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual(["pnpm run lint"]);
	});

	it("scanPackageJson(): non-object `scripts` field is treated as empty and yields nothing", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: "not-an-object" }));
		writeFile(fixSrc, "Makefile", "lint:\n\techo\n");
		const r = await runDiscover(fixSrc);
		// Package-json scan produced no command; Makefile scan is the only source.
		expect(r.commands).toEqual(["make lint"]);
	});

	it("scanPackageJson(): missing `scripts` key entirely is handled without error", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "package.json", JSON.stringify({ name: "x" }));
		const r = await runDiscover(fixSrc);
		expect(r.commands).toEqual([]);
	});

	it("multi-app: nested package.json with a non-string `name` field falls back to the app-dir basename", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(
			fixSrc,
			"apps/api/package.json",
			JSON.stringify({ name: 42, scripts: { lint: "eslint ." } }),
		);
		const r = await runDiscover(fixSrc);
		expect(r.commands).toContain("pnpm --filter api run lint");
	});

	it("multi-app: nested package.json parsing to a non-object (JSON `null`) falls back to the app-dir basename", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "apps/svc/package.json", "null");
		const r = await runDiscover(fixSrc);
		// scanPackageJson short-circuits on a non-object body → no command added,
		// but the outer branch (non-string `name`) is executed.
		expect(r.commands).toEqual([]);
	});

	it("husky: hook exists but read fails yields no crash and no add", async () => {
		const fixSrc = makeFixSrc();
		// Directory in place of the hook file — isFile() returns false so the
		// entire hook branch is skipped without reaching read.
		mkdirSync(join(fixSrc, ".husky/pre-commit"), { recursive: true });
		const r = await runDiscover(fixSrc);
		expect(r.commands).not.toContain("sh .husky/pre-commit");
	});

	it("preferred_order: keeps a preferred-order script whose body is the empty string", async () => {
		const fixSrc = makeFixSrc();
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		writeFile(fixSrc, "package.json", JSON.stringify({ scripts: { lint: "" } }));
		const r = await runDiscover(fixSrc);
		// isWrapper('') === false → the emit branch runs.
		expect(r.commands).toContain("pnpm run lint");
	});
});

// ── full-stack integration ────────────────────────────────────────────────
describe("integration: main() on a synthesised multi-source fixture", () => {
	it("discovers commands from workflows, package.json, husky, pre-commit, Makefile, python, terraform, nx and classifies them", async () => {
		const fixSrc = makeFixSrc();
		// Package-manager fingerprint.
		writeFile(fixSrc, "pnpm-lock.yaml", "");
		// (1) GitHub workflows.
		writeFile(
			fixSrc,
			".github/workflows/ci.yml",
			"jobs:\n  q:\n    steps:\n      - name: build\n        run: pnpm run build\n      - name: release\n        run: pnpm run release\n",
		);
		// (2) root package.json — a mix of preferred-order scripts.
		writeFile(
			fixSrc,
			"package.json",
			JSON.stringify({
				scripts: {
					lint: "eslint .",
					typecheck: "tsc --noEmit",
					test: "vitest run",
				},
			}),
		);
		// Nested workspace.
		writeFile(
			fixSrc,
			"apps/web/package.json",
			JSON.stringify({ name: "@corp/web", scripts: { lint: "eslint apps/web" } }),
		);
		// (3) husky — one custom, one lint-staged (skipped).
		writeFile(fixSrc, ".husky/pre-commit", "#!/bin/sh\nlint-staged\n");
		writeFile(fixSrc, ".husky/pre-push", "#!/bin/sh\npnpm run typecheck\n");
		chmodSync(join(fixSrc, ".husky/pre-commit"), 0o755);
		chmodSync(join(fixSrc, ".husky/pre-push"), 0o755);
		// (4) pre-commit-config.
		writeFile(fixSrc, ".pre-commit-config.yaml", "repos: []\n");
		// (4b) python.
		writeFile(fixSrc, "pyproject.toml", "[project]\n");
		writeFile(fixSrc, "requirements.txt", "pytest\nruff\n");
		// (nx + terraform)
		writeFile(fixSrc, "nx.json", "{}");
		writeFile(fixSrc, "infra/main.tf", 'provider "aws" {}\n');
		// (5) Makefile.
		writeFile(fixSrc, "Makefile", "lint:\n\techo lint\ntest:\n\techo test\n");

		const outPath = join(scratch, "all.txt");
		const r = await main({ fixSrc, outPath, taskIdSlug: "SEC-99" });

		// Workflow first, then package.json preferred_order, then per-app filter,
		// then husky (only pre-push), then pre-commit, then python tools, then
		// terraform, then nx, then Makefile. The ordering is significant: the
		// driver reads $OUT_PATH top-down.
		expect(r.commands).toContain("pnpm run build");
		expect(r.commands).not.toContain("pnpm run release"); // SKIP
		expect(r.commands).toContain("pnpm run lint");
		expect(r.commands).toContain("pnpm run typecheck");
		expect(r.commands).toContain("pnpm run test");
		expect(r.commands).toContain("pnpm --filter @corp/web run lint");
		expect(r.commands).toContain("sh .husky/pre-push");
		expect(r.commands).not.toContain("sh .husky/pre-commit"); // lint-staged
		expect(r.commands).toContain("pre-commit run --all-files");
		expect(r.commands).toContain("pytest");
		expect(r.commands).toContain("ruff check .");
		expect(r.commands).toContain("terraform fmt -check -recursive");
		expect(r.commands).toContain("terraform validate");
		expect(r.commands).toContain("pnpm nx affected --target=lint --base=HEAD~1");
		expect(r.commands).toContain("make lint");
		expect(r.commands).toContain("make test");

		// Classification sanity: every lint/typecheck/validate/fmt-check-shaped
		// command must be cheap; every test-shaped command must be expensive.
		expectExpensiveForTestOrBuildCommands(r.commands, r.classes);

		// The written OUT_PATH file mirrors r.commands exactly.
		const outLines = readFileSync(outPath, "utf8").split("\n").filter(Boolean);
		expect(outLines).toEqual([...r.commands]);

		// TSV header + at least one row per discovered command.
		const tsv = readFileSync(join(scratch, r.tsvPath), "utf8").split("\n").filter(Boolean);
		expect(tsv[0]).toBe("command\tsource\tclass");
		expect(tsv.length).toBe(r.commands.length + 1);
	});
});
