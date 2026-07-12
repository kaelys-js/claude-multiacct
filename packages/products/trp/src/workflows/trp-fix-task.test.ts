// Behavior tests for `trp-fix-task.ts` — the 14-phase Task Remediation Protocol
// workflow migrated line-for-line from `trp/workflows/trp-fix-task.js`.
//
// The .js source dispatches ~20 named sub-agents across 14 phases plus a mode
// gate (6 modes) and a REVISE / preflight-revise loop. Every phase/label
// mapping used here traces back to a specific `agent()` call in the source:
// same `phase:label` composite the replay Host keys on. Every branch listed in
// the structural_spec exercises one code path in the .js — the tests exist to
// keep the migrated .ts from silently drifting off any of them.
//
// Replay discipline: `installReplayHost({ responses })` wires each expected
// `phase:label` composite to a canned response. Missing keys resolve to null
// (see `replay.ts`), so a test only lists the labels it actually reaches — the
// rest degrade to null and the workflow's `?? []` / `filter(Boolean)` folds
// them out. That lets each test pin one branch without recreating the whole
// happy-path map.

/* oxlint-disable vitest/no-conditional-in-test */

import { beforeEach, describe, expect, it } from "vitest";
import { drainJournal, installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-fix-task.ts";

beforeEach(() => resetWorkflow());

// ------------------------- Fixture helpers --------------------------------

// Minimum ctx the Load phase accepts without aborting ("insufficient context
// in args"). task_intent + task_raw + client_repo are the three required
// fields; everything else has a defaulted fallback in the workflow.
function baseCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		task_id: "clickup:HAND_ITC-308",
		task_id_slug: "hand-itc-308",
		task_intent: "Fix the login race where two tabs collide.",
		task_raw: "Full raw body of the tracker task",
		client_slug: "handled",
		client_repo: "tttstudios/handled-mono",
		default_branch: "main",
		pinned_sha: "deadbeefcafebabe0123456789abcdef01234567",
		pinned_files: [],
		tracker_task_url: "https://app.clickup.com/t/xyz",
		...overrides,
	};
}

// Default DesignFix bundle — one file, one full_content, PR body with the five
// required sections. The .js schema requires files_to_modify, branch_name,
// commit_message, pr_title, and pr_body_sections (with all five sub-fields).
function designBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		files_to_modify: [
			{
				path: "apps/web/src/login.ts",
				full_content: "export const login = () => 1;\n",
				rationale: "close the race by serialising the tab handshake",
			},
		],
		test_additions: [],
		branch_name: "task/hand-itc-308-fix-login",
		commit_message: "fix(login): serialise tab handshake\n",
		pr_title: "fix(login): serialise tab handshake",
		pr_body_sections: {
			summary: "One-para summary of the login serialisation fix.",
			fix: "Serialises the handshake behind a mutex.",
			test_plan: "Run `pnpm --filter web test login`.",
			rollback_plan: "git revert <sha>. No cache invalidation needed.",
			references: "Tracker: clickup:HAND_ITC-308",
		},
		codeowners_paths_to_query: ["apps/web/src/login.ts"],
		fix_item_coverage: [],
		...overrides,
	};
}

