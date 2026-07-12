// Parity test for trp-fix-task against the recorded fixtures.
//
// WHY it matters: the trp-fix-task migration must preserve the .js workflow's
// return shape end to end (bundle + preflight + adversarial + proof manifest),
// because the driver, tracker-post-proof, and the SRP-side loop wrapper all
// deep-scan those fields. Any missing key downstream breaks the disclosure
// pipeline. Two fixtures exercise the two shapes we ship:
//
//   - clickup_hand_synth-01           — solve mode, full bundle + preflight
//   - clickup_synthetic-spike-solve-01 — spike-solve mode, writeup deliverable
//
// Comparator: sanitize(actual) is stableStringify'd and compared to the
// fixture's stableStringify. Every `fnv1a-<16hex>` sanitize marker asserts
// hash equality directly. Fields the per-fixture sanitize-manifest.json names
// as `structural_shape_only` relax to `{sanitized, len}` — those are the
// fields the fixture-prep pipeline stored a placeholder for rather than a
// source hash. Manifest-driven relaxation replaces any prior env-gated
// strictness knob. The gate is what the fixture proves.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-fix-task.ts";
import { sanitize, stableStringify } from "./sanitize.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"workflows",
	"trp-fix-task",
);
const FIXTURES = ["clickup_hand_synth-01", "clickup_synthetic-spike-solve-01"] as const;

type Fixture = (typeof FIXTURES)[number];

