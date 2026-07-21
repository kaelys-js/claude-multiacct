/**
 * `@foundation/trp` — trp-recon-repo workflow (Phase 4 migration).
 *
 * TRP repo recon — read the last 5-10 merged PRs on the target repo and
 * extract house style (voice, section shape, labels, commit convention,
 * reviewer patterns) plus a top-touched-files list so pinned_files can be
 * selected relevantly.
 *
 * Migrated line-for-line from `trp/workflows/trp-recon-repo.js`. Every
 * agent() call, phase() marker, log() line, and schema literal preserved
 * verbatim so replay-mode `prompt_hash` and `schema_hash` remain stable.
 *
 * @module
 */

import { agent, log, phase } from "@foundation/agents";

export const meta = {
	name: "trp-recon-repo",
	description:
		"TRP repo recon — read the last 5-10 merged PRs on the target repo and extract house style (voice, section shape, labels, commit convention, reviewer patterns) plus a top-touched-files list so pinned_files can be selected relevantly.",
	whenToUse:
		"Before a TRP fix is designed. Main context passes the target repo + task id via args; the workflow shells out to gh and returns a style + file-touch summary the fix agent consumes.",
	phases: [
		{ title: "Load", detail: "Parse args; validate target repo + task id" },
		{
			title: "PRStyleRecon",
			detail: "Sub-agent reads recent merged PRs via gh and extracts house style",
		},
		{
			title: "TouchedFiles",
			detail: "Sub-agent enumerates the top files touched by recent merged PRs",
		},
		{ title: "Bundle", detail: "Return the recon bundle" },
	],
} as const;

const STYLE_SCHEMA = {
	type: "object",
	properties: {
		voice: { type: "string" },
		sections_used: { type: "array", items: { type: "string" } },
		section_order: { type: "array", items: { type: "string" } },
		label_conventions: { type: "array", items: { type: "string" } },
		commit_msg_convention: { type: "string" },
		reviewer_patterns: { type: "string" },
		example_titles: { type: "array", items: { type: "string" } },
		notes: { type: "string" },
	},
	required: ["voice", "sections_used", "section_order"],
} as const;

const FILES_SCHEMA = {
	type: "object",
	properties: {
		top_files: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					touch_count: { type: "integer" },
					example_prs: { type: "array", items: { type: "integer" } },
				},
				required: ["path", "touch_count"],
			},
		},
		notes: { type: "string" },
	},
	required: ["top_files"],
} as const;

export type ReconArgs = {
	readonly task_id?: string;
	readonly task_id_slug?: string;
	readonly client_repo?: string;
	readonly default_branch?: string;
	readonly pr_limit?: number;
};

export type ReconResult = {
	readonly ok: boolean;
	readonly error?: string;
	readonly task_id?: string;
	readonly task_id_slug?: string;
	readonly client_repo?: string;
	readonly default_branch?: string | null;
	readonly voice?: string;
	readonly sections_used?: string[];
	readonly section_order?: string[];
	readonly label_conventions?: string[];
	readonly commit_msg_convention?: string;
	readonly reviewer_patterns?: string;
	readonly example_titles?: string[];
	readonly notes?: string;
	readonly top_files?: Array<{ path: string; touch_count: number; example_prs?: number[] }>;
	readonly top_files_notes?: string;
};

function parseArgs(raw: unknown): ReconArgs {
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as ReconArgs;
		} catch {
			return {};
		}
	}
	return (raw ?? {}) as ReconArgs;
}

