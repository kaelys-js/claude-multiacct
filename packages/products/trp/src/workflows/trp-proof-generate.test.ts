// Behavior tests for `trp-proof-generate.ts`.
//
// WHY it matters: proof-generate is the modality-dispatch node in TRP's
// fix pipeline. If it silently accepts an unknown modality, or folds a
// null plan-agent into a happy path, the downstream tracker-post-proof
// call ships an empty manifest and the reviewer sees "proof captured"
// with nothing behind it. These tests fix each branch — validation,
// per-modality dispatch, plan null, recorder non-zero, empty manifest,
// revise-mode prompt — with a replay Host so the journal is
// deterministic, then assert on the return shape AND the prompt bytes
// the plan agent actually saw.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRequest,
	drainJournal,
	type Host,
	installReplayHost,
	resetWorkflow,
	setHost,
} from "@foundation/agents";
import { run } from "./trp-proof-generate.ts";

beforeEach(() => resetWorkflow());

// Baseline args every non-validation test reuses. The plan/record/manifest
// responses key off `<phase>:<label>` — matching the pattern the recon-repo
// tests already lean on for identical replay-host semantics.
const BASE_ARGS = {
	task_id: "clickup:HAND_ITC-308",
	task_id_slug: "hand-itc-308",
	client_repo: "tttstudios/handled",
	client_slug: "handled",
	fix_src_dir: "discovery/fix-src/handled-hand-itc-308",
	bundle_diff: "diff --git a/x b/x\n",
} as const;

type OkPlan = {
	repro_script_path: string;
	repro_script_body: string;
	interpreter: string;
	reasoning: string;
};
const okPlan = (interpreter: string, path = "discovery/proof/hand-itc-308/repro.sh"): OkPlan => ({
	repro_script_path: path,
	repro_script_body: "#!/usr/bin/env bash\necho ok\n",
	interpreter,
	reasoning: "chosen for modality",
});

const okRecord = {
	exit_code: 0,
	stdout_tail: "ok",
	stderr_tail: "",
	dest_dir: "discovery/proof/hand-itc-308/",
	wrote_script: true,
};

const okManifest = {
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

describe("trp-proof-generate — validation", () => {
	it("returns error when proof_modality is missing", async () => {
		const result = await run({ ...BASE_ARGS, task_intent: {} });
		expect(result.modality).toBeNull();
		expect(result.artefacts).toEqual([]);
		expect(result.error).toBe("task_intent.proof_modality missing");
	});

	it("returns error when modality is not one of the 5 valid values", async () => {
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "hologram" },
		});
		expect(result.modality).toBe("hologram");
		expect(result.artefacts).toEqual([]);
		expect(result.error).toMatch(/unknown modality/u);
		expect(result.error).toMatch(/ui, backend, terminal, iac, bugfix-red-green/u);
	});
});

describe("trp-proof-generate — per-modality dispatch", () => {
	const cases: Array<{ modality: string; interpreter: string }> = [
		{ modality: "ui", interpreter: "playwright" },
		{ modality: "backend", interpreter: "bash" },
		{ modality: "terminal", interpreter: "bash" },
		{ modality: "iac", interpreter: "none" },
		{ modality: "bugfix-red-green", interpreter: "bash" },
	];

	for (const { modality, interpreter } of cases) {
		it(`records interpreter=${interpreter} and repro_script_path under discovery/proof/<slug>/ for ${modality}`, async () => {
			installReplayHost({
				responses: {
					"PlanScript:plan-repro-script": okPlan(interpreter),
					"Record:invoke-proof-recorder": okRecord,
					"Manifest:collect-manifest": okManifest,
				},
			});
			const result = await run({
				...BASE_ARGS,
				task_intent: { proof_modality: modality },
			});
			expect(result.modality).toBe(modality);
			expect(result.artefacts).toHaveLength(1);
			// iac drops repro_script_path from the return; every other modality
			// exposes it, and it must be scoped under discovery/proof/<slug>/.
			if (interpreter === "none") {
				expect(result.repro_script_path).toBeUndefined();
			} else {
				expect(result.repro_script_path).toMatch(/^discovery\/proof\/hand-itc-308\//u);
			}
			expect(result.dest_dir).toBe("discovery/proof/hand-itc-308/");
			expect(result.task_id).toBe("clickup:HAND_ITC-308");
			expect(result.task_id_slug).toBe("hand-itc-308");
		});
	}
});

describe("trp-proof-generate — plan agent null", () => {
	it("aborts with 'plan-repro-script returned no repro_script_path' when the plan agent returns null", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": null,
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.artefacts).toEqual([]);
		expect(result.error).toBe("plan-repro-script returned no repro_script_path");
	});
});

