// Parity test for trp-proof-generate against the single recorded fixture pair.
//
// WHY the shape is projected instead of compared byte-for-byte: the fixture
// was captured from a real proof-directory dump and carries post-processing
// fields the workflow never emits (`rendered_markdown`, `posted`,
// `posted_comment_id`, `status_transition`, `_fixture_*` metadata). The
// workflow's ProofResult shape is deliberately narrower — modality +
// artefacts + dest_dir + task ids. Comparing the full expected verbatim
// would force the workflow to reach into downstream posting logic that
// lives in a separate stage; comparing the projected oracle keeps the
// contract at the layer trp-proof-generate actually owns.
//
// Oracle: {mode, artefacts_kinds, dest_dir}. `mode` maps actual.modality to
// the fixture's `mode` field (renamed at post-processing time). Kinds are
// sorted so array-order drift in the manifest agent's response does not
// break the assertion. dest_dir is a literal string match.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-proof-generate.ts";
import { stableStringify } from "./sanitize.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"workflows",
	"trp-proof-generate",
);

// Response map keyed by `<phase>:<label>` — the same convention the
// recon-repo parity test uses. Each entry names one agent() call in
// trp-proof-generate.ts and returns the minimum payload the workflow
// needs to reach its return statement.
//
// - PlanScript:plan-repro-script — iac path. `interpreter: "none"` +
//   empty body is what MODALITY_HINTS.iac tells the plan agent to
//   emit; the workflow skips the script-write step when it sees this.
// - Record:invoke-proof-recorder — the recorder-run result. `exit_code`
//   must be 0 for the workflow to advance to Manifest; `dest_dir`
//   matches the fixture's expected value verbatim.
// - Manifest:collect-manifest — two artefacts, one `writeup` + one
//   `payload`, matching the kinds the fixture recorded.
const RESPONSES = {
	"PlanScript:plan-repro-script": {
		repro_script_path: "discovery/proof/clickup_hand_itc-308/repro.sh",
		repro_script_body: "",
		interpreter: "none",
		reasoning:
			"iac modality — recorder snapshots terraform plan + docker compose config on its own.",
	},
	"Record:invoke-proof-recorder": {
		exit_code: 0,
		dest_dir: "discovery/proof/clickup_hand_itc-308/",
		stdout_tail: "",
		stderr_tail: "",
		wrote_script: false,
	},
	"Manifest:collect-manifest": {
		artefacts: [
			{
				path: "discovery/proof/clickup_hand_itc-308/spike-writeup.md",
				sha256: "fnv1a-writeup-placeholder",
				timestamp: "2026-01-01T00:00:00Z",
				bytes: 12_526,
				kind: "writeup",
			},
			{
				path: "discovery/proof/clickup_hand_itc-308/comment-payload.json",
				sha256: "fnv1a-payload-placeholder",
				timestamp: "2026-01-01T00:00:00Z",
				bytes: 6470,
				kind: "payload",
			},
		],
	},
} as const;

// Projection oracle. `actual` is the workflow's ProofResult:
// {modality, artefacts, dest_dir, task_id, task_id_slug, ...}. The
// oracle keeps only the three fields that describe what the workflow
// produced — mode (renamed from modality), the sorted kind set, and
// the recorder's output directory.
type ProofArtefactLike = { kind?: string };
type ProofActualLike = {
	modality?: string | null;
	artefacts?: readonly ProofArtefactLike[];
	dest_dir?: string;
};

function projectToProofOracle(actual: ProofActualLike): {
	mode: string | null | undefined;
	artefacts_kinds: string[];
	dest_dir: string | undefined;
} {
	return {
		mode: actual.modality,
		artefacts_kinds: (actual.artefacts ?? []).map((a) => a.kind ?? "").toSorted(),
		dest_dir: actual.dest_dir,
	};
}

// Expected is projected the same way. `expected.mode` is already the
// renamed field (post-processing wrote it as `mode` when the fixture
// was captured), so the projection reads it directly instead of via
// `.modality`.
type ProofExpectedLike = {
	mode?: string;
	artefacts?: ReadonlyArray<{ kind?: string }>;
	dest_dir?: string;
};

function projectExpected(expected: ProofExpectedLike): {
	mode: string | null | undefined;
	artefacts_kinds: string[];
	dest_dir: string | undefined;
} {
	return {
		mode: expected.mode,
		artefacts_kinds: (expected.artefacts ?? []).map((a) => a.kind ?? "").toSorted(),
		dest_dir: expected.dest_dir,
	};
}

describe("trp-proof-generate — parity against recorded fixture", () => {
	it("produces the projected oracle on the single hand-itc-308 fixture", async () => {
		resetWorkflow();
		installReplayHost({ responses: RESPONSES });

		// Load the ClickUp-shaped input record. The workflow itself does
		// not consume this shape — it reads a normalised args bundle the
		// driver assembles. We load the file so the fixture path is
		// exercised (any drift in the fixture layout surfaces here) and
		// so the args below stay traceable back to the task record.
		const input = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, "hand-itc-308-input.json"), "utf8"),
		) as { custom_id?: string };
		// Touch the field so the fixture-shape drift surfaces here without
		// binding the value to a variable the linter would call unused.
		expect(input).toBeDefined();

		const args = {
			task_id: "clickup:HAND_ITC-308",
			task_id_slug: "clickup_hand_itc-308",
			task_intent: { proof_modality: "iac" },
			bundle_diff: "",
			client_repo: "tttstudios/handled",
			fix_src_dir: "discovery/fix-src/handled-hand-itc-308",
		};

		const actual = await run(args);

		const expected = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, "hand-itc-308-expected-output.json"), "utf8"),
		) as ProofExpectedLike;

		expect(stableStringify(projectToProofOracle(actual))).toBe(
			stableStringify(projectExpected(expected)),
		);
	});
});