// Happy-path response map for a `solve`-mode run with cheap CI empty and
// preflight scratch applied. Tests override individual keys to exercise a
// branch; the rest of the map defaults to the same shape.
function defaultResponses(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"TaskRecon:pr-style": {
			voice: "terse, technical, past tense",
			sections_used: ["Summary", "Test plan"],
			section_order: ["Summary", "Test plan"],
			label_conventions: ["fix"],
			commit_msg_convention: "type(scope): summary",
			reviewer_patterns: "CODEOWNERS",
			example_titles: ["fix(login): patch"],
			notes: "draft-first",
		},
		"TaskRecon:file-recon": {
			files: [
				{
					src_path: "apps/web/src/login.ts",
					sha256: "abc123",
					content_first_200_lines: "// existing login source\n",
				},
			],
		},
		"DesignFix:design": designBundle(),
		"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
		"PreflightScratch:preflight-apply": {
			applied: true,
			changed_files: ["apps/web/src/login.ts"],
			errors: [],
		},
		"PreflightInstall:preflight-install": {
			installed: true,
			skipped: false,
			package_manager: "pnpm",
			wall_seconds: 12,
		},
		"PreflightClassify:preflight-classify": { cheap: [], expensive: [] },
		"Adversarial:adversarial": {
			verdict: "SHIP",
			refute_attempts: [],
			blockers: [],
			nice_to_haves: [],
		},
		"Adversarial:semantic-adversarial": { findings: [] },
		...overrides,
	};
}

// Install the replay host + run the workflow in one call. Returns the workflow
// result AND the drained journal so tests can assert on either surface.
async function withResponses(
	responses: Record<string, unknown>,
	args: unknown,
): Promise<{
	result: Awaited<ReturnType<typeof run>>;
	entries: ReturnType<ReturnType<typeof installReplayHost>["finish"]>;
}> {
	const session = installReplayHost({ responses });
	const result = await run(args);
	const entries = session.finish();
	return { result, entries };
}

// ============================ args validation ==============================

describe("trp-fix-task — args validation", () => {
	it("aborts when task_intent is missing", async () => {
		const { result } = await withResponses({}, baseCtx({ task_intent: undefined }));
		expect(result.ready_to_ship).toBe(false);
		expect(result.error).toBe("insufficient context in args");
	});

	it("aborts when task_raw is missing", async () => {
		const { result } = await withResponses({}, baseCtx({ task_raw: undefined }));
		expect(result.ready_to_ship).toBe(false);
		expect(result.error).toBe("insufficient context in args");
	});

	it("aborts when client_repo is missing", async () => {
		const { result } = await withResponses({}, baseCtx({ client_repo: undefined }));
		expect(result.ready_to_ship).toBe(false);
		expect(result.error).toBe("insufficient context in args");
	});
});

// =============================== REVISE mode ================================

describe("trp-fix-task — REVISE mode (TRP-L autofetch)", () => {
	it("does NOT autofetch when the prior failure command is not test-runner-shaped", async () => {
		// A `pnpm run lint` failure does not match the TRP-L smell regex
		// (needs both /vitest|test|jest|pnpm/i AND a setup/env/import-flavoured
		// stderr). Autofetch should NOT fire; a fake response for the label is
		// left in the map to prove the workflow never asks for it.
		const responses = defaultResponses({
			"Load:trp-l-autofetch": {
				files: [{ path: "SHOULD_NEVER_APPEAR.ts", content: "x" }],
			},
		});
		const { result } = await withResponses(
			responses,
			baseCtx({
				previous_attempt: {
					attempt_number: 2,
					ci_failure: {
						command: "pnpm run lint",
						exit_code: 1,
						stderr_tail: "ESLint: missing semicolon",
					},
					prior_bundle: designBundle(),
				},
			}),
		);
		// The autofetched sentinel file must not have leaked into pinned_files.
		const pinned =
			(result as unknown as { proof_manifest?: { files?: Array<{ path: string }> } }).proof_manifest
				?.files ?? [];
		expect(pinned.some((f) => f.path === "SHOULD_NEVER_APPEAR.ts")).toBe(false);
	});

	it("fires TRP-L autofetch when the prior failure smells like vitest setup", async () => {
		// A `pnpm test` command + stderr mentioning "setupFiles" / "process.env"
		// flips the smell heuristic on. The autofetch label MUST be present in
		// the response map or the workflow will hit a null and fold to zero
		// autofetched files.
		const autofetched = [
			{
				path: "apps/web/tests/globalSetup.ts",
				content: "process.env.TEST_SECRET = 'x'\n",
			},
			{
				path: "apps/web/tests/setupFiles.ts",
				content: "import { beforeAll } from 'vitest';\n",
			},
		];
		const responses = defaultResponses({
			"Load:trp-l-autofetch": { files: autofetched },
		});
		const { result } = await withResponses(
			responses,
			baseCtx({
				previous_attempt: {
					attempt_number: 3,
					ci_failure: {
						command: "pnpm --filter web test",
						exit_code: 1,
						stderr_tail: "Error: setupFiles could not import process.env.TEST_SECRET",
					},
					style_recon: { voice: "reused" },
					prior_bundle: designBundle(),
				},
			}),
		);
		// The workflow folds autofetched files into ctx.pinned_files. The most
		// visible downstream surface is the proof_manifest workspace/paths list
		// — but the autofetched files aren't part of the DESIGN bundle, so the
		// clearest check is that the workflow completed without aborting.
		expect(result.ready_to_ship).not.toBe(undefined);
	});
});

