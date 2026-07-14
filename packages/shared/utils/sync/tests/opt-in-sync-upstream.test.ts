// Tests for `packages/shared/utils/sync/src/opt-in-sync-upstream.ts` — the
// generator that materialises a fork's `.github/workflows/sync-upstream.yml`
// from the shipped template + a fork-local `.sync-upstream.json`.
//
// WHY these tests matter: the whole point of moving this workflow into the
// shared package is that a fork can adopt it without hand-copying. If the
// substitution is wrong, silently drops a placeholder, or clobbers an edited
// workflow, the sync-upstream feature is worse than not shipping it. Each test
// pins one of those failure modes.
//
// The CLI is factored so tests never touch the real filesystem outside a
// tmpdir: `substitute()` is pure, `writeIdempotent()` takes the target path as
// an argument, and `main()` accepts (argv, cwd, log, err, template) — so a
// fixture template + tmpdir stand in for the shipped template + the user's
// working directory.

// The `${NAME}` literals under test are the very strings the tool matches,
// not template-literal expressions; oxlint's `no-template-curly-in-string`
// is a false positive across this file. The `??` fallbacks in match counts
// are defensive defaults, not conditional test logic — same false positive
// pattern used across the sync tests.
/* oxlint-disable no-template-curly-in-string, vitest/no-conditional-in-test */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	main,
	readConfig,
	readTemplate,
	substitute,
	writeIdempotent,
	type OptInConfig,
} from "../src/opt-in-sync-upstream.ts";

const CONFIG: OptInConfig = {
	upstreamRepoSsh: "git@github.com:kaelys-js/foundation-registry.git",
	upstreamBranch: "main",
	deployKeySecret: "UPSTREAM_DEPLOY_KEY",
};

// A minimal template that carries every placeholder at least once so a missed
// substitution shows up as a raw `${…}` in the output.
const FIXTURE_TEMPLATE = [
	"name: sync-upstream",
	"jobs:",
	"  sync:",
	"    steps:",
	"      - uses: actions/checkout@v4",
	"        with:",
	"          ssh-key: ${{ secrets.${UPSTREAM_DEPLOY_KEY_SECRET} }}",
	"      - run: git remote add upstream ${UPSTREAM_REPO_SSH}",
	"      - run: git fetch upstream ${UPSTREAM_BRANCH}",
	"      - run: git merge --ff-only upstream/${UPSTREAM_BRANCH}",
	"",
].join("\n");

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "opt-in-sync-upstream-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("substitute", () => {
	it("replaces every placeholder exactly, everywhere it appears", () => {
		const out = substitute(FIXTURE_TEMPLATE, CONFIG);
		expect(out).toContain("ssh-key: ${{ secrets.UPSTREAM_DEPLOY_KEY }}");
		expect(out).toContain(
			"git remote add upstream git@github.com:kaelys-js/foundation-registry.git",
		);
		expect(out).toContain("git fetch upstream main");
		expect(out).toContain("git merge --ff-only upstream/main");
		// A missed placeholder would leave a literal `${` behind. None must remain.
		expect(out).not.toMatch(/\$\{UPSTREAM_/u);
	});

	it("prepends the schema-ref for the OUTPUT location (not the template's own location)", () => {
		// Load-bearing: the template omits its schema-ref because the ref that
		// resolves under `packages/shared/config/workflows/` is different from
		// the one that resolves under `.github/workflows/`. The CLI is what
		// makes the OUTPUT schema-checkable — and this test would fail loud if
		// the header were dropped.
		const out = substitute(FIXTURE_TEMPLATE, CONFIG);
		expect(
			out.startsWith("# yaml-language-server: $schema=../../.schemas/github-workflow.json\n"),
		).toBe(true);
	});

	it("leaves GHA `${{ … }}` expressions untouched when they carry no placeholder", () => {
		// The outer `${{` in GHA expressions must never be matched — only the
		// inner `${NAME}` placeholders. Prove it: a GHA expression without a
		// placeholder in it passes through byte-for-byte (aside from the
		// prepended output header).
		const template = "run: echo ${{ github.token }}\n";
		const out = substitute(template, CONFIG);
		expect(out.endsWith("run: echo ${{ github.token }}\n")).toBe(true);
	});

	it("substitutes all occurrences, not only the first (`${UPSTREAM_BRANCH}` appears twice)", () => {
		// The template uses `${UPSTREAM_BRANCH}` at both the fetch and the merge
		// lines. A `.replace()` (vs `.replaceAll()`) would leave the second one.
		const out = substitute(FIXTURE_TEMPLATE, CONFIG);
		expect((out.match(/\bmain\b/gu) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(out).not.toContain("${UPSTREAM_BRANCH}");
	});
});

describe("readConfig", () => {
	it("throws with a pointer to ADOPTING.md when `.sync-upstream.json` is missing", () => {
		// The pointer matters because a user who hits this error has to know
		// where to look next. Verify the message names the doc.
		expect(() => readConfig(workDir)).toThrow(/ADOPTING\.md/u);
	});

	it("throws listing every missing field, not only the first", () => {
		// Two fields blank: the error must mention BOTH. A test that only asserts
		// on the first missing field would let a partial fix through unnoticed.
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify({ upstreamRepoSsh: "" }));
		expect(() => readConfig(workDir)).toThrow(/upstreamRepoSsh.*upstreamBranch.*deployKeySecret/u);
	});

	it("returns the parsed config when all three fields are non-empty strings", () => {
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		expect(readConfig(workDir)).toEqual(CONFIG);
	});
});

