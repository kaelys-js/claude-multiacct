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
];

/** The validated registry. A malformed entry throws at import (fail loud). */
export const TOOLS: readonly Tool[] = v.parse(v.array(ToolSchema), TOOLS_INPUT);
