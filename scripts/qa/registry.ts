/**
 * The single source of truth for foundation-registry's QA toolchain: every
 * linter and formatter, as a strict, valibot-validated data registry.
 * `dispatch.ts` interprets these entries — no tool list lives anywhere else.
 *
 * Each entry declares HOW to select its files (`match`) and WHAT to run
 * (`lint` and/or `format`). The `FILES` token in an argv is replaced by the
 * matched file list at run time. Tools run through the repo-scoped mise wrapper
 * (`bin/mise exec`), so versions come from mise.toml.
 *
 * @module
 */

import * as v from "valibot";

/** Sentinel in an argv template, replaced by the matched file paths. */
export const FILES = "FILES" as const;

/** How a tool selects the files it applies to. */
export const MatchSchema = v.variant("kind", [
	/** By file extension (without the dot), e.g. `["ts", "tsx"]`. */
	v.object({ kind: v.literal("ext"), extensions: v.array(v.string()) }),
	/** By path regex (e.g. `\.schema\.json$`). */
	v.object({ kind: v.literal("regex"), pattern: v.string() }),
	/** Whole-repo secret scan (no file list; staged-aware). */
	v.object({ kind: v.literal("secrets") }),
]);
export type Match = v.InferOutput<typeof MatchSchema>;

/** A linter's command. Discriminated by how it consumes files. */
export const LintSchema = v.variant("mode", [
	/** Run once over the matched files (the common case). */
	v.object({
		mode: v.literal("files"),
		argv: v.array(v.string()),
		/** In whole-repo mode, pass "." instead of the file list (oxlint/oxfmt). */
		fullRepoDot: v.optional(v.boolean(), false),
	}),
	/** Different subcommand for staged vs whole-repo (gitleaks). */
	v.object({
		mode: v.literal("staged-aware"),
		stagedArgv: v.array(v.string()),
		fullArgv: v.array(v.string()),
	}),
	/**
	 * Whole-project tool: run `argv` once, verbatim, with NO file-list
	 * substitution (tsc/reuse). Gated on ≥1 matched file, so a staged run that
	 * touched none of the tool's files skips it, while a whole-repo run always
	 * has candidates and runs it.
	 */
	v.object({
		mode: v.literal("project"),
		argv: v.array(v.string()),
	}),
]);

/** A formatter's command: a check variant and a write variant over the files. */
export const FormatSchema = v.object({
	check: v.array(v.string()),
	write: v.array(v.string()),
	fullRepoDot: v.optional(v.boolean(), false),
});

export const ToolSchema = v.pipe(
	v.object({
		id: v.string(),
		match: MatchSchema,
		lint: v.optional(LintSchema),
		format: v.optional(FormatSchema),
		/**
		 * Skip this tool in staged (pre-commit) mode; run it only in a whole-repo
		 * pass (pre-push / CI / `pnpm qa:lint`). For tools that need the full tree
		 * or do network IO we don't want on every commit (e.g. schema-check fetches
		 * remote `$schema`s). Defaults to false — tools run in both modes.
		 */
		wholeRepoOnly: v.optional(v.boolean(), false),
	}),
	// A tool must do at least one of lint/format, else it is dead config.
	v.check(
		(t) => t.lint !== undefined || t.format !== undefined,
		"tool must define lint and/or format",
	),
);
export type Tool = v.InferOutput<typeof ToolSchema>;