// Response maps keyed by `phase:label` — the shape the replay Host dispatches
// on. String leaves are padded with single-char repetition to match the
// sanitize markers' `len` fields in the fixture. The hash won't match the
// pre-captured source hash for a padded placeholder, but manifest-driven
// relaxation on `structural_shape_only` field paths compares the leaf on
// `{sanitized, len}` only; every other marker asserts hash equality.
const RESPONSES: Readonly<Record<Fixture, Readonly<Record<string, unknown>>>> = {
	"clickup_hand_synth-01": {
		"Load:fix-items-extract": {
			source: "acceptance_criteria",
			acceptance_criteria: [
				"Mount @handled/rate-limit-middleware on POST /submit-retroactive",
				"10 requests / minute per user",
				"HTTP 429 + Retry-After on breach",
				"Preserve prior-bundle correct state (TRP-P)",
				"Diagnose CI failure",
			],
		},
		"TaskRecon:pr-style": {
			voice: "v".repeat(158),
			sections_used: [
				"Summary",
				"Reasoning",
				"How to Test",
				"Risk/Rollback",
				"Self-review Checklist",
			],
			section_order: [
				"Summary",
				"Reasoning",
				"How to Test",
				"Risk/Rollback",
				"Self-review Checklist",
			],
			label_conventions: [
				"App-scope label matching the title bracket (e.g. ITC, DFF)",
				"Not every PR carries a label — apply only when the app scope is clear",
				"No bug/feat/chore type labels observed",
			],
			commit_msg_convention: "c".repeat(235),
			reviewer_patterns: "r".repeat(205),
			example_titles: [
				"[ITC] Merge retroactive PO and Invoice into the restructured 1-2 folder",
				"[ITC] Restructure 1-2 Folder - No Subfolders",
				"[ITC] Standardize invoice file naming convention",
				"[ITC] Purchase order controller unit tests for create PO workflow",
				"DFF - Automate transplant funding stage columns from payment history",
			],
			notes: "n".repeat(601),
		},
		"TaskRecon:file-recon": { files: [] },
		"DesignFix:design": {
			files_to_modify: [
				{
					path: "apps/handled/src/routes/submit-retroactive.ts",
					rationale: "d".repeat(266),
					full_content: "f".repeat(1227),
				},
				{
					path: "apps/handled/src/routes/__tests__/submit-retroactive.rate-limit.test.ts",
					rationale: "d".repeat(300),
					full_content: "f".repeat(1825),
				},
			],
			test_additions: [
				{
					path: "apps/handled/src/routes/__tests__/submit-retroactive.rate-limit.test.ts",
					full_content: "t".repeat(1813),
					fails_without_fix: "w".repeat(119),
				},
			],
			branch_name: "security/hand-synth-01-submit-retroactive-rate-limit",
			commit_message: "security(hand-synth-01): rate-limit POST /submit-retroactive per user",
			pr_title: "security(HAND_SYNTH-01): per-user rate limit on /submit-retroactive",
			pr_body_sections: {
				summary: "Add per-user 10 req/min rate limiter to POST /submit-retroactive.",
				fix: "x".repeat(147),
				test_plan:
					"New vitest suite exercises the allow-10 / block-11th / per-user-scoped behaviors.",
				rollback_plan:
					"git revert the merge commit; no data migrations, no user re-auth required. Follow-up: none.",
				references: "Private advisory HAND_SYNTH-01.",
			},
			codeowners_paths: [
				"apps/handled/src/routes/submit-retroactive.ts",
				"apps/handled/src/routes/__tests__/submit-retroactive.rate-limit.test.ts",
			],
			fix_item_coverage: [
				{
					item: "Mount @handled/rate-limit-middleware on POST /submit-retroactive",
					status: "covered",
					files: ["apps/handled/src/routes/submit-retroactive.ts"],
					evidence: "createRateLimiter imported and applied as route-level middleware.",
				},
				{
					item: "10 requests / minute per user",
					status: "covered",
					files: ["apps/handled/src/routes/submit-retroactive.ts"],
					evidence: "windowMs: 60000, max: 10, per-user keyGenerator.",
				},
				{
					item: "HTTP 429 + Retry-After on breach",
					status: "covered",
					files: ["apps/handled/src/routes/submit-retroactive.ts"],
					evidence: "e".repeat(103),
				},
				{
					item: "Preserve prior-bundle correct state (TRP-P)",
					status: "not_applicable",
					files: [],
					evidence: "Prior bundle files_to_modify was empty; nothing to preserve byte-for-byte.",
				},
				{
					item: "Diagnose CI failure",
					status: "partial",
					files: [],
					evidence: "e".repeat(192),
				},
			],
		},
		"PreflightScratch:preflight-workspaces": { workspaces: ["@handled/source"] },
		"PreflightScratch:preflight-apply": {
			applied: true,
			changed_files: [
				"apps/handled/src/routes/submit-retroactive.ts",
				"apps/handled/src/routes/__tests__/submit-retroactive.rate-limit.test.ts",
			],
			errors: [],
		},
		"PreflightInstall:preflight-install": {
			installed: true,
			skipped: false,
			package_manager: "pnpm",
			wall_seconds: 5,
			stderr_tail: "",
		},
		"PreflightClassify:preflight-classify": {
			cheap: [
				"pnpm prettier --check .",
				"pnpm run lint",
				"pnpm nx affected --target=lint --base=origin/main",
			],
			expensive: ["pnpm nx affected --target=test --base=origin/main"],
		},
		"PreflightCheap:preflight:pnpm prettier --check .": {
			command: "pnpm prettier --check .",
			exit_code: 1,
			wall_seconds: 3,
			stderr_tail: "s".repeat(265),
		},
		"PreflightCheap:preflight:pnpm run lint": {
			command: "pnpm run lint",
			exit_code: 1,
			wall_seconds: 4,
			stderr_tail: "s".repeat(265),
		},
		"PreflightCheap:preflight:pnpm nx affected --target=lint --base=orig": {
			command: "pnpm nx affected --target=lint --base=origin/main",
			exit_code: 1,
			wall_seconds: 2,
			stderr_tail: 'undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "nx" not found',
		},
		"PreflightAutofix:preflight-autofix": {
			autofix_applied: [
				{
					tool: "prettier",
					files: ["apps/handled/src/routes/submit-retroactive.ts"],
					added_bytes: 0,
					exit_code: 0,
				},
				{
					tool: "eslint",
					files: ["apps/handled/src/routes/submit-retroactive.ts"],
					added_bytes: 0,
					exit_code: 0,
				},
			],
			updated_files: [],
		},
		"Adversarial:adversarial": {
			verdict: "SHIP",
			refute_attempts: [
				{
					claim: "Patch delivers task intent: per-user 10/min quota with 429 + Retry-After",
					evidence: "e".repeat(295),
					outcome: "CONFIRMED",
				},
				{
					claim:
						"Regression: keyGenerator throws when req.user missing, could 500 unauthenticated requests",
					evidence: "e".repeat(231),
					outcome: "REFUTED",
				},
				{
					claim: "Breaks public API",
					evidence: "e".repeat(129),
					outcome: "REFUTED",
				},
				{
					claim: "Regression test is load-bearing",
					evidence: "e".repeat(238),
					outcome: "CONFIRMED",
				},
				{
					claim: "Prior CI failures are environmental, not defects",
					evidence: "e".repeat(172),
					outcome: "PARTIAL",
				},
			],
			blockers: [],
			nice_to_haves: [
				"h".repeat(151),
				"Add a test asserting the window resets after 60s (fake timers) to lock the windowMs contract.",
			],
		},
		"Adversarial:semantic-adversarial": {
			findings: [
				{
					kind: "shared-state-timing",
					severity: "high",
					summary: "s".repeat(162),
					files: [],
					evidence: "e".repeat(120),
				},
			],
		},
		"Adversarial:completeness-refuter": {
			refuted: false,
			reason: "no advisory_fix_items to check",
			evidence: "",
			per_item: [],
		},
	},
	"clickup_synthetic-spike-solve-01": {
		"Load:fix-items-extract": { source: "missing", acceptance_criteria: [] },
		"TaskRecon:pr-style": {
			voice: "spike-solve stub",
			sections_used: [],
			section_order: [],
			label_conventions: [],
			commit_msg_convention: "",
			reviewer_patterns: "",
			example_titles: [],
			notes: "n".repeat(178),
		},
		"TaskRecon:file-recon": { files: [] },
		"SpikeWriteup:spike-writeup": {
			content: "w".repeat(22_842),
			suggested_follow_up: "",
		},
		"DesignFix:design": { files_to_modify: [], test_additions: [] },
	},
} as const;