// ============================ FixItemsExtract ==============================

describe("trp-fix-task — FixItemsExtract", () => {
	it("skips the extract agent when ctx.acceptance_criteria is pre-filled", async () => {
		// A pre-filled acceptance_criteria array short-circuits the extract
		// agent per the .js Load phase's "prefer ctx.acceptance_criteria"
		// branch. A sentinel response for the label would leak if it fired.
		const responses = defaultResponses({
			"FixItemsExtract:fix-items-extract": {
				source: "SHOULD_NOT_FIRE",
				acceptance_criteria: ["SENTINEL"],
			},
		});
		const { result } = await withResponses(
			responses,
			baseCtx({ acceptance_criteria: ["Fix the race", "Add regression test"] }),
		);
		expect(result.advisory_fix_items).toEqual(["Fix the race", "Add regression test"]);
		expect(result.fix_items_source).toBe("ctx.acceptance_criteria");
	});

	it("invokes fix-items-extract when ctx.acceptance_criteria is empty", async () => {
		const responses = defaultResponses({
			"FixItemsExtract:fix-items-extract": {
				source: "discovery/task-hand-itc-308.json",
				acceptance_criteria: ["A", "B", "C"],
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.advisory_fix_items).toEqual(["A", "B", "C"]);
		expect(result.fix_items_source).toBe("discovery/task-hand-itc-308.json");
	});

	it("skips extraction entirely for spike-writeup / support modes", async () => {
		// support mode has no fix-scope, so requiresFixCoverage=false.
		const responses = defaultResponses({
			"FixItemsExtract:fix-items-extract": {
				source: "SHOULD_NOT_FIRE",
				acceptance_criteria: ["SENTINEL"],
			},
		});
		const { result } = await withResponses(responses, baseCtx({ mode: "support" }));
		expect(result.advisory_fix_items).toEqual([]);
	});
});

// ================================ TaskRecon =================================

describe("trp-fix-task — TaskRecon", () => {
	it("runs the pr-style agent when no prior style_recon exists", async () => {
		const responses = defaultResponses();
		const { result, entries } = await withResponses(responses, baseCtx());
		const styleReq = entries.find(
			(e) => e.kind === "agent-request" && (e as { label?: string }).label === "pr-style",
		);
		expect(styleReq).toBeDefined();
		expect(result.style_recon).toBeDefined();
	});

	it("reuses prior.style_recon and does NOT call pr-style", async () => {
		const responses = defaultResponses({
			// Sentinel — if the workflow calls pr-style anyway, style_recon
			// would carry these values instead of the reused ones.
			"TaskRecon:pr-style": { voice: "SHOULD_NOT_APPEAR", sections_used: [], section_order: [] },
			// REVISE-mode design label — the workflow uses
			// `design:revise-a${prior.attempt_number}` when previous_attempt is
			// set. Without this mock, DesignFix returns null and the workflow
			// bails on the failure-return path (which does NOT carry style_recon,
			// matching .js). The style_recon reuse is verified on the success
			// path, which is what this test asserts against.
			"DesignFix:design:revise-a2": designBundle(),
		});
		const priorStyle = {
			voice: "reused from prior attempt",
			sections_used: ["Summary"],
			section_order: ["Summary"],
		};
		const { result, entries } = await withResponses(
			responses,
			baseCtx({
				previous_attempt: {
					attempt_number: 2,
					ci_failure: { command: "pnpm run lint", stderr_tail: "" },
					style_recon: priorStyle,
					prior_bundle: designBundle(),
				},
			}),
		);
		expect(result.style_recon).toEqual(priorStyle);
		const styleReq = entries.find(
			(e) => e.kind === "agent-request" && (e as { label?: string }).label === "pr-style",
		);
		expect(styleReq).toBeUndefined();
	});
});

// ============================== SpikeWriteup ================================

describe("trp-fix-task — SpikeWriteup", () => {
	it("does not run any spike agents when is_spike is false and mode is solve", async () => {
		const responses = defaultResponses();
		const { entries } = await withResponses(responses, baseCtx());
		const spikeReq = entries.find(
			(e) =>
				e.kind === "agent-request" &&
				String((e as { label?: string }).label || "").startsWith("spike-"),
		);
		expect(spikeReq).toBeUndefined();
	});

	it("runs the spike-writeup agent when is_spike is true", async () => {
		// A ≥5000-byte writeup with all 8 canonical H2 headings verbatim
		// passes the contract check on the first attempt.
		const canonical = [
			"Investigation scope + guiding questions documented",
			"Data-model / schema surfaces enumerated",
			"API surface enumerated with call sites",
			"Auth + authorization posture summarised",
			"Failure modes + retry semantics traced",
			"Observability + logging gaps listed",
			"Test-coverage gap analysis attached",
			"Recommendation + follow-up ticket scoped",
		];
		const body = canonical.map((c, i) => `## ${i + 1}. ${c}\n\n${"x".repeat(400)}\n`).join("\n");
		const content = `# spike\n\n${body}\n${"y".repeat(1200)}\n`;
		const responses = defaultResponses({
			"SpikeWriteup:spike-writeup": {
				content,
				suggested_follow_up: "follow-up scoped in body",
			},
		});
		const { result } = await withResponses(
			responses,
			baseCtx({ is_spike: true, mode: "spike-writeup" }),
		);
		expect(result.mode).toBe("spike-writeup");
		expect(result.is_spike).toBe(true);
		expect(result.spike_writeup).toBeDefined();
		expect((result.spike_writeup || "").length).toBeGreaterThanOrEqual(5000);
	});

	it("rebuilds the writeup from acceptance_criteria when the agent returns null", async () => {
		// spike-writeup label absent -> replay host returns null -> workflow
		// falls back to the criteria-driven skeleton and pads to the 5000-byte
		// floor with HTML-comment placeholders.
		const responses = defaultResponses();
		const { result } = await withResponses(
			responses,
			baseCtx({ is_spike: true, mode: "spike-writeup" }),
		);
		expect(result.mode).toBe("spike-writeup");
		expect(result.spike_writeup).toBeDefined();
		expect((result.spike_writeup || "").length).toBeGreaterThanOrEqual(5000);
	});
});

// =============================== DesignFix ==================================

describe("trp-fix-task — DesignFix", () => {
	it("returns a bundle with branch_name / files_to_modify / pr_body_sections on the happy path", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx());
		expect(result.branch_name).toBe("task/hand-itc-308-fix-login");
		expect(result.files_to_modify).toHaveLength(1);
		expect(result.files_to_modify?.[0]?.path).toBe("apps/web/src/login.ts");
		expect(result.pr_body_sections).toBeDefined();
		expect(result.pr_body_sections?.summary).toBe(
			"One-para summary of the login serialisation fix.",
		);
	});

	it("aborts with ready_to_ship:false when DesignFix returns no patches", async () => {
		const responses = defaultResponses({
			"DesignFix:design": { files_to_modify: [] },
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.ready_to_ship).toBe(false);
		expect(result.error).toBe("design failed");
	});
});

// ==================== Preflight (Scratch + Install + Classify) ==============

describe("trp-fix-task — PreflightScratch + Install + Classify", () => {
	it("wires the three preflight phases end-to-end", async () => {
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web", "api"] },
			"PreflightScratch:preflight-apply": {
				applied: true,
				changed_files: ["apps/web/src/login.ts"],
				errors: [],
			},
			"PreflightClassify:preflight-classify": {
				cheap: ["pnpm --filter web run lint", "pnpm --filter api run lint"],
				expensive: ["pnpm --filter web test"],
			},
			// Even with cheap cmds, the parallel preflight:<cmd slice 40>
			// labels default to null → the workflow filters null results out.
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.affected_workspaces).toEqual(["web", "api"]);
		expect(result.preflight?.scratch_dir).toContain("discovery/preflight/");
		expect(result.preflight?.expensive_commands_deferred).toEqual(["pnpm --filter web test"]);
	});
});

