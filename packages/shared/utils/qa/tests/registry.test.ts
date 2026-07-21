// Tests for the QA toolchain registry (packages/shared/utils/qa/src/registry.ts).
//
// The registry is the single source of truth for every linter/formatter; a
// malformed entry throwing at import is the "fail loud" contract. Rule 9 — these
// assert WHY the valibot schemas matter: each schema encodes an invariant that
// dispatch.ts relies on (a tool must do lint OR format; match kinds are a closed
// set; the three lint modes carry exactly their own fields). A schema that
// accepted a malformed entry would let dead or ambiguous config merge, and
// dispatch would misbehave at run time instead of failing at import.

import { describe, it, expect } from "vitest";
import * as v from "valibot";
import {
	FILES,
	FormatSchema,
	LintSchema,
	MatchSchema,
	ToolSchema,
	TOOLS,
} from "../src/registry.ts";

describe("FILES sentinel", () => {
	it("is the literal token dispatch substitutes the file list for", () => {
		// dispatch.expandArgv compares argv entries against this exact value; drift
		// here would silently stop file substitution.
		expect(FILES).toBe("FILES");
	});
});

describe("MatchSchema", () => {
	it("accepts each of the three match kinds", () => {
		expect(v.parse(MatchSchema, { kind: "ext", extensions: ["ts"] })).toEqual({
			kind: "ext",
			extensions: ["ts"],
		});
		expect(v.parse(MatchSchema, { kind: "regex", pattern: "x$" })).toEqual({
			kind: "regex",
			pattern: "x$",
		});
		expect(v.parse(MatchSchema, { kind: "secrets" })).toEqual({ kind: "secrets" });
	});

	it("rejects an unknown match kind", () => {
		// The closed variant set is what lets dispatch.selectFiles exhaustively
		// switch on `match.kind`; an unknown kind must never reach it.
		expect(() => v.parse(MatchSchema, { kind: "glob", pattern: "*" })).toThrow(/Invalid/u);
	});

	it("rejects an ext match missing its extensions array", () => {
		expect(() => v.parse(MatchSchema, { kind: "ext" })).toThrow(/Invalid/u);
	});
});

describe("LintSchema", () => {
	it("accepts a files-mode command and defaults fullRepoDot to false", () => {
		// fullRepoDot is optional; its false default is what makes non-oxlint tools
		// pass the file list (not ".") in a whole-repo run.
		expect(v.parse(LintSchema, { mode: "files", argv: ["oxlint", FILES] })).toEqual({
			mode: "files",
			argv: ["oxlint", FILES],
			fullRepoDot: false,
		});
	});

	it("accepts a staged-aware command with both argv variants", () => {
		const parsed = v.parse(LintSchema, {
			mode: "staged-aware",
			stagedArgv: ["gitleaks", "git"],
			fullArgv: ["gitleaks", "dir"],
		});
		expect(parsed).toEqual({
			mode: "staged-aware",
			stagedArgv: ["gitleaks", "git"],
			fullArgv: ["gitleaks", "dir"],
		});
	});

	it("accepts a project-mode command", () => {
		expect(v.parse(LintSchema, { mode: "project", argv: ["tsc", "--noEmit"] })).toEqual({
			mode: "project",
			argv: ["tsc", "--noEmit"],
		});
	});

	it("rejects an unknown lint mode", () => {
		expect(() => v.parse(LintSchema, { mode: "whatever", argv: [] })).toThrow(/Invalid/u);
	});
});

describe("FormatSchema", () => {
	it("accepts a check/write pair and defaults fullRepoDot", () => {
		expect(v.parse(FormatSchema, { check: ["oxfmt", "--check"], write: ["oxfmt"] })).toEqual({
			check: ["oxfmt", "--check"],
			write: ["oxfmt"],
			fullRepoDot: false,
		});
	});

	it("rejects a format entry missing the write variant", () => {
		expect(() => v.parse(FormatSchema, { check: ["oxfmt"] })).toThrow(/Invalid/u);
	});
});

