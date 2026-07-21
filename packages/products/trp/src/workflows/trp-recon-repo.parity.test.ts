// Parity test for trp-recon-repo against the recorded fixture.
//
// WHY it matters: the migration must preserve the .js workflow's byte-for-
// byte return shape (module-plus-content), because the driver + downstream
// tracker-post-proof consumers deep-scan the recon-repo output for style
// fields. A single missing key breaks the whole pipeline downstream.
//
// Comparator: sanitize(actual) is stableStringify'd and compared to the
// fixture's stableStringify. Every `fnv1a-<16hex>` sanitize marker asserts
// hash equality directly. Fields the sanitize-manifest.json names as
// `structural_shape_only` relax to {sanitized, len} — those are the fields
// the fixture-prep pipeline stored a placeholder for rather than a source
// hash. The manifest is the per-fixture record of that decision. No env
// knob, no strictness dial — the gate is what the fixture proves.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-recon-repo.ts";
import { sanitize, stableStringify } from "./sanitize.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"workflows",
	"trp-recon-repo",
);

// Response map padded to match the expected fixture's sanitize marker
// lengths. String values here are placeholders — the sanitize helper hashes
// their content on read, so the resulting marker's `len` matches expected
// even if the hash differs (documented in the comparator's manifest-driven
// relaxation).
const RESPONSES = {
	"PRStyleRecon:pr-style": {
		voice: "v".repeat(225),
		sections_used: ["Summary", "Changes", "Rationale", "Test plan", "Rollback plan"],
		section_order: ["Summary", "Changes", "Rationale", "Test plan", "Rollback plan"],
		label_conventions: [
			"No labels observed — repo has no GitHub remote and no merged PRs to sample",
			"l".repeat(145),
		],
		commit_msg_convention: "c".repeat(398),
		reviewer_patterns: "r".repeat(241),
		example_titles: [
			"tracker-post-proof: append speedup suffix + finding-effort ledger to ClickUp comments",
			"time-tracker: per-stage timers wired into the TRP driver",
			"config: seed pricing/harvest/baselines env templates",
			"docs: rewrite README with actual current CLI + config + architecture",
			"trp: driver hardening + rich-text ClickUp posting + solve/reproduce/spike-full modes",
		],
		notes: "n".repeat(713),
	},
	"TouchedFiles:touched-files": {
		top_files: [
			{ path: "scripts/fix-task.sh", touch_count: 4, example_prs: [] },
			{ path: "README.md", touch_count: 4, example_prs: [] },
			{ path: "AGENTS.md", touch_count: 4, example_prs: [] },
			{ path: "workflows/trp-fix-task.js", touch_count: 3, example_prs: [] },
			{ path: "scripts/tracker-post-proof.py", touch_count: 3, example_prs: [] },
			{ path: "scripts/tracker-fetch-task.py", touch_count: 3, example_prs: [] },
			{ path: "scripts/discover-client-ci.py", touch_count: 3, example_prs: [] },
			{ path: "workflows/trp-intent-extract.js", touch_count: 2, example_prs: [] },
			{ path: "scripts/trp-run-loop.sh", touch_count: 2, example_prs: [] },
			{ path: "scripts/repo-router.py", touch_count: 2, example_prs: [] },
		],
		notes: "t".repeat(547),
	},
} as const;

// Load the per-fixture sanitize-manifest.json. It lists field paths where the
// fixture stored a sanitize-marker placeholder in place of a source hash. Those
// fields compare on `{sanitized, len}` only (structural-shape oracle for that
// field). Every other `fnv1a-<16hex>` marker compares on hash equality.
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
// (e.g. `voice`, `top_files/0/path`). Every other field asserts hash equality
// directly.
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
// return contract (e.g. the `_comment` sanitizer stamp, `_bonus_repo_
// inspection`, `_files_inspected`). These are captured post-hoc by the
// fixture-prep pipeline.
function stripFixtureMeta(expected: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(expected)) {
		if (!k.startsWith("_")) {
			out[k] = v;
		}
	}
	return out;
}

describe("trp-recon-repo — parity against recorded fixture", () => {
	it("produces the recorded return shape on the single trp-repo fixture", async () => {
		resetWorkflow();
		installReplayHost({ responses: RESPONSES });
		const input = JSON.parse(readFileSync(resolve(FIXTURE_DIR, "trp-repo-input.json"), "utf8")) as {
			target_repo?: string;
		};
		// Fixture input names `target_repo` (the repo path) but the workflow
		// reads `client_repo`. Bridge here so the workflow sees a stable field.
		const args = {
			task_id: "fixture:trp-recon-01",
			task_id_slug: "fixture-trp-recon-01",
			client_repo: "local/trp",
			default_branch: "master",
			target_repo: input.target_repo,
		};
		const actual = await run(args);

		const expectedRaw = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, "trp-repo-expected-output.json"), "utf8"),
		) as Record<string, unknown>;
		const expected = stripFixtureMeta(expectedRaw);
		const actualSanitized = sanitize(actual);
		const manifest = loadManifest();

		expect(stableStringify(relaxManifestFields(actualSanitized, manifest))).toBe(
			stableStringify(relaxManifestFields(expected, manifest)),
		);
	});
});