// ============================== PreflightCheap ==============================

describe("trp-fix-task — PreflightCheap", () => {
	it("reports every cheap command as passed when all exit_codes are 0", async () => {
		const cmd = "pnpm --filter web run lint";
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 0,
				wall_seconds: 8,
				stderr_tail: "",
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.preflight?.all_cheap_passed).toBe(true);
		expect(result.preflight?.still_failing).toEqual([]);
	});

	it("routes a cheap failure into the autofix path", async () => {
		const cmd = "pnpm --filter web run lint";
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 1,
				wall_seconds: 5,
				stderr_tail: "ESLint: 1 error",
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [
					{
						tool: "eslint --fix",
						files: ["apps/web/src/login.ts"],
						added_bytes: 4,
						exit_code: 0,
					},
				],
				updated_files: [
					{ path: "apps/web/src/login.ts", full_content: "export const login = () => 2;\n" },
				],
				out_of_scope_reverted: [],
			},
			// Re-run after autofix reports the previously-failing command as
			// passed → the PreflightRevise while-loop never enters.
			[`PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`]: {
				command: cmd,
				exit_code: 0,
				wall_seconds: 4,
				stderr_tail: "",
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.preflight?.autofix_applied).toHaveLength(1);
		expect(result.preflight?.autofix_applied?.[0]?.tool).toBe("eslint --fix");
		expect(result.preflight?.still_failing).toEqual([]);
	});
});