describe("trp-proof-generate — recorder non-zero exit", () => {
	it("returns 'proof-recorder non-zero exit' and surfaces stderr_tail when the recorder fails", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": {
					exit_code: 1,
					stdout_tail: "",
					stderr_tail: "connection refused",
					dest_dir: "discovery/proof/hand-itc-308/",
					wrote_script: true,
				},
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.artefacts).toEqual([]);
		expect(result.error).toBe("proof-recorder non-zero exit");
		expect(result.stderr_tail).toBe("connection refused");
		expect(result.repro_script_path).toMatch(/^discovery\/proof\/hand-itc-308\//u);
	});
});

describe("trp-proof-generate — empty manifest", () => {
	it("returns success shape with artefacts:[] when the manifest agent produced nothing", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": okRecord,
				"Manifest:collect-manifest": { artefacts: [] },
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.artefacts).toEqual([]);
		expect(result.error).toBeUndefined();
		expect(result.dest_dir).toBe("discovery/proof/hand-itc-308/");
	});
});

describe("trp-proof-generate — prior attempt (revise mode)", () => {
	// Capture the plan prompt via a custom Host so we can assert on the prompt
	// body directly. installReplayHost hashes prompts into the journal but does
	// not expose the raw string — this Host does. Same pattern as
	// trp-intent-extract.test.ts's `capturingHost`.
	function capturingHost(): { host: Host; captured: AgentRequest[] } {
		const captured: AgentRequest[] = [];
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push(request);
				if (request.label === "plan-repro-script") {
					return Promise.resolve(okPlan("bash"));
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		return { host, captured };
	}

	it("threads 'Prior attempt failed' + JSON.stringify(previous_attempt) into the plan prompt", async () => {
		const { host, captured } = capturingHost();
		setHost(host);
		const previous_attempt = {
			attempt_number: 2,
			prior_manifest: { artefacts: [] },
			failure: "screenshot missing",
		};
		await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
			previous_attempt,
		});
		const planReq = captured.find((r) => r.label === "plan-repro-script");
		expect(planReq).toBeDefined();
		expect(planReq?.prompt).toContain("Prior attempt failed");
		// Whitespace-tolerant match on the JSON block; the workflow calls
		// JSON.stringify(..., null, 2) and slices to 3000 chars — every field
		// we set here fits well under the cap.
		expect(planReq?.prompt).toContain(`"attempt": 2`);
		expect(planReq?.prompt).toContain(`"failure": "screenshot missing"`);
		expect(planReq?.prompt).toContain("Fix what the prior attempt got wrong");
	});

	it("omits the 'Prior attempt failed' block when previous_attempt is absent", async () => {
		const { host, captured } = capturingHost();
		setHost(host);
		await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		const planReq = captured.find((r) => r.label === "plan-repro-script");
		expect(planReq).toBeDefined();
		expect(planReq?.prompt).not.toContain("Prior attempt failed");
	});
});

