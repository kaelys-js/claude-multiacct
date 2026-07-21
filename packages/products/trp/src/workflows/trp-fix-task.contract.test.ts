// Behavior contract for `trp-fix-task.ts`.
//
// Same shape as trp-recon-repo.contract.test.ts: install a replay Host,
// drive the workflow through the happy path with a fixture the workflow
// has never seen (held out from tests/fixtures/workflows/), and assert on
// the emitted journal — not on the recorded response bytes. A contract
// test that only replayed the shipped fixture would confirm the workflow
// still matches its own recording, not that it still satisfies the
// downstream contract.

/* oxlint-disable vitest/no-conditional-in-test */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { installReplayHost, type JournalEntry, resetWorkflow } from "@foundation/agents";
import { meta, run } from "./trp-fix-task.ts";

const HERE = import.meta.dirname;

// Held-out fixture — deliberately NOT under tests/fixtures/workflows/, so
// the workflow module cannot accidentally replay against it during normal
// dev runs. Loaded lazily per test so a corrupted JSON surfaces as a test
// failure, not a module-load crash.
const HOLDOUT_PATH = join(
	HERE,
	"..",
	"..",
	"tests",
	"fixtures",
	"held-out",
	"trp-fix-task-holdout-01.json",
);

type Holdout = {
	readonly args: Record<string, unknown>;
	readonly responses: Readonly<Record<string, unknown>>;
};

function loadHoldout(): Holdout {
	return JSON.parse(readFileSync(HOLDOUT_PATH, "utf8")) as Holdout;
}

function requestsFor(
	entries: readonly JournalEntry[],
	phase: string,
): Array<{ label: string; phase: string }> {
	return entries
		.filter(
			(e): e is Extract<JournalEntry, { kind: "agent-request" }> => e.kind === "agent-request",
		)
		.filter((e) => e.phase === phase)
		.map((e) => ({ label: e.label, phase: e.phase }));
}

function phaseTitles(entries: readonly JournalEntry[]): string[] {
	return entries
		.filter((e): e is Extract<JournalEntry, { kind: "phase" }> => e.kind === "phase")
		.map((e) => e.title);
}

beforeEach(() => resetWorkflow());

describe("trp-fix-task contract", () => {
	it("invokes the DesignFix sub-agent via the mocked Host spy", async () => {
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run(holdout.args);
		const entries = session.finish();
		const designRequests = requestsFor(entries, "DesignFix");
		expect(designRequests.length).toBeGreaterThanOrEqual(1);
		// First DesignFix agent-request is either `design` (fresh) or
		// `design:revise-a<N>` (revise mode); anything else is drift.
		const [first] = designRequests;
		expect(first).toBeDefined();
		const label = first?.label ?? "";
		expect(label === "design" || label.startsWith("design:revise-a")).toBe(true);
	});

	it("invokes the preflight cheap-CI fan-out for the affected workspace", async () => {
		// The held-out fixture pins 1 affected workspace and 2 cheap commands
		// in the ci-commands table so this assertion is deterministic — any
		// drift in the PreflightCheap fan-out or the workspace-filter logic
		// changes the count.
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run(holdout.args);
		const entries = session.finish();
		const cheapRequests = requestsFor(entries, "PreflightCheap");
		expect(cheapRequests).toHaveLength(2);
		// Every cheap-CI agent-request carries the `preflight:` label prefix
		// per the workflow's `label: preflight:${cmd.slice(0, 40)}` shape.
		for (const req of cheapRequests) {
			expect(req.label.startsWith("preflight:")).toBe(true);
		}
	});

	it("executes against a held-out fixture (not shipped under tests/fixtures/workflows/)", async () => {
		const holdout = loadHoldout();
		const heldOutSlug = String(holdout.args.task_id_slug ?? "");
		const heldOutMode = String(holdout.args.mode ?? holdout.args.task_mode ?? "");
		// Sanity — the fixture must actually be distinctive; if either field
		// is empty the assertions below reduce to no-ops.
		expect(heldOutSlug.length).toBeGreaterThan(0);
		expect(heldOutMode.length).toBeGreaterThan(0);
		const session = installReplayHost({ responses: holdout.responses });
		const result = await run(holdout.args);
		session.finish();
		expect(String(result.branch_name ?? "")).toContain(heldOutSlug);
		expect(String(result.mode ?? "")).toBe(heldOutMode);
	});

	it("emits every phase in the recorded phase order for the happy path", async () => {
		const holdout = loadHoldout();
		const session = installReplayHost({ responses: holdout.responses });
		await run(holdout.args);
		const entries = session.finish();
		// Ground truth is meta.phases — the workflow contract IS that ordering.
		// A hand-transcribed list here would drift from the workflow the first
		// time a phase is added or renamed; sourcing from meta.phases means the
		// contract check moves with the workflow.
		const expected = meta.phases.map((p) => p.title);
		const emitted = phaseTitles(entries);
		expect(emitted).toEqual(expected);
	});
});