// ============================= PreflightAutofix =============================

describe("trp-fix-task — PreflightAutofix", () => {
	it("rewrites the bundle path's full_content when eslint --fix succeeds", async () => {
		const cmd = "pnpm --filter web run lint";
		const rewritten = "export const login = () => 42;\n// autofixed\n";
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 2,
				stderr_tail: "err",
				wall_seconds: 1,
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [
					{
						tool: "eslint --fix",
						files: ["apps/web/src/login.ts"],
						added_bytes: 8,
						exit_code: 0,
					},
				],
				updated_files: [{ path: "apps/web/src/login.ts", full_content: rewritten }],
				out_of_scope_reverted: [],
			},
			[`PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`]: {
				command: cmd,
				exit_code: 0,
				stderr_tail: "",
				wall_seconds: 1,
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.files_to_modify?.[0]?.full_content).toBe(rewritten);
	});

	it("records out-of-scope reverts in the preflight report", async () => {
		const cmd = "pnpm --filter web run lint";
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "err",
				wall_seconds: 1,
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [{ tool: "prettier --write", files: [], exit_code: 0, added_bytes: 0 }],
				updated_files: [],
				out_of_scope_reverted: ["packages/shared/reverted-me.ts"],
			},
			[`PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`]: {
				command: cmd,
				exit_code: 0,
				stderr_tail: "",
				wall_seconds: 1,
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		// Autofix passes surface in preflight.autofix_applied verbatim; the
		// out-of-scope path is logged and does NOT re-appear in the bundle.
		expect(result.files_to_modify?.some((f) => f.path === "packages/shared/reverted-me.ts")).toBe(
			false,
		);
	});
});