describe("trp-proof-generate — parseArgs branches", () => {
	// Three branches to keep well-defined: JSON-string that parses,
	// JSON-string that throws (returns {} — caught by the modality gate),
	// and null/undefined raw (falls through to {} via nullish coalescing).
	it("parses a JSON-string arg the same as an object arg", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": okRecord,
				"Manifest:collect-manifest": okManifest,
			},
		});
		const result = await run(
			JSON.stringify({
				...BASE_ARGS,
				task_intent: { proof_modality: "backend" },
			}),
		);
		expect(result.modality).toBe("backend");
		expect(result.artefacts).toHaveLength(1);
	});

	it("returns the missing_modality error when rawArgs is a JSON string that fails to parse", async () => {
		// parseArgs catches the SyntaxError, returns {}. The modality gate then
		// aborts — but through the string→try/catch→{} branch, not the
		// non-string nullish branch.
		const result = await run("{not valid json");
		expect(result.modality).toBeNull();
		expect(result.error).toBe("task_intent.proof_modality missing");
	});

	it("returns the missing_modality error when rawArgs is null", async () => {
		const result = await run(null);
		expect(result.modality).toBeNull();
		expect(result.error).toBe("task_intent.proof_modality missing");
	});

	it("returns the missing_modality error when rawArgs is undefined", async () => {
		const result = await run(undefined);
		expect(result.modality).toBeNull();
		expect(result.error).toBe("task_intent.proof_modality missing");
	});
});

describe("trp-proof-generate — task_id / task_id_slug fallbacks", () => {
	// The task_id fallback ("unknown:UNKNOWN") and the task_id_slug derivation
	// from split(":").pop() are pure defaults. When callers pass NEITHER
	// task_id nor task_id_slug, the workflow must degrade gracefully rather
	// than propagating undefined into filename/dir-suffix templates.
	it("falls back to 'unknown:UNKNOWN' when task_id is missing", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash", "discovery/proof/unknown/repro.sh"),
				"Record:invoke-proof-recorder": {
					...okRecord,
					dest_dir: "discovery/proof/unknown/",
				},
				"Manifest:collect-manifest": okManifest,
			},
		});
		const result = await run({
			client_repo: "tttstudios/handled",
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.task_id).toBe("unknown:UNKNOWN");
		// Fallback slug derives from task_id via `split(":").pop() || "task"`.
		// "unknown:UNKNOWN" → "UNKNOWN" → "unknown".
		expect(result.task_id_slug).toBe("unknown");
	});

	it("derives task_id_slug from task_id when task_id_slug is missing", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash", "discovery/proof/task-123/repro.sh"),
				"Record:invoke-proof-recorder": {
					...okRecord,
					dest_dir: "discovery/proof/task-123/",
				},
				"Manifest:collect-manifest": okManifest,
			},
		});
		const result = await run({
			task_id: "clickup:TASK_123",
			// Deliberately no task_id_slug — force the split/pop derivation.
			client_repo: "tttstudios/handled",
			task_intent: { proof_modality: "backend" },
		});
		expect(result.task_id).toBe("clickup:TASK_123");
		expect(result.task_id_slug).toBe("task-123");
	});

	it("falls back to 'task' when the task_id ends with a colon (empty last segment)", async () => {
		// A task_id like "clickup:" splits to ["clickup", ""]; pop() returns
		// the empty string which is falsy — the `|| "task"` fallback fires.
		// Reachable when a tracker id upstream is malformed but non-empty
		// (which slips past the `ctx.task_id || "unknown:UNKNOWN"` gate).
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash", "discovery/proof/task/repro.sh"),
				"Record:invoke-proof-recorder": {
					...okRecord,
					dest_dir: "discovery/proof/task/",
				},
				"Manifest:collect-manifest": okManifest,
			},
		});
		const result = await run({
			task_id: "clickup:",
			client_repo: "tttstudios/handled",
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.task_id).toBe("clickup:");
		// The `|| "task"` fallback catches the empty-segment case.
		expect(result.task_id_slug).toBe("task");
	});
});