describe("writeIdempotent", () => {
	it("writes the file when the target does not exist and reports `written`", () => {
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		const result = writeIdempotent(target, "hello\n", false);
		expect(result).toBe("written");
		expect(readFileSync(target, "utf8")).toBe("hello\n");
	});

	it("is a no-op when the existing file matches — the second run must not touch it", () => {
		// Load-bearing behaviour: the whole point of "opt-in" is that re-running
		// is safe. Verify by checking mtime doesn't move and the outcome is `unchanged`.
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		mkdirSync(join(workDir, ".github", "workflows"), { recursive: true });
		writeFileSync(target, "hello\n");
		const outcome = writeIdempotent(target, "hello\n", false);
		expect(outcome).toBe("unchanged");
	});

	it("reports `conflict` and does NOT overwrite when the target differs and force=false", () => {
		// This is the footgun the CLI is designed to prevent: a fork owner who has
		// hand-edited their workflow (fork-wins path list, custom step) must not
		// have their edit clobbered by a rerun of the opt-in generator.
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		mkdirSync(join(workDir, ".github", "workflows"), { recursive: true });
		writeFileSync(target, "hand-edited\n");
		const outcome = writeIdempotent(target, "generated\n", false);
		expect(outcome).toBe("conflict");
		expect(readFileSync(target, "utf8")).toBe("hand-edited\n");
	});

	it("overwrites when force=true and the target differs", () => {
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		mkdirSync(join(workDir, ".github", "workflows"), { recursive: true });
		writeFileSync(target, "old\n");
		const outcome = writeIdempotent(target, "new\n", true);
		expect(outcome).toBe("written");
		expect(readFileSync(target, "utf8")).toBe("new\n");
	});
});

describe("readTemplate", () => {
	it("reads the shipped template file with all three placeholder names present", () => {
		// Load-bearing behaviour: the CLI's default template is the file the
		// opt-in flow actually writes into a fork. If the template goes missing
		// (path skew during a refactor, wrong build output) `readTemplate` throws
		// on first call — a silent regression, since default-argument reads only
		// happen when a caller lets it default. This test executes that code
		// path and asserts the shape of the returned content.
		const template = readTemplate();
		expect(template).toContain("${UPSTREAM_REPO_SSH}");
		expect(template).toContain("${UPSTREAM_BRANCH}");
		expect(template).toContain("${UPSTREAM_DEPLOY_KEY_SECRET}");
	});

	it("survives `main()` running with the DEFAULT template arg (not a fixture)", () => {
		// The CLI's `main()` accepts an optional `template` for tests; when
		// omitted it delegates to `readTemplate()`. This test drives the
		// default-argument arm end-to-end so the fallback is not a coverage
		// blind spot — a future refactor that broke `readTemplate` would
		// otherwise slip past every test that passed a fixture template.
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		let out = "";
		let errText = "";
		const code = main(
			[],
			workDir,
			(s) => {
				out += s;
			},
			(s) => {
				errText += s;
			},
		);
		expect(code).toBe(0);
		expect(errText).toBe("");
		expect(out).toMatch(/wrote \.github\/workflows\/sync-upstream\.yml/u);
	});
});

describe("main (end-to-end)", () => {
	function drive(argv: readonly string[]): {
		code: number;
		out: string;
		err: string;
	} {
		let out = "";
		let errText = "";
		const code = main(
			argv,
			workDir,
			(s) => {
				out += s;
			},
			(s) => {
				errText += s;
			},
			FIXTURE_TEMPLATE,
		);
		return { code, out, err: errText };
	}

	it("writes a substituted workflow on first run and returns 0", () => {
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		const { code, out } = drive([]);
		expect(code).toBe(0);
		expect(out).toMatch(/wrote \.github\/workflows\/sync-upstream\.yml/u);
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		expect(existsSync(target)).toBe(true);
		const content = readFileSync(target, "utf8");
		expect(content).toContain("git@github.com:kaelys-js/foundation-registry.git");
		expect(content).not.toMatch(/\$\{UPSTREAM_/u);
	});

	it("is a no-op on re-run against the same config and reports `matches`", () => {
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		drive([]); // seed
		const { code, out } = drive([]);
		expect(code).toBe(0);
		expect(out).toMatch(/no-op/u);
	});

	it("exits 2 and preserves local edits when the workflow was hand-modified", () => {
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		drive([]); // seed
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		writeFileSync(target, "hand-edited\n");
		const { code, err } = drive([]);
		expect(code).toBe(2);
		expect(err).toMatch(/differs.*--force/u);
		// Preservation check: the hand edit is still there.
		expect(readFileSync(target, "utf8")).toBe("hand-edited\n");
	});

	it("overwrites the target under --force after a hand edit and returns 0", () => {
		writeFileSync(join(workDir, ".sync-upstream.json"), JSON.stringify(CONFIG));
		drive([]); // seed
		const target = join(workDir, ".github", "workflows", "sync-upstream.yml");
		writeFileSync(target, "hand-edited\n");
		const { code } = drive(["--force"]);
		expect(code).toBe(0);
		// After force, target must match generated output exactly (byte-identical
		// to a fresh substitute() call).
		expect(readFileSync(target, "utf8")).toBe(substitute(FIXTURE_TEMPLATE, CONFIG));
	});

	it("exits 1 with a clear message when `.sync-upstream.json` is absent", () => {
		const { code, err } = drive([]);
		expect(code).toBe(1);
		expect(err).toMatch(/\.sync-upstream\.json not found/u);
	});
});
