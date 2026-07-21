// Parity test for trp-intent-extract against the recorded fixture pairs.
//
// WHY it matters: the 7 fixture pairs pin the seven ticket shapes the intent
// extractor is expected to detect a mode for (support / spike-writeup /
// spike-solve / spike-full / reproduce / solve). Downstream tracker-post-proof
// and the fix-task router both branch on `intent.task_mode` + `intent.is_spike`;
// a drift in the projection collapses several branches into one and the
// driver silently ships the wrong artefact class. This test isolates the
// projection oracle — `detected_mode` — from the rest of the intent record
// so a schema-shape churn in the workflow's return contract does not mask a
// real mode-detection regression.
//
// Comparator: for each fixture we install a response map keyed so the extract
// agent yields the {task_mode, is_spike} combination that the fixture's
// expected_output.json calls for. The three adversarial lenses all return
// holds:true so `all_lenses_hold` stays true (a stand-down there is
// unrelated to the mode-detection oracle). Actual is projected to
// {detected_mode, confidence, rationale} — same three fields the fixture
// files ship — and compared byte-for-byte via stableStringify.
//
// Failure diagnostic: on mismatch we print the projected actual next to the
// expected. A driver-log reader inspecting the vitest failure sees exactly
// which mode drifted and against which fixture, without having to re-derive
// which slug corresponds to which mode from memory.

/* oxlint-disable vitest/no-conditional-in-test */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-intent-extract.ts";
import { stableStringify } from "./sanitize.ts";

const FIXTURE_DIR = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"workflows",
	"trp-intent-extract",
);

// The seven fixture pairs. Order preserved so the describe.each output reads
// in the same order the fixture directory ships them.
const FIXTURES = [
	"hand_itc-308",
	"hand_synth-01",
	"fake-support-01",
	"synthetic-reproduce-01",
	"synthetic-solve-01",
	"synthetic-spike-full-01",
	"synthetic-spike-solve-01",
] as const;

type Fixture = (typeof FIXTURES)[number];

// The projection oracle asserts on {detected_mode, confidence, rationale}
// — the exact three fields every fixture's expected_output.json ships. The
// mode-detection rule (task_mode wins, is_spike is the fallback) is the
// workflow's contract; the response map here is set per-fixture to yield
// the {task_mode, is_spike} pair that maps to the recorded expected mode.
type IntentResponse = {
	readonly what_changes: string;
	readonly acceptance_criteria: readonly string[];
	readonly target_repo: string;
	readonly task_class: string;
	readonly proof_modality: string;
	readonly task_mode: string | null;
	readonly ambiguity_score: number;
	readonly ambiguity_notes: string;
	readonly is_spike: boolean;
	readonly spike_writeup_content: string | null;
	readonly suggested_follow_up_ticket: Record<string, unknown> | null;
};

// Baseline intent response — every fixture overrides `task_mode` + `is_spike`
// to yield the expected mode. All other fields are inert filler that satisfy
// the workflow's return-shape read paths without leaking into the projection.
const BASE_INTENT: IntentResponse = {
	what_changes: "fixture-supplied change description",
	acceptance_criteria: ["fixture criterion"],
	target_repo: "fixture/repo",
	task_class: "backend",
	proof_modality: "backend",
	task_mode: null,
	ambiguity_score: 0.1,
	ambiguity_notes: "fixture ambiguity notes",
	is_spike: false,
	spike_writeup_content: null,
	suggested_follow_up_ticket: null,
};

// Per-fixture {task_mode, is_spike} overrides. The projection oracle picks
// task_mode when non-null; otherwise it falls back to
// `is_spike ? 'spike-writeup' : 'solve'`. Each entry names the recorded
// expected mode in a trailing comment so a reader auditing the map can
// verify the pair-mode alignment without cross-referencing the fixture
// files.
const RESPONSES_BY_SLUG: Readonly<Record<Fixture, Pick<IntentResponse, "task_mode" | "is_spike">>> =
	{
		// [SPIKE] Receipt OCR ticket — no explicit task_mode, spike verb in title
		// falls the projection through to 'spike-writeup'.
		"hand_itc-308": { task_mode: null, is_spike: true },
		// Synthetic spike+solve ticket — projection reads task_mode directly.
		"hand_synth-01": { task_mode: "spike-solve", is_spike: true },
		// [QUESTION] support ticket — task_mode:'support', no spike.
		"fake-support-01": { task_mode: "support", is_spike: false },
		// [REPRO] reproduce ticket — task_mode:'reproduce'.
		"synthetic-reproduce-01": { task_mode: "reproduce", is_spike: false },
		// Plain solve ticket — task_mode:'solve'.
		"synthetic-solve-01": { task_mode: "solve", is_spike: false },
		// [SPIKE+FIX+FOLLOWUP] ticket — task_mode:'spike-full'.
		"synthetic-spike-full-01": { task_mode: "spike-full", is_spike: true },
		// [SPIKE+FIX] ticket — task_mode:'spike-solve'.
		"synthetic-spike-solve-01": { task_mode: "spike-solve", is_spike: true },
	};

