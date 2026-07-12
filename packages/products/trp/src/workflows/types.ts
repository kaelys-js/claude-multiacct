/**
 * `@foundation/trp` — shared workflow types.
 *
 * The 4 migrated workflows (`trp-recon-repo`, `trp-intent-extract`,
 * `trp-fix-task`, `trp-proof-generate`) each declare their own concrete
 * return type inline. This file collects the cross-workflow shapes the
 * parity harness and behavior tests import — Bundle envelopes, adversarial
 * verdicts, and the `RunFn` alias tests use to type the workflow imports.
 *
 * @module
 */

// A workflow's top-level result envelope. Every workflow returns SOMETHING
// with an `ok`/`ready_to_ship` field or an explicit failure record; tests
// discriminate on it. Kept as `unknown` so per-workflow return types stay
// declared at their own module boundary.
export type RunFn = (args: unknown) => Promise<unknown>;

// Adversarial refute-lens verdict shape used by trp-intent-extract's three
// lenses (ambiguity, wrong_repo, misidentified_modality).
export type LensVerdict = {
	readonly lens: string;
	readonly holds: boolean;
	readonly confidence: number;
	readonly reasoning: string;
	readonly counter_evidence?: string;
	readonly suggested_correction?: string;
};

// Proof-generate artefact record. Every artefact is a file the recorder
// wrote, with sha + timestamp + kind hint. The workflow returns an array of
// these; the parity comparator projects on `.kind`.
export type ProofArtefact = {
	readonly path: string;
	readonly sha256: string;
	readonly timestamp: string;
	readonly bytes?: number;
	readonly kind?: string;
};

// Intent-extract's projected form used by the parity comparator. The
// fixture expected-output shape (`detected_mode/confidence/rationale`) is
// a mode-detection oracle, not a full workflow-return capture.
export type IntentModeProjection = {
	readonly detected_mode: string;
	readonly confidence: "high" | "medium" | "low";
	readonly rationale: string;
};

// Recon-repo's return envelope. Shape is stable across the .js source and
// the .ts migration; tests deep-equal against sanitized form.
export type ReconRepoResult = {
	readonly ok: boolean;
	readonly task_id?: string;
	readonly task_id_slug?: string;
	readonly client_repo?: string;
	readonly default_branch?: string | null;
	readonly voice?: string;
	readonly sections_used?: readonly string[];
	readonly section_order?: readonly string[];
	readonly label_conventions?: readonly string[];
	readonly commit_msg_convention?: string;
	readonly reviewer_patterns?: string;
	readonly example_titles?: readonly string[];
	readonly notes?: string;
	readonly top_files?: ReadonlyArray<{
		path: string;
		touch_count: number;
		example_prs?: readonly number[];
	}>;
	readonly top_files_notes?: string;
	readonly error?: string;
};

// Fixture pair discovered by the parity harness. Both files live under
// `tests/fixtures/workflows/<workflow>/` next to a sanitize-manifest.json.
export type FixturePair = {
	readonly slug: string;
	readonly inputPath: string;
	readonly expectedPath: string;
};