describe("ToolSchema", () => {
	it("accepts a lint-only tool and defaults wholeRepoOnly to false", () => {
		const parsed = v.parse(ToolSchema, {
			id: "x",
			match: { kind: "ext", extensions: ["ts"] },
			lint: { mode: "files", argv: [FILES] },
		});
		expect(parsed.wholeRepoOnly).toBe(false);
		expect(parsed.id).toBe("x");
	});

	it("rejects a tool that defines neither lint nor format (dead config)", () => {
		// The `v.check` refinement is the guard against a registry entry that would
		// select files but run nothing — dispatch would silently no-op it.
		expect(() => v.parse(ToolSchema, { id: "dead", match: { kind: "secrets" } })).toThrow(
			/lint and\/or format/u,
		);
	});

	it("rejects a tool missing its id", () => {
		expect(() =>
			v.parse(ToolSchema, {
				match: { kind: "secrets" },
				lint: { mode: "files", argv: [] },
			}),
		).toThrow(/Invalid/u);
	});
});

describe("TOOLS (the validated registry)", () => {
	it("imports without throwing and is a non-empty array", () => {
		// The whole point of parsing at import: a bad entry would have thrown before
		// this test could run. Reaching here proves the real registry is well-formed.
		expect(Array.isArray(TOOLS)).toBe(true);
		expect(TOOLS.length).toBeGreaterThan(0);
	});

	it("has unique tool ids", () => {
		// dispatch's `--only <id>` filter assumes ids are unique; a collision would
		// run two tools under one flag.
		const ids = TOOLS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("carries the expected core tools with their match/mode wiring", () => {
		const byId = new Map(TOOLS.map((t) => [t.id, t]));
		const oxlint = byId.get("oxlint");
		expect(oxlint?.match).toEqual({
			kind: "ext",
			extensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"],
		});
		expect(oxlint?.lint?.mode).toBe("files");

		// gitleaks is the staged-aware secrets tool.
		expect(byId.get("gitleaks")?.match).toEqual({ kind: "secrets" });
		expect(byId.get("gitleaks")?.lint?.mode).toBe("staged-aware");

		// schema is the only wholeRepoOnly tool (network-fetching $schemas).
		expect(byId.get("schema")?.wholeRepoOnly).toBe(true);

		// typescript runs project-mode (whole-graph typecheck, no FILES token).
		expect(byId.get("typescript")?.lint?.mode).toBe("project");
	});

	it("wires syncpack as a package.json tool with a version-lint AND a sort-format", () => {
		// WHY: syncpack is the ONLY tool that both lints (version/range consistency via
		// `syncpack lint`) and formats (package.json field sorting via `syncpack
		// format`). If the lint dropped to files-mode it would append file paths syncpack
		// rejects; if the format check/write diverged from `format`/`format --check` the
		// pre-commit sort and the CI sort-gate would disagree. This pins both halves.
		const syncpack = new Map(TOOLS.map((t) => [t.id, t])).get("syncpack");
		expect(syncpack?.match).toEqual({ kind: "regex", pattern: String.raw`(^|/)package\.json$` });
		// Version consistency runs project-mode (no FILES token — syncpack discovers
		// packages itself) through `pnpm exec` because syncpack is a node_modules bin.
		expect(syncpack?.lint?.mode).toBe("project");
		// As of Stage-0 every syncpack invocation carries `--config` at the relocated
		// config in @foundation/config (syncpack has no `extends`; a missing flag would
		// silently fall back to cosmiconfig defaults).
		const cfg = ["--config", "packages/shared/config/syncpack.json"];
		expect(syncpack?.lint).toMatchObject({
			argv: ["pnpm", "exec", "syncpack", "lint", ...cfg, "--no-ansi"],
		});
		// Format check == `format --check` (sort gate); write == `format` (sorts in
		// place). Neither carries the FILES token, so dispatch runs them verbatim.
		expect(syncpack?.format?.check).toEqual([
			"pnpm",
			"exec",
			"syncpack",
			"format",
			"--check",
			...cfg,
			"--no-ansi",
		]);
		expect(syncpack?.format?.write).toEqual([
			"pnpm",
			"exec",
			"syncpack",
			"format",
			...cfg,
			"--no-ansi",
		]);
	});
});