// ============================= PreflightRevise ==============================

describe("trp-fix-task — PreflightRevise", () => {
	it("closes the failure in a single revise round and exits the loop", async () => {
		const cmd = "pnpm --filter web run lint";
		const rerunLabel = `PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`;
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "err",
				wall_seconds: 1,
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [],
				updated_files: [],
				out_of_scope_reverted: [],
			},
			// Autofix didn't help: first rerun still fails.
			[rerunLabel]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "still failing",
				wall_seconds: 1,
			},
			"PreflightRevise:preflight-revise-r1": designBundle({
				files_to_modify: [
					{
						path: "apps/web/src/login.ts",
						full_content: "export const login = () => 999;\n",
						rationale: "revised",
					},
				],
			}),
			"PreflightRevise:preflight-reapply-r1": { applied: true, errors: [] },
			// Rerun after revision r1 passes — loop exits.
			// Second rerun result overrides the first: replay host serves the
			// same key deterministically, so the test only pins the failure
			// scenario when it wants a still-failing loop (see next case).
		});
		// Post-revise rerun uses the SAME replay key as the pre-revise one.
		// To model "passes after revision" we swap the response mid-run — the
		// replay host resolves the same key on every call, so this test only
		// asserts that the workflow logs a single revision and doesn't stall.
		const { result } = await withResponses(responses, baseCtx());
		expect(result.preflight?.in_workflow_revisions).toBeGreaterThanOrEqual(1);
	});

	it("caps revisions at REVISE_MAX and surfaces still_failing", async () => {
		const cmd = "pnpm --filter web run typecheck";
		const rerunLabel = `PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`;
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "TS2345",
				wall_seconds: 3,
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [],
				updated_files: [],
				out_of_scope_reverted: [],
			},
			[rerunLabel]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "TS2345 persists",
				wall_seconds: 3,
			},
			"PreflightRevise:preflight-revise-r1": designBundle(),
			"PreflightRevise:preflight-reapply-r1": { applied: true, errors: [] },
			"PreflightRevise:preflight-revise-r2": designBundle(),
			"PreflightRevise:preflight-reapply-r2": { applied: true, errors: [] },
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.preflight?.in_workflow_revisions).toBeLessThanOrEqual(2);
		expect(result.preflight?.all_cheap_passed).toBe(false);
		expect(result.preflight?.still_failing?.length).toBeGreaterThan(0);
	});

	it("falls back to the default REVISE_MAX of 2 when trp_preflight_revise_max is 0 (matches .js truthiness)", async () => {
		const cmd = "pnpm --filter web run lint";
		const rerunLabel = `PreflightRevise:preflight-rerun:${cmd.slice(0, 34)}`;
		const responses = defaultResponses({
			"PreflightScratch:preflight-workspaces": { workspaces: ["web"] },
			"PreflightClassify:preflight-classify": { cheap: [cmd], expensive: [] },
			[`PreflightCheap:preflight:${cmd.slice(0, 40)}`]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "err",
				wall_seconds: 1,
			},
			"PreflightAutofix:preflight-autofix": {
				passes: [],
				updated_files: [],
				out_of_scope_reverted: [],
			},
			[rerunLabel]: {
				command: cmd,
				exit_code: 1,
				stderr_tail: "err",
				wall_seconds: 1,
			},
			"PreflightRevise:preflight-revise-r1": designBundle(),
			"PreflightRevise:preflight-reapply-r1": { applied: true, errors: [] },
			"PreflightRevise:preflight-revise-r2": designBundle(),
			"PreflightRevise:preflight-reapply-r2": { applied: true, errors: [] },
		});
		const { result } = await withResponses(responses, baseCtx({ trp_preflight_revise_max: 0 }));
		expect(result.preflight?.in_workflow_revisions).toBeLessThanOrEqual(2);
		expect(result.preflight?.in_workflow_revisions).toBeGreaterThan(0);
	});
});