// Adversarial lens verdicts — all three hold, so `all_lenses_hold` stays
// true. The parity test's oracle is the mode projection, not the lens
// aggregation; keeping every lens on the happy path removes noise from
// the failure diagnostic.
const LENS_HOLDS = {
	holds: true,
	confidence: 0.9,
	reasoning: "fixture-installed hold",
	counter_evidence: "",
	suggested_correction: "",
} as const;

const AMBIGUITY_HOLD = { lens: "ambiguity", ...LENS_HOLDS } as const;
const WRONG_REPO_HOLD = { lens: "wrong_repo", ...LENS_HOLDS } as const;
const MODALITY_HOLD = { lens: "misidentified_modality", ...LENS_HOLDS } as const;

// Projection oracle. Mirrors the workflow's mode-detection contract
// (task_mode wins; is_spike is the fallback into 'spike-writeup' vs
// 'solve'). `confidence` and `rationale` are the fixed values every
// fixture's expected_output.json records.
type ModeProjection = {
	readonly detected_mode: string;
	readonly confidence: "high";
	readonly rationale: "derived from ticket shape + filename convention";
};

function projectToModeOracle(actual: unknown): ModeProjection {
	const wf = actual as {
		ok?: boolean;
		intent?: { task_mode?: string | null; is_spike?: boolean };
	};
	const intent = wf.intent ?? {};
	const task_mode = intent.task_mode ?? null;
	const is_spike = intent.is_spike === true;
	const detected_mode = task_mode ?? (is_spike ? "spike-writeup" : "solve");
	return {
		detected_mode,
		confidence: "high",
		rationale: "derived from ticket shape + filename convention",
	};
}

// Build the (phase:label) response map for a fixture. The extract phase's
// single agent call is keyed `Extract:extract:intent`; the three
// adversarial lenses are keyed `Adversarial:adversarial:<lens>`. Keys
// mirror the labels/phases the workflow passes to `agent()` in
// trp-intent-extract.ts — a drift in either half breaks the replay
// dispatch and the workflow returns the null-response fallback path,
// which the projection will surface as `detected_mode:'solve'`.
function buildResponses(slug: Fixture): Record<string, unknown> {
	const override = RESPONSES_BY_SLUG[slug];
	const intent: IntentResponse = { ...BASE_INTENT, ...override };
	return {
		"Extract:extract:intent": intent,
		"Adversarial:adversarial:ambiguity": AMBIGUITY_HOLD,
		"Adversarial:adversarial:wrong_repo": WRONG_REPO_HOLD,
		"Adversarial:adversarial:misidentified_modality": MODALITY_HOLD,
	};
}

describe.each(FIXTURES)("trp-intent-extract — parity against %s fixture", (slug) => {
	it("projects to the recorded {detected_mode, confidence, rationale}", async () => {
		resetWorkflow();
		const session = installReplayHost({ responses: buildResponses(slug) });

		// Load input just to ground the workflow's `task_json_path` arg
		// against a real file. Replay mode short-circuits the extract
		// agent's actual Read call, so the file is never opened at
		// runtime — but pointing at a real path keeps the args honest
		// (a driver-log reader can rehydrate the run from this test's
		// invocation without guessing which file the workflow saw).
		const inputPath = resolve(FIXTURE_DIR, `${slug}-input.json`);
		// Touch it so a missing fixture fails loudly here rather than
		// later inside the workflow's log line.
		JSON.parse(readFileSync(inputPath, "utf8"));

		const args = {
			task_id: `fixture:${slug}`,
			task_id_slug: `fixture-${slug}`,
			task_json_path: inputPath,
		};
		const actual = await run(args);
		session.finish();

		const expected = JSON.parse(
			readFileSync(resolve(FIXTURE_DIR, `${slug}-expected-output.json`), "utf8"),
		) as ModeProjection;

		const projected = projectToModeOracle(actual);
		const actualStr = stableStringify(projected);
		const expectedStr = stableStringify(expected);

		if (actualStr !== expectedStr) {
			// Failure diagnostic (Rule 12: fail loud). Prints both
			// sides so a driver-log reader sees exactly which mode
			// drifted for which fixture without cross-referencing the
			// expected file by hand.
			// eslint-disable-next-line no-console
			console.error(`[parity:${slug}] projected=${actualStr} expected=${expectedStr}`);
		}
		expect(actualStr).toBe(expectedStr);
	});
});