// Load the per-fixture sanitize-manifest.json. It lists field paths where the
// fixture stored a sanitize-marker placeholder in place of a source hash.
// Those fields compare on `{sanitized, len}` only. Every other `fnv1a-<16hex>`
// marker compares on hash equality.
type SanitizeManifest = { readonly structural_shape_only?: readonly string[] };

function loadManifest(): SanitizeManifest {
	try {
		return JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, "sanitize-manifest.json"), "utf8"),
		) as SanitizeManifest;
	} catch {
		return {};
	}
}

// Relax hash equality only on the field paths named by the fixture manifest.
// A field path is a slash-joined key sequence rooted at the sanitized object
// (e.g. `spike_writeup`, `files_to_modify/0/full_content`). Every other field
// asserts hash equality directly.
function relaxManifestFields(value: unknown, manifest: SanitizeManifest, path = ""): unknown {
	const structural = new Set(manifest.structural_shape_only ?? []);
	function walk(v: unknown, p: string): unknown {
		if (Array.isArray(v)) {
			return v.map((x, i) => walk(x, `${p}/${i}`.replace(/^\//u, "")));
		}
		if (v && typeof v === "object") {
			const obj = v as Record<string, unknown>;
			if (obj.sanitized === true && typeof obj.len === "number" && typeof obj.hash === "string") {
				return structural.has(p) ? { sanitized: true, len: obj.len } : obj;
			}
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(obj)) {
				out[k] = walk(val, p ? `${p}/${k}` : k);
			}
			return out;
		}
		return v;
	}
	return walk(value, path);
}

// Strip fixture-only top-level metadata that is not part of the workflow's
// return contract (e.g. `_comment` sanitizer stamps). Captured post-hoc by
// the fixture-prep pipeline.
function stripFixtureMeta(expected: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(expected)) {
		if (!k.startsWith("_")) {
			out[k] = v;
		}
	}
	return out;
}

describe.each(FIXTURES)("trp-fix-task — parity against %s", (fixture) => {
	it("produces the recorded return shape", async () => {
		resetWorkflow();
		installReplayHost({ responses: RESPONSES[fixture] });
		const input = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, `${fixture}-input.json`), "utf8"),
		) as Record<string, unknown>;
		const actual = await run(input);

		const expectedRaw = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, `${fixture}-expected-output.json`), "utf8"),
		) as Record<string, unknown>;
		const expected = stripFixtureMeta(expectedRaw);
		const actualSanitized = sanitize(actual);
		const manifest = loadManifest();

		// vitest's built-in diff renders the mismatch human-readably on failure.
		expect(stableStringify(relaxManifestFields(actualSanitized, manifest))).toBe(
			stableStringify(relaxManifestFields(expected, manifest)),
		);
	});
});