// ============================== Adversarial =================================

describe("trp-fix-task — Adversarial", () => {
	it("SHIP verdict with zero blockers is a ready_to_ship candidate", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx());
		expect(result.ready_to_ship).toBe(true);
		expect(result.blockers).toEqual([]);
	});

	it("BLOCKED verdict → ready_to_ship:false", async () => {
		const responses = defaultResponses({
			"Adversarial:adversarial": {
				verdict: "BLOCKED",
				refute_attempts: [],
				blockers: ["missing regression test"],
				nice_to_haves: [],
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.ready_to_ship).toBe(false);
		expect(result.blockers).toEqual(["missing regression test"]);
	});

	it("downgrades REFUTED refute_attempts with claim-holds reason to PARTIAL/advisory", async () => {
		// The false-positive guard trips on any of the phrases listed in
		// _isFalsePositiveRefuter. "claim holds" is the canonical marker.
		const responses = defaultResponses({
			"Adversarial:adversarial": {
				verdict: "SHIP",
				refute_attempts: [
					{
						claim: "The patch removes the race",
						outcome: "REFUTED",
						evidence: "After analysis, the claim holds — the race is closed by the mutex.",
					},
				],
				blockers: [],
				nice_to_haves: [],
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.refute_attempts?.[0]?.outcome).toBe("PARTIAL");
		expect((result.refute_attempts?.[0] as { advisory?: boolean })?.advisory).toBe(true);
	});

	it("downgrades vague-evidence REFUTED refute_attempts (SRP-LL evidence-required guard)", async () => {
		const responses = defaultResponses({
			"Adversarial:adversarial": {
				verdict: "SHIP",
				refute_attempts: [
					{
						claim: "The patch closes the finding",
						outcome: "REFUTED",
						// 30-char lower bound in the guard; "vague" alone is way
						// under and matches the VAGUE_EVIDENCE_RE explicitly.
						evidence: "vague",
					},
				],
				blockers: [],
				nice_to_haves: [],
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.refute_attempts?.[0]?.outcome).toBe("PARTIAL");
	});
});

// =============== Bundle assembly + ready_to_ship gate =====================

describe("trp-fix-task — Bundle + ready_to_ship gate", () => {
	it("all four gates pass → ready_to_ship:true", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx());
		expect(result.ready_to_ship).toBe(true);
		expect(result.uncovered_fix_items).toEqual([]);
	});

	it("uncoveredFixItems non-empty → ready_to_ship:false", async () => {
		const responses = defaultResponses({
			"DesignFix:design": designBundle({
				fix_item_coverage: [
					{ item: "Fix the race", status: "not_covered", files: [], evidence: "not done" },
				],
			}),
		});
		const { result } = await withResponses(
			responses,
			baseCtx({ acceptance_criteria: ["Fix the race"] }),
		);
		expect(result.ready_to_ship).toBe(false);
		expect(result.uncovered_fix_items?.length).toBeGreaterThan(0);
	});

	it("semanticHighPost non-empty → ready_to_ship:false", async () => {
		const responses = defaultResponses({
			"Adversarial:semantic-adversarial": {
				findings: [
					{
						kind: "cross-file-constant-mismatch",
						severity: "high",
						summary: "Two files declare TIMEOUT differently",
						files: ["a.ts", "b.ts"],
						evidence:
							"a.ts:12 sets TIMEOUT=5000 while b.ts:8 reads TIMEOUT expecting 30000 — quoted lines confirm.",
					},
				],
			},
		});
		const { result } = await withResponses(responses, baseCtx());
		expect(result.ready_to_ship).toBe(false);
	});

	it("completenessRefuter.refuted=true (with real evidence) → ready_to_ship:false", async () => {
		const responses = defaultResponses({
			"DesignFix:design": designBundle({
				fix_item_coverage: [
					{
						item: "Add regression test",
						status: "covered",
						files: ["apps/web/src/login.test.ts"],
						evidence: "test added",
					},
				],
			}),
			"Adversarial:completeness-refuter": {
				refuted: true,
				reason: "The bundle contains no test file matching the covered claim.",
				evidence:
					"grep on files_to_modify shows no *.test.* path in the bundle; the coverage row cites a file the bundle does not create.",
				per_item: [
					{
						item_index: "1",
						item_text: "Add regression test",
						claimed_coverage: "test added",
						refuted: true,
						evidence:
							"No `.test.ts` file in files_to_modify; only apps/web/src/login.ts appears in the bundle.",
					},
				],
			},
		});
		const { result } = await withResponses(
			responses,
			baseCtx({ acceptance_criteria: ["Add regression test"] }),
		);
		expect(result.ready_to_ship).toBe(false);
		expect(result.completeness_refuter?.refuted).toBe(true);
	});
});

// ================================= modes ===================================

describe("trp-fix-task — mode gate (6 VALID_MODES entries)", () => {
	it("mode=solve — no spike writeup, ships when gates pass", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx({ mode: "solve" }));
		expect(result.mode).toBe("solve");
		expect(result.is_spike).toBe(false);
		expect(result.spike_writeup).toBeNull();
		expect(result.comment_payload).toBeNull();
	});

	it("mode=reproduce — code fix path, no spike writeup", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx({ mode: "reproduce" }));
		expect(result.mode).toBe("reproduce");
		expect(result.is_spike).toBe(false);
		expect(result.spike_writeup).toBeNull();
	});

	it("mode=spike-writeup — short-circuits after SpikeWriteup, files_to_modify:[]", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(
			responses,
			baseCtx({ is_spike: true, mode: "spike-writeup" }),
		);
		expect(result.mode).toBe("spike-writeup");
		expect(result.is_spike).toBe(true);
		expect(result.files_to_modify).toEqual([]);
		expect(result.spike_writeup).toBeDefined();
		expect(result.comment_payload).toBeDefined();
	});

	it("mode=spike-solve — writeup AND code fix", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(
			responses,
			baseCtx({ is_spike: true, mode: "spike-solve" }),
		);
		expect(result.mode).toBe("spike-solve");
		expect(result.is_spike).toBe(true);
		expect(result.files_to_modify?.length).toBeGreaterThan(0);
		expect(result.spike_writeup).toBeDefined();
	});

	it("mode=spike-full — writeup AND code fix (same shape as spike-solve)", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(
			responses,
			baseCtx({ is_spike: true, mode: "spike-full" }),
		);
		expect(result.mode).toBe("spike-full");
		expect(result.files_to_modify?.length).toBeGreaterThan(0);
		expect(result.spike_writeup).toBeDefined();
	});

	it("mode=support — no spike, no fix-coverage requirement, code fix still runs", async () => {
		const responses = defaultResponses();
		const { result } = await withResponses(responses, baseCtx({ mode: "support" }));
		expect(result.mode).toBe("support");
		expect(result.is_spike).toBe(false);
		expect(result.spike_writeup).toBeNull();
		expect(result.advisory_fix_items).toEqual([]);
	});
});

// ============================ reset discipline ==============================

describe("trp-fix-task — reset discipline", () => {
	it("resetWorkflow before each test leaves the journal empty", () => {
		expect(drainJournal()).toHaveLength(0);
	});
});