describe("trp-proof-generate — task_intent + proof_modality fallbacks", () => {
	// The workflow accepts modality via two paths: ctx.task_intent.proof_modality
	// (preferred) or ctx.proof_modality (fallback). Both branches must be
	// exercised so the second path isn't a silent no-op when task_intent is
	// missing.
	it("reads proof_modality from ctx.proof_modality when task_intent is absent", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": okRecord,
				"Manifest:collect-manifest": okManifest,
			},
		});
		const result = await run({
			...BASE_ARGS,
			// task_intent OMITTED — ctx.task_intent || {} falls through to {}
			proof_modality: "backend",
		});
		expect(result.modality).toBe("backend");
		expect(result.artefacts).toHaveLength(1);
	});
});

describe("trp-proof-generate — plan-prompt fallbacks", () => {
	// The plan prompt template inlines a few `|| "(unknown)"` and `|| []`
	// fallbacks so a caller that omits client_repo / fix_src_dir / bundle_diff
	// still gets a well-formed prompt. Each fallback is its own branch; a test
	// per shape confirms none silently drop.
	it("emits '(unknown)' for client_repo + fix_src_dir when both are missing", async () => {
		const captured: Array<{ label: string; prompt: string }> = [];
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push({ label: request.label, prompt: request.prompt });
				if (request.label === "plan-repro-script") {
					return Promise.resolve(okPlan("bash"));
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		setHost(host);
		await run({
			task_id: "clickup:HAND_ITC-308",
			task_id_slug: "hand-itc-308",
			bundle_diff: "diff",
			task_intent: { proof_modality: "backend" },
			// client_repo + fix_src_dir OMITTED
		});
		const planReq = captured.find((r) => r.label === "plan-repro-script");
		expect(planReq).toBeDefined();
		expect(planReq?.prompt).toContain("Client repo: (unknown)");
		expect(planReq?.prompt).toContain("Client fix-src dir: (unknown)");
	});

	it("emits an empty bundle-diff block when bundle_diff is absent", async () => {
		const captured: Array<{ label: string; prompt: string }> = [];
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push({ label: request.label, prompt: request.prompt });
				if (request.label === "plan-repro-script") {
					return Promise.resolve(okPlan("bash"));
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		setHost(host);
		await run({
			task_id: "clickup:HAND_ITC-308",
			task_id_slug: "hand-itc-308",
			client_repo: "tttstudios/handled",
			task_intent: { proof_modality: "backend" },
			// bundle_diff OMITTED — the `ctx.bundle_diff || []` fallback fires
			// AND the `typeof === "string"` check goes down the else branch.
		});
		const planReq = captured.find((r) => r.label === "plan-repro-script");
		expect(planReq).toBeDefined();
		// Empty array serialised → "[]" appears in the prompt.
		expect(planReq?.prompt).toContain("[]");
	});

	it("stringifies an array-shaped bundle_diff into the plan prompt", async () => {
		const captured: Array<{ label: string; prompt: string }> = [];
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push({ label: request.label, prompt: request.prompt });
				if (request.label === "plan-repro-script") {
					return Promise.resolve(okPlan("bash"));
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		setHost(host);
		await run({
			...BASE_ARGS,
			bundle_diff: [{ path: "apps/web/login.ts", full_content: "export const login = () => 1;\n" }],
			task_intent: { proof_modality: "backend" },
		});
		const planReq = captured.find((r) => r.label === "plan-repro-script");
		expect(planReq).toBeDefined();
		// Array serialised via JSON.stringify — the file path shows up verbatim.
		expect(planReq?.prompt).toContain("apps/web/login.ts");
	});
});

describe("trp-proof-generate — record-prompt fallbacks", () => {
	// The record prompt inlines `plan.repro_script_body || ""` and `e.value || ""`
	// for env override values. Both fall-through branches must be exercised.
	it("emits an empty body block when plan.repro_script_body is missing", async () => {
		const captured: Array<{ label: string; prompt: string }> = [];
		const planWithoutBody = {
			repro_script_path: "discovery/proof/hand-itc-308/repro.sh",
			// repro_script_body OMITTED
			interpreter: "bash",
			reasoning: "test",
		};
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push({ label: request.label, prompt: request.prompt });
				if (request.label === "plan-repro-script") {
					return Promise.resolve(planWithoutBody);
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		setHost(host);
		await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		const recordReq = captured.find((r) => r.label === "invoke-proof-recorder");
		expect(recordReq).toBeDefined();
		// The prompt template writes the body between ``` fences; with a
		// missing body it collapses to an empty fenced block.
		expect(recordReq?.prompt).toContain("```\n\n```");
	});

	it("substitutes an empty string for env_override values without a `value` field", async () => {
		const captured: Array<{ label: string; prompt: string }> = [];
		const planWithEnv = {
			repro_script_path: "discovery/proof/hand-itc-308/repro.sh",
			repro_script_body: "#!/usr/bin/env bash\necho ok\n",
			interpreter: "bash",
			env_overrides: [{ name: "EMPTY_VAR", value: "" }],
			reasoning: "test",
		};
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push({ label: request.label, prompt: request.prompt });
				if (request.label === "plan-repro-script") {
					return Promise.resolve(planWithEnv);
				}
				if (request.label === "invoke-proof-recorder") {
					return Promise.resolve(okRecord);
				}
				if (request.label === "collect-manifest") {
					return Promise.resolve(okManifest);
				}
				return Promise.resolve(null);
			},
			journalWrite(): void {
				/* discard */
			},
			now(): number {
				return 0;
			},
		};
		setHost(host);
		await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		const recordReq = captured.find((r) => r.label === "invoke-proof-recorder");
		expect(recordReq).toBeDefined();
		// The env override renders as TRP_EMPTY_VAR='' — the empty-string fallback.
		expect(recordReq?.prompt).toContain("TRP_EMPTY_VAR=''");
	});
});

describe("trp-proof-generate — recorder null / missing stderr_tail", () => {
	it("returns 'proof-recorder non-zero exit' with empty stderr_tail when the recorder returns null", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				// Recorder agent returns null — treated as a non-zero exit.
				"Record:invoke-proof-recorder": null,
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.modality).toBe("backend");
		expect(result.error).toBe("proof-recorder non-zero exit");
		expect(result.stderr_tail).toBe("");
	});

	it("falls back to empty stderr_tail when the recorder failure record lacks the field", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": {
					exit_code: 1,
					// stderr_tail OMITTED
					dest_dir: "discovery/proof/hand-itc-308/",
				},
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.error).toBe("proof-recorder non-zero exit");
		expect(result.stderr_tail).toBe("");
	});
});

