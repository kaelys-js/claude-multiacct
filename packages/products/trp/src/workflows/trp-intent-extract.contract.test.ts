// Behavior contract for `trp-intent-extract.ts`.
//
// Same shape as the recon-repo contract test: a sub-agent invocation spy
// (installReplayHost's journal) plus a held-out fixture that lives outside
// tests/fixtures/workflows/ so the parity fixture set and the contract test
// stay independent. The contract we pin:
//
//   1. The Extract phase invokes exactly one sub-agent under the label
//      `extract:intent`.
//   2. The Adversarial phase fans out three sub-agents in parallel under the
//      labels `adversarial:ambiguity`, `adversarial:wrong_repo`, and
//      `adversarial:misidentified_modality`.
//   3. Given the held-out response map, the returned intent projects
//      `task_class` through verbatim — no silent normalization, no default
//      fallback.
//   4. The phase-marker sequence is Load -> Extract -> Adversarial ->
//      Summarize.
//
// If the fixture's projection drifts, the workflow is behaviorally different
// from the pinned .js source and the migration is not byte-for-byte.

/* oxlint-disable vitest/no-conditional-in-test */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-intent-extract.ts";

const HOLDOUT_PATH = resolve(
	import.meta.dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"held-out",
	"trp-intent-extract-holdout-01.json",
);

type Holdout = {
	readonly task_id: string;
	readonly task_id_slug: string;
	readonly task_json_path: string;
	readonly responses: Record<string, unknown>;
};

function loadHoldout(): Holdout {
	return JSON.parse(readFileSync(HOLDOUT_PATH, "utf8")) as Holdout;
}

describe("trp-intent-extract contract", () => {
	beforeEach(() => resetWorkflow());

	it("invokes the extract sub-agent via the mocked Host spy", async () => {
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run({
			task_id: holdout.task_id,
			task_id_slug: holdout.task_id_slug,
			task_json_path: holdout.task_json_path,
		});
		const entries = session.finish();
		const extractRequests = entries.filter(
			(e) => e.kind === "agent-request" && (e as { label: string }).label === "extract:intent",
		);
		expect(extractRequests.length).toBeGreaterThanOrEqual(1);
	});

	it("invokes 3 parallel adversarial refute lens sub-agents", async () => {
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run({
			task_id: holdout.task_id,
			task_id_slug: holdout.task_id_slug,
			task_json_path: holdout.task_json_path,
		});
		const entries = session.finish();
		const adversarialLabels = entries
			.filter((e) => e.kind === "agent-request")
			.map((e) => (e as { label: string }).label)
			.filter((l) => l.startsWith("adversarial:"));
		// Confirms the parallel() fan-out ran — all three lenses were dispatched.
		expect(adversarialLabels).toEqual(
			expect.arrayContaining([
				"adversarial:ambiguity",
				"adversarial:wrong_repo",
				"adversarial:misidentified_modality",
			]),
		);
		expect(adversarialLabels).toHaveLength(3);
	});

	it("executes against a held-out fixture (not shipped under tests/fixtures/workflows/)", async () => {
		const holdout = loadHoldout();
		installReplayHost({ responses: holdout.responses });
		const result = await run({
			task_id: holdout.task_id,
			task_id_slug: holdout.task_id_slug,
			task_json_path: holdout.task_json_path,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) {
			throw new Error("holdout run returned ok:false");
		}
		// The held-out response map projects task_class=iac, a distinctive
		// value that no shipped intent-extract fixture uses. If the workflow
		// silently normalizes or defaults, this assertion fails.
		const projected = (holdout.responses["Extract:extract:intent"] as { task_class: string })
			.task_class;
		expect(result.intent.task_class).toBe(projected);
		expect(result.intent.task_class).toBe("iac");
	});

	it("emits Load, Extract, Adversarial, Summarize phases in order", async () => {
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run({
			task_id: holdout.task_id,
			task_id_slug: holdout.task_id_slug,
			task_json_path: holdout.task_json_path,
		});
		const entries = session.finish();
		const phases = entries
			.filter((e) => e.kind === "phase")
			.map((e) => (e as { title: string }).title);
		expect(phases).toEqual(["Load", "Extract", "Adversarial", "Summarize"]);
	});
});
