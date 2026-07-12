// Behavior contract for `trp-proof-generate.ts`.
//
// Same shape as `trp-recon-repo.contract.test.ts` — a small pinned set
// of behaviours the workflow MUST honour regardless of internal refactors:
// the three sub-agent labels it invokes, the phase sequence it emits, the
// held-out fixture round-trip that a memoised-fixture implementation
// cannot fake, and the unknown-modality bail-out that must precede any
// plan agent request.
//
// The held-out fixture at
// `packages/products/trp/tests/fixtures/held-out/trp-proof-generate-holdout-01.json`
// carries distinctive `dest_dir` + `modality` markers that appear NOWHERE
// in `tests/fixtures/workflows/trp-proof-generate/` — an implementation
// that satisfies the contract by fixture lookup would return the shipped
// recorded values, not the held-out markers, and this test would fail.

/* oxlint-disable vitest/no-conditional-in-test */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-proof-generate.ts";

// Load the held-out fixture at import time so a missing / malformed
// fixture surfaces as a hard failure at collection, not a subtle mid-test
// undefined access.
const HOLDOUT_PATH = fileURLToPath(
	new URL("../../tests/fixtures/held-out/trp-proof-generate-holdout-01.json", import.meta.url),
);
const HOLDOUT = JSON.parse(readFileSync(HOLDOUT_PATH, "utf8")) as {
	args: Record<string, unknown>;
	responses: Record<string, unknown>;
	expected: {
		dest_dir: string;
		modality: string;
		artefacts_length: number;
	};
};

// Baseline args reused by the non-fixture tests. Mirrors the shape
// `scripts/fix-task.sh` passes at runtime and matches the pattern in
// `trp-proof-generate.test.ts` so the two files read together cleanly.
const BASE_ARGS = {
	task_id: "clickup:HAND_ITC-308",
	task_id_slug: "hand-itc-308",
	client_repo: "tttstudios/handled",
	client_slug: "handled",
	fix_src_dir: "discovery/fix-src/handled-hand-itc-308",
	bundle_diff: "diff --git a/x b/x\n",
} as const;

const OK_PLAN = {
	repro_script_path: "discovery/proof/hand-itc-308/repro.sh",
	repro_script_body: "#!/usr/bin/env bash\necho ok\n",
	interpreter: "bash",
	reasoning: "chosen for modality",
};

const OK_RECORD = {
	exit_code: 0,
	stdout_tail: "ok",
	stderr_tail: "",
	dest_dir: "discovery/proof/hand-itc-308/",
	wrote_script: true,
};

const OK_MANIFEST = {
	artefacts: [
		{
			path: "discovery/proof/hand-itc-308/log.txt",
			sha256: "abc",
			timestamp: "2026-07-11T00:00:00Z",
			bytes: 4,
			kind: "log",
		},
	],
};

describe("trp-proof-generate contract", () => {
	beforeEach(() => resetWorkflow());

	it("invokes the plan-repro-script, record, and manifest sub-agents", async () => {
		const session = installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": OK_PLAN,
				"Record:invoke-proof-recorder": OK_RECORD,
				"Manifest:collect-manifest": OK_MANIFEST,
			},
		});
		await run({ ...BASE_ARGS, task_intent: { proof_modality: "backend" } });
		const entries = session.finish();
		const labels = entries
			.filter((e) => e.kind === "agent-request")
			.map((e) => (e as { label: string }).label);
		expect(labels).toEqual(["plan-repro-script", "invoke-proof-recorder", "collect-manifest"]);
	});

	it("executes against a held-out fixture (not shipped under tests/fixtures/workflows/)", async () => {
		installReplayHost({
			responses: HOLDOUT.responses,
		});
		const result = await run(HOLDOUT.args);
		// The held-out `dest_dir` + `modality` markers appear NOWHERE in the
		// recorded-fixture tree; a memoised-fixture implementation would return
		// its own recorded values instead of these.
		expect(result.dest_dir).toBe(HOLDOUT.expected.dest_dir);
		expect(result.modality).toBe(HOLDOUT.expected.modality);
		expect(result.artefacts).toHaveLength(HOLDOUT.expected.artefacts_length);
	});

	it("skips PlanScript when modality is unknown and returns an error record", async () => {
		const session = installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": OK_PLAN,
				"Record:invoke-proof-recorder": OK_RECORD,
				"Manifest:collect-manifest": OK_MANIFEST,
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "not-a-modality" },
		});
		const entries = session.finish();
		const planReq = entries.find(
			(e) => e.kind === "agent-request" && (e as { label: string }).label === "plan-repro-script",
		);
		expect(planReq).toBeUndefined();
		expect(result.modality).toBe("not-a-modality");
		expect(result.error).toMatch(/unknown/u);
		expect(result.artefacts).toEqual([]);
	});

	it("emits Load, PlanScript, Record, Manifest phases in order for a valid modality", async () => {
		const session = installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": OK_PLAN,
				"Record:invoke-proof-recorder": OK_RECORD,
				"Manifest:collect-manifest": OK_MANIFEST,
			},
		});
		await run({ ...BASE_ARGS, task_intent: { proof_modality: "backend" } });
		const entries = session.finish();
		const phases = entries
			.filter((e) => e.kind === "phase")
			.map((e) => (e as { title: string }).title);
		expect(phases).toEqual(["Load", "PlanScript", "Record", "Manifest"]);
	});
});
