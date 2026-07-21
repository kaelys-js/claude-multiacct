// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Direct-call coverage for `modeRuns()` in `fix-task.ts` — the (stage,
// taskMode) skip predicate that mirrors the bash `mode_runs()` shell
// function. The driver itself only invokes `modeRuns` from Stage 12
// (`stage_child_ticket`), so the full case table (stage_design:*,
// stage_preflight:*, stage_apply:*, stage_client_ci:*, stage_poc_verify:*,
// stage_docker_attack:*, stage_commit:*, stage_tracker_post:*, stage_push)
// is only exercisable by calling `modeRuns` directly. That's what this
// file does — every case label + the two trailing `if (stage === ...)`
// blocks (stage_push, stage_child_ticket) get one row.
//
// WHY these branches matter: `modeRuns` encodes the mode-stage skip matrix
// that determines which stages the driver skips in each of the six task
// modes (spike-writeup, spike-solve, spike-full, solve, reproduce,
// support). Even though the current driver has inlined most of those
// gates rather than routing them through `modeRuns`, the predicate is
// still the canonical contract — a future refactor that re-wires the
// stages through `modeRuns` needs the whole table to keep working. A
// regression in any single row here silently changes the driver's
// stage-gating for one mode / stage combination.

/* oxlint-disable vitest/no-conditional-in-test, eslint/no-unused-vars */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modeRuns, type TaskMode } from "./fix-task.ts";

describe("modeRuns() — full (stage, mode) skip matrix", () => {
	// TRP_ALLOW_CHILD_TICKET_CREATE gets read inside the stage_child_ticket
	// branch — snapshot + restore so a stray value can't drift the truth
	// table between rows.
	const priorChildTicket = process.env.TRP_ALLOW_CHILD_TICKET_CREATE;

	beforeEach(() => {
		delete process.env.TRP_ALLOW_CHILD_TICKET_CREATE;
	});

	afterEach(() => {
		if (priorChildTicket === undefined) {
			delete process.env.TRP_ALLOW_CHILD_TICKET_CREATE;
		} else {
			process.env.TRP_ALLOW_CHILD_TICKET_CREATE = priorChildTicket;
		}
	});

	// ─── First switch block: 15 cases that all return false ──────────────
	//
	// These are the (stage_design | stage_preflight | stage_apply |
	// stage_client_ci | stage_poc_verify | stage_docker_attack |
	// stage_commit) × (spike-writeup | support) rows plus the one
	// stage_commit:reproduce edge case. The mapping is: the "content"
	// producers (spike-writeup only writes a doc) and the "no-op" mode
	// (support) skip every code-change stage.

	const firstSwitchCases: ReadonlyArray<readonly [string, TaskMode]> = [
		["stage_design", "spike-writeup"],
		["stage_design", "support"],
		["stage_preflight", "spike-writeup"],
		["stage_preflight", "support"],
		["stage_apply", "spike-writeup"],
		["stage_apply", "support"],
		["stage_client_ci", "spike-writeup"],
		["stage_client_ci", "support"],
		["stage_poc_verify", "spike-writeup"],
		["stage_poc_verify", "support"],
		["stage_docker_attack", "spike-writeup"],
		["stage_docker_attack", "support"],
		["stage_commit", "spike-writeup"],
		["stage_commit", "support"],
		["stage_commit", "reproduce"],
	];

	for (const [stage, mode] of firstSwitchCases) {
		it(`${stage}:${mode} → false (first-switch-block case label)`, () => {
			expect(modeRuns(stage, mode)).toBe(false);
		});
	}

	// ─── Second switch block: 3 cases that all return false ───────────────

	const secondSwitchCases: ReadonlyArray<readonly [string, TaskMode]> = [
		["stage_tracker_post", "spike-writeup"],
		["stage_tracker_post", "reproduce"],
		["stage_tracker_post", "support"],
	];

	for (const [stage, mode] of secondSwitchCases) {
		it(`${stage}:${mode} → false (second-switch-block case label)`, () => {
			expect(modeRuns(stage, mode)).toBe(false);
		});
	}

	// ─── stage_push branch: skips spike-writeup / reproduce / support ─────
	//
	// All four rows exercise the `if (stage === "stage_push")` outer branch
	// (index 0), plus the three inner mode checks + the "fall-through"
	// success case that returns true.

	it("stage_push:spike-writeup → false (skip)", () => {
		expect(modeRuns("stage_push", "spike-writeup")).toBe(false);
	});

	it("stage_push:reproduce → false (skip)", () => {
		expect(modeRuns("stage_push", "reproduce")).toBe(false);
	});

	it("stage_push:support → false (skip)", () => {
		expect(modeRuns("stage_push", "support")).toBe(false);
	});

	it("stage_push:solve → true (run)", () => {
		expect(modeRuns("stage_push", "solve")).toBe(true);
	});

	it("stage_push:spike-solve → true (run)", () => {
		expect(modeRuns("stage_push", "spike-solve")).toBe(true);
	});

	it("stage_push:spike-full → true (run)", () => {
		expect(modeRuns("stage_push", "spike-full")).toBe(true);
	});

	// ─── stage_child_ticket branch: only runs for spike-full + toggle ─────
	//
	// The Stage 12 caller is the sole production entry point that reaches
	// `modeRuns`. Cover the three shapes: wrong mode → false, right mode
	// but toggle off → false, right mode + toggle on → true. The default
	// case (unrelated stage) returns true — exercised via `stage_default`.

	it("stage_child_ticket:solve → false (only spike-full runs)", () => {
		expect(modeRuns("stage_child_ticket", "solve")).toBe(false);
	});

	it("stage_child_ticket:spike-full + toggle=false → false", () => {
		process.env.TRP_ALLOW_CHILD_TICKET_CREATE = "false";
		expect(modeRuns("stage_child_ticket", "spike-full")).toBe(false);
	});

	it("stage_child_ticket:spike-full + toggle unset → false", () => {
		delete process.env.TRP_ALLOW_CHILD_TICKET_CREATE;
		expect(modeRuns("stage_child_ticket", "spike-full")).toBe(false);
	});

	it("stage_child_ticket:spike-full + toggle=true → true", () => {
		process.env.TRP_ALLOW_CHILD_TICKET_CREATE = "true";
		expect(modeRuns("stage_child_ticket", "spike-full")).toBe(true);
	});

	// ─── Default case: an unknown stage returns true ──────────────────────

	it("unknown-stage:solve → true (default fall-through)", () => {
		expect(modeRuns("stage_unrecognized", "solve")).toBe(true);
	});
});