export async function run(rawArgs: unknown): Promise<ReconResult> {
	phase("Load");
	const ctx = parseArgs(rawArgs);

	const taskId = ctx.task_id || "TRACKER:UNKNOWN";
	const taskIdSlug = ctx.task_id_slug || "task-unknown";
	const prLimit = Number.isFinite(ctx.pr_limit) ? (ctx.pr_limit as number) : 10;

	if (!ctx.client_repo) {
		log("missing required context (client_repo) — abort");
		return { ok: false, error: "insufficient context in args" };
	}

	log(
		`TRP recon for ${taskId} on ${ctx.client_repo} (default_branch=${ctx.default_branch || "?"}, limit=${prLimit})`,
	);

	phase("PRStyleRecon");

	const styleAgent = await agent(
		`
Read the last 5-10 merged PRs on the client repo and extract its house style
so a TRP fix PR reads native to their conventions.

Repo: ${ctx.client_repo}
Default branch: ${ctx.default_branch || "(unknown)"}

Use \`gh pr list --repo ${ctx.client_repo} --state merged --limit ${prLimit}\`
to get IDs, then \`gh pr view <N> --repo ${ctx.client_repo}\` for each. Sample
about 5 representative PRs.

Extract:
1. **voice** — technical density, tone. One sentence.
2. **sections_used** — headings that recur (e.g. "Summary", "Changes",
   "Testing", "Rollback", "Screenshots"). Ordered by frequency.
3. **section_order** — the typical order those headings appear in.
4. **label_conventions** — labels typically applied (bug, security, feat, etc).
5. **commit_msg_convention** — Conventional Commits? "type(scope): summary"?
   "type: summary"? Freeform? Include one representative example.
6. **reviewer_patterns** — CODEOWNERS-based? Team-lead review? Auto-assigned?
7. **example_titles** — 3-5 real PR titles from the sample.
8. **notes** — anything else (draft-first, size limits, DCO, sign-off).

Return the STYLE_SCHEMA object. Under 500 words. Read-only.
`.trim(),
		{ label: "pr-style", phase: "PRStyleRecon", schema: STYLE_SCHEMA },
	);

	log(
		`style: voice="${(styleAgent?.voice || "").slice(0, 80)}", ${(styleAgent?.sections_used || []).length} sections`,
	);

	phase("TouchedFiles");

	const filesAgent = await agent(
		`
Enumerate the top 10 files touched by recent merged PRs on ${ctx.client_repo}.
These become the pool from which pinned_files are selected for the TRP fix.

Steps:
1. \`gh pr list --repo ${ctx.client_repo} --state merged --limit ${prLimit}\`
   to get PR numbers.
2. For each PR, \`gh pr view <N> --repo ${ctx.client_repo} --json files\` (or
   \`gh api repos/${ctx.client_repo}/pulls/<N>/files\`) to list the paths it
   modified.
3. Tally paths across the sample. Return the top 10 by touch_count, plus up to
   3 example PR numbers per path.

Ignore generated / lockfile paths (pnpm-lock.yaml, package-lock.json,
yarn.lock, dist/**, build/**, .next/**) — they inflate the count without
telling us anything about intent.

Return the FILES_SCHEMA object. Under 300 words. Read-only.
`.trim(),
		{ label: "touched-files", phase: "TouchedFiles", schema: FILES_SCHEMA },
	);

	log(`touched: ${(filesAgent?.top_files || []).length} file(s) enumerated`);

	phase("Bundle");

	return {
		ok: true,
		task_id: taskId,
		task_id_slug: taskIdSlug,
		client_repo: ctx.client_repo,
		default_branch: ctx.default_branch || null,
		voice: styleAgent?.voice || "",
		sections_used: (styleAgent?.sections_used as string[] | undefined) || [],
		section_order: (styleAgent?.section_order as string[] | undefined) || [],
		label_conventions: (styleAgent?.label_conventions as string[] | undefined) || [],
		commit_msg_convention: styleAgent?.commit_msg_convention || "",
		reviewer_patterns: styleAgent?.reviewer_patterns || "",
		example_titles: (styleAgent?.example_titles as string[] | undefined) || [],
		notes: styleAgent?.notes || "",
		top_files:
			(filesAgent?.top_files as
				| Array<{ path: string; touch_count: number; example_prs?: number[] }>
				| undefined) || [],
		top_files_notes: filesAgent?.notes || "",
	};
}

export default run;