describe("trp-proof-generate — manifest null / missing artefacts", () => {
	// The manifest fold is `(manifest && manifest.artefacts) || []` with a
	// `.filter(Boolean)` on top. Three cases to cover: manifest is null;
	// manifest.artefacts is missing; artefacts contains falsy entries.
	it("returns artefacts:[] when the manifest agent returns null", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": okRecord,
				"Manifest:collect-manifest": null,
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.artefacts).toEqual([]);
		expect(result.dest_dir).toBe("discovery/proof/hand-itc-308/");
	});

	it("returns artefacts:[] when the manifest payload has no artefacts field", async () => {
		installReplayHost({
			responses: {
				"PlanScript:plan-repro-script": okPlan("bash"),
				"Record:invoke-proof-recorder": okRecord,
				// Empty object — manifest.artefacts is undefined.
				"Manifest:collect-manifest": {},
			},
		});
		const result = await run({
			...BASE_ARGS,
			task_intent: { proof_modality: "backend" },
		});
		expect(result.artefacts).toEqual([]);
	});
});

// Guard rail — drainJournal() should be empty at the START of every test.
describe("trp-proof-generate — reset discipline", () => {
	it("resetWorkflow before each test leaves the journal empty", () => {
		expect(drainJournal()).toHaveLength(0);
	});
});
