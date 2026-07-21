// Contract test for `trp-recon-repo.ts`.
//
// WHY it matters: the existing behaviour tests (`trp-recon-repo.test.ts`) pin
// the workflow's return shape under replay, but they don't rule out a
// pathological implementation that memorised the recorded fixture shipped in
// `tests/fixtures/workflows/trp-recon-repo/` and returns it verbatim from a
// lookup table. A memoised implementation would still pass every replay-based
// test because the recorded fixture is exactly what the tests expect.
//
// This contract test rules that out with two independent claims:
//
//   1. Sub-agent invocation actually happens. The workflow drives
//      `agent(...)` calls through the mocked `@foundation/agents` Host. Any
//      implementation that skips the agent layer (memoised or otherwise)
//      emits zero `agent-request` journal entries.
//
//   2. The workflow executes against inputs it has never seen at record
//      time. A held-out fixture living OUTSIDE `tests/fixtures/workflows/`
//      supplies args + a response map whose distinctive `voice` value
//      appears nowhere in the shipped recorded fixture. A workflow that
//      returns the recorded fixture regardless of input surfaces a stale
//      voice and fails.
//
//   3. The phase orchestration is not stubbed. Load / PRStyleRecon /
//      TouchedFiles / Bundle must appear as phase-marker entries in the
//      journal in that exact order — a lookup-table stub emits none.

/* oxlint-disable vitest/no-conditional-in-test */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installReplayHost, resetWorkflow } from "@foundation/agents";
import { run } from "./trp-recon-repo.ts";

type HeldOutFixture = {
	readonly args: {
		readonly task_id: string;
		readonly task_id_slug: string;
		readonly client_repo: string;
		readonly default_branch: string;
		readonly pr_limit: number;
	};
	readonly responses: Record<string, unknown>;
	readonly expected: {
		readonly ok: boolean;
		readonly voice: string;
		readonly client_repo: string;
		readonly default_branch: string;
		readonly top_file_path: string;
	};
};

// Held-out fixture lives OUTSIDE tests/fixtures/workflows/ deliberately — the
// SFP1 contract is that a memoised workflow can only satisfy this test by
// actually running against the fixture's inputs.
const HELD_OUT_PATH = resolve(
	__dirname,
	"..",
	"..",
	"tests",
	"fixtures",
	"held-out",
	"trp-recon-repo-holdout-01.json",
);

function loadHeldOut(): HeldOutFixture {
	const raw = readFileSync(HELD_OUT_PATH, "utf8");
	return JSON.parse(raw) as HeldOutFixture;
}

describe("trp-recon-repo contract", () => {
	beforeEach(() => resetWorkflow());

	it("invokes at least one sub-agent via the mocked Host spy", async () => {
		const session = installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": {
					voice: "spy-voice",
					sections_used: [],
					section_order: [],
				},
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});

		await run({ client_repo: "spy/repo", task_id: "spy:1" });

		const entries = session.finish();
		const agentRequests = entries.filter((e) => e.kind === "agent-request");
		const labels = new Set(agentRequests.map((e) => (e as { label?: string }).label ?? ""));

		// A memoised-return workflow (no sub-agent calls) yields zero
		// agent-request entries — this expectation fails on it.
		expect(agentRequests.length).toBeGreaterThan(0);
		expect(labels.has("pr-style") || labels.has("touched-files")).toBe(true);
	});

	it("executes against a held-out fixture (not shipped under tests/fixtures/workflows/)", async () => {
		const fixture = loadHeldOut();

		installReplayHost({ responses: fixture.responses });

		const result = await run(fixture.args);

		// The distinctive `voice` value is unique to the held-out fixture and
		// does not appear in any file under tests/fixtures/workflows/. A
		// workflow that returns the shipped recorded fixture regardless of
		// input reads a stale voice and fails this equality.
		expect(result.ok).toBe(fixture.expected.ok);
		expect(result.voice).toBe(fixture.expected.voice);
		expect(result.client_repo).toBe(fixture.expected.client_repo);
		expect(result.default_branch).toBe(fixture.expected.default_branch);
		expect(result.top_files?.[0]?.path).toBe(fixture.expected.top_file_path);
	});

	it("emits Load, PRStyleRecon, TouchedFiles, Bundle phases in order — proving the phase orchestration is not stubbed", async () => {
		const session = installReplayHost({
			responses: {
				"PRStyleRecon:pr-style": {
					voice: "phase-check",
					sections_used: [],
					section_order: [],
				},
				"TouchedFiles:touched-files": { top_files: [] },
			},
		});

		await run({ client_repo: "phase/repo" });

		const entries = session.finish();
		const phases = entries
			.filter((e) => e.kind === "phase")
			.map((e) => (e as { title: string }).title);

		// A stub that returns the fixture emits no phase markers; the
		// full-orchestration workflow emits exactly these four in this order.
		expect(phases).toEqual(["Load", "PRStyleRecon", "TouchedFiles", "Bundle"]);
	});
});