const TOOLS_INPUT = [
	// ── JS / TS ────────────────────────────────────────────────────────
	{
		id: "oxlint",
		match: { kind: "ext", extensions: ["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"] },
		lint: { mode: "files", argv: ["oxlint", FILES], fullRepoDot: true },
	},
	{
		id: "typescript",
		match: { kind: "ext", extensions: ["ts", "mts", "cts", "tsx"] },
		// Whole-project typecheck: tsc reads the file graph itself (via tsconfig),
		// so it runs once with no file args. `tsc` is a node_modules bin, not a
		// mise tool, so invoke it through pnpm (which is on mise's PATH).
		lint: { mode: "project", argv: ["pnpm", "exec", "tsc", "--noEmit"] },
	},
	{
		id: "oxfmt",
		match: {
			kind: "ext",
			extensions: [
				"js",
				"mjs",
				"cjs",
				"jsx",
				"ts",
				"mts",
				"cts",
				"tsx",
				"json",
				"jsonc",
				"yaml",
				"yml",
				"md",
				"mdx",
				"css",
				"scss",
				"less",
				"graphql",
			],
		},
		format: {
			check: ["oxfmt", "--check", "--no-error-on-unmatched-pattern", FILES],
			write: ["oxfmt", "--no-error-on-unmatched-pattern", FILES],
			fullRepoDot: true,
		},
	},
	// ── YAML / TOML ────────────────────────────────────────────────────
	{
		id: "yamllint",
		match: { kind: "ext", extensions: ["yaml", "yml"] },
		lint: { mode: "files", argv: ["yamllint", "--strict", FILES] },
	},
	{
		id: "taplo",
		match: { kind: "ext", extensions: ["toml"] },
		lint: { mode: "files", argv: ["taplo", "lint", FILES] },
		format: { check: ["taplo", "fmt", "--check", FILES], write: ["taplo", "fmt", FILES] },
	},
	// ── Markdown ───────────────────────────────────────────────────────
	{
		id: "markdownlint",
		match: { kind: "ext", extensions: ["md", "mdx"] },
		lint: { mode: "files", argv: ["markdownlint-cli2", FILES] },
	},
	// ── JSON Schema ────────────────────────────────────────────────────
	{
		id: "check-jsonschema",
		match: { kind: "regex", pattern: String.raw`\.schema\.json$` },
		lint: { mode: "files", argv: ["check-jsonschema", "--check-metaschema", FILES] },
	},
	// ── License compliance (REUSE / SPDX) ──────────────────────────────
	{
		id: "reuse",
		// Matched by the presence of REUSE.toml; `reuse lint` scans the whole tree
		// against it, so it runs once with no file args.
		match: { kind: "regex", pattern: String.raw`(^|/)REUSE\.toml$` },
		lint: { mode: "project", argv: ["reuse", "lint"] },
	},
	// ── Secrets ────────────────────────────────────────────────────────
	{
		id: "gitleaks",
		match: { kind: "secrets" },
		lint: {
			mode: "staged-aware",
			stagedArgv: ["gitleaks", "git", "--staged", "--redact", "--no-banner"],
			fullArgv: ["gitleaks", "dir", ".", "--redact", "--no-banner"],
		},
	},
	// ── EditorConfig conformance ───────────────────────────────────────
	{
		id: "editorconfig",
		// Matched by the presence of `.editorconfig`; the wrapper walks the repo via
		// `ec` (honouring `.editorconfig` + `.editorconfig-checker.json`), so it runs
		// once with no file args. It runs `ec` through the mise wrapper and, unlike
		// bare `ec`, fails when `.editorconfig` is unparseable (ec prints that error
		// but exits 0).
		match: { kind: "regex", pattern: String.raw`(^|/)\.editorconfig$` },
		lint: { mode: "project", argv: ["node", "scripts/qa/editorconfig-check.ts"] },
	},
	// ── Git metadata (.gitignore / .gitattributes contents) ────────────
	{
		id: "gitmeta",
		// Matched by the presence of `.gitattributes` (i.e. always, for this repo);
		// the check script asserts .gitignore/.gitattributes semantics via git
		// plumbing, so it runs once with no file args.
		match: { kind: "regex", pattern: String.raw`(^|/)\.gitattributes$` },
		lint: { mode: "project", argv: ["node", "scripts/qa/gitmeta-check.ts"] },
	},
	// ── Schema instance validation (config/data vs schemas) ────────────
	{
		id: "schema",
		// Matched by the presence of `package.json` (always tracked) so the tool
		// triggers on any whole-repo pass; schema-check itself auto-discovers every
		// config file. `wholeRepoOnly` keeps it out of the pre-commit staged path
		// because it fetches remote `$schema`s (no network on every commit).
		match: { kind: "regex", pattern: String.raw`(^|/)package\.json$` },
		wholeRepoOnly: true,
		lint: { mode: "project", argv: ["node", "scripts/qa/schema-check.ts"] },
	},
	// ── Dependency version consistency + package.json sorting (syncpack) ─
	{
		id: "syncpack",
		// Matched by any package.json. syncpack discovers packages itself (one now,
		// packages/* once the monorepo lands), so it runs project-mode: `lint` checks
		// version/range consistency, `format`/`format --check` sort every package.json
		// per `.syncpackrc.json`. syncpack is a node_modules bin (not a mise tool), so
		// it's invoked through `pnpm exec` like tsc. `--no-ansi` keeps CI logs clean.
		match: { kind: "regex", pattern: String.raw`(^|/)package\.json$` },
		lint: { mode: "project", argv: ["pnpm", "exec", "syncpack", "lint", "--no-ansi"] },
		format: {
			check: ["pnpm", "exec", "syncpack", "format", "--check", "--no-ansi"],
			write: ["pnpm", "exec", "syncpack", "format", "--no-ansi"],
		},
	},
];

/** The validated registry. A malformed entry throws at import (fail loud). */
export const TOOLS: readonly Tool[] = v.parse(v.array(ToolSchema), TOOLS_INPUT);
