// Behavior tests for `trp-intent-extract.ts`.
//
// WHY it matters: the intent-extract workflow gates every downstream TRP
// phase — a wrong task_mode routes the fix into the wrong branch, a missing
// is_spike gate lets a solve-mode task leak spike prose into the return, and
// a partial adversarial response (one lens returns null) must fall back to a
// synthesized "agent returned nothing" verdict rather than crashing. These
// tests pin each of those branches with a replay Host so the journal is
// deterministic, then assert on the return shape and the emitted phase
// markers + agent-request labels.

/* oxlint-disable vitest/no-conditional-in-test, vitest/no-conditional-expect */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type AgentRequest,
	drainJournal,
	type Host,
	installReplayHost,
	type JournalEntry,
	resetWorkflow,
	setHost,
} from "@foundation/agents";
import { run } from "./trp-intent-extract.ts";

beforeEach(() => {
	resetWorkflow();
	delete process.env.TASK_ID;
	delete process.env.TASK_ID_SLUG;
});

// A canonical valid extract payload. Individual tests pass overrides to
// exercise the task_mode / is_spike branches without repeating the whole
// object shape at every call site.
function makeIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		what_changes: "wc",
		acceptance_criteria: ["a", "b"],
		target_repo: "o/r",
		task_class: "backend",
		proof_modality: "backend",
		task_mode: "solve",
		ambiguity_score: 0.2,
		ambiguity_notes: "notes",
		is_spike: false,
		spike_writeup_content: null,
		suggested_follow_up_ticket: null,
		...overrides,
	};
}

function lensHolds(lens: string): Record<string, unknown> {
	return {
		lens,
		holds: true,
		confidence: 0.9,
		reasoning: "survived refute",
		counter_evidence: "",
		suggested_correction: "",
	};
}

function lensFails(lens: string): Record<string, unknown> {
	return {
		lens,
		holds: false,
		confidence: 0.85,
		reasoning: "counter-evidence found",
		counter_evidence: "raw task line 5",
		suggested_correction: "flip to bugfix-red-green",
	};
}

function fullResponses(intent: Record<string, unknown> = makeIntent()): Record<string, unknown> {
	return {
		"Extract:extract:intent": intent,
		"Adversarial:adversarial:ambiguity": lensHolds("ambiguity"),
		"Adversarial:adversarial:wrong_repo": lensHolds("wrong_repo"),
		"Adversarial:adversarial:misidentified_modality": lensHolds("misidentified_modality"),
	};
}

describe("trp-intent-extract — args parsing", () => {
	it("returns ok:false with reason missing_args when task_id_slug is absent", async () => {
		const result = await run({ task_id: "clickup:X" });
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("missing_args");
			expect(result.task_id).toBe("clickup:X");
		}
	});

	it("returns ok:false when task_json_path resolves empty (no slug, no path)", async () => {
		const result = await run({});
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("missing_args");
			expect(result.task_id_slug).toBe("");
		}
	});

	it("parses a JSON-string arg the same as an object arg", async () => {
		const session = installReplayHost({ responses: fullResponses() });
		const result = await run(
			JSON.stringify({ task_id: "t", task_id_slug: "s", task_json_path: "p.json" }),
		);
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.task_id).toBe("t");
			expect(result.task_id_slug).toBe("s");
		}
	});

	it("falls back to process.env.TASK_ID when args do not name a task_id", async () => {
		process.env.TASK_ID = "env-task";
		const session = installReplayHost({ responses: fullResponses() });
		const result = await run({ task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.task_id).toBe("env-task");
		}
	});
});

describe("trp-intent-extract — extract phase failure", () => {
	it("returns ok:false with reason extract_failed when the extract agent returns null", async () => {
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": null,
				// Adversarial keys omitted — the workflow returns before parallel.
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("extract_failed");
			expect(result.task_id).toBe("t");
			expect(result.task_id_slug).toBe("s");
		}
	});
});

describe("trp-intent-extract — adversarial parallel", () => {
	it("marks all_lenses_hold true when every lens reports holds:true", async () => {
		const session = installReplayHost({ responses: fullResponses() });
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.all_lenses_hold).toBe(true);
			expect((result.adversarial_verdict.ambiguity as { holds: boolean }).holds).toBe(true);
			expect((result.adversarial_verdict.wrong_repo as { holds: boolean }).holds).toBe(true);
			expect((result.adversarial_verdict.misidentified_modality as { holds: boolean }).holds).toBe(
				true,
			);
		}
	});

	it("marks all_lenses_hold false when one lens reports holds:false", async () => {
		const session = installReplayHost({
			responses: {
				...fullResponses(),
				"Adversarial:adversarial:wrong_repo": lensFails("wrong_repo"),
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.all_lenses_hold).toBe(false);
			expect((result.adversarial_verdict.wrong_repo as { holds: boolean }).holds).toBe(false);
			expect((result.adversarial_verdict.ambiguity as { holds: boolean }).holds).toBe(true);
		}
	});

	it("substitutes the synthesized 'agent returned nothing' verdict when a lens returns null", async () => {
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": makeIntent(),
				"Adversarial:adversarial:ambiguity": lensHolds("ambiguity"),
				"Adversarial:adversarial:wrong_repo": null,
				"Adversarial:adversarial:misidentified_modality": lensHolds("misidentified_modality"),
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			// A null-returning lens must fall back to the default object with
			// holds:true, confidence:0, reasoning:"agent returned nothing" —
			// otherwise all_lenses_hold would silently flip on a dispatch
			// glitch rather than a real refute-panel finding.
			expect(result.adversarial_verdict.wrong_repo).toEqual({
				lens: "wrong_repo",
				holds: true,
				confidence: 0,
				reasoning: "agent returned nothing",
			});
			expect(result.all_lenses_hold).toBe(true);
		}
	});
});

describe("trp-intent-extract — task_mode branch coverage", () => {
	const TASK_MODES = [
		"solve",
		"reproduce",
		"support",
		"spike-writeup",
		"spike-solve",
		"spike-full",
	] as const;

	for (const mode of TASK_MODES) {
		it(`carries task_mode="${mode}" from the extract payload through to the return`, async () => {
			const session = installReplayHost({
				responses: fullResponses(makeIntent({ task_mode: mode })),
			});
			const result = await run({ task_id: "t", task_id_slug: "s" });
			session.finish();
			expect(result.ok).toBe(true);
			if (result.ok === true) {
				expect(result.intent.task_mode).toBe(mode);
			}
		});
	}
});

describe("trp-intent-extract — is_spike projection", () => {
	it("carries spike_writeup_content + suggested_follow_up_ticket through when is_spike is true", async () => {
		const followUp = {
			title: "child ticket",
			description: "d",
			priority: "P2",
			list_id_hint: "list-1",
		};
		const session = installReplayHost({
			responses: fullResponses(
				makeIntent({
					is_spike: true,
					task_mode: "spike-writeup",
					spike_writeup_content: "# Spike outcome\n\n...",
					suggested_follow_up_ticket: followUp,
				}),
			),
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.intent.is_spike).toBe(true);
			expect(result.intent.spike_writeup_content).toBe("# Spike outcome\n\n...");
			expect(result.intent.suggested_follow_up_ticket).toEqual(followUp);
		}
	});

	it("zeros spike_writeup_content + suggested_follow_up_ticket when is_spike is false, even if the extract payload carried both", async () => {
		// Simulates an extract-agent hallucination — is_spike:false but the
		// spike fields still populated. The workflow must clamp both to null
		// so a solve-mode fix does not inherit stray spike prose.
		const session = installReplayHost({
			responses: fullResponses(
				makeIntent({
					is_spike: false,
					spike_writeup_content: "leaked writeup",
					suggested_follow_up_ticket: { title: "leaked", description: "" },
				}),
			),
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.intent.is_spike).toBe(false);
			expect(result.intent.spike_writeup_content).toBeNull();
			expect(result.intent.suggested_follow_up_ticket).toBeNull();
		}
	});
});

describe("trp-intent-extract — chat context prompt path", () => {
	// Capture the extract prompt via a custom Host so we can assert on the
	// prompt body directly. installReplayHost hashes prompts into the journal
	// but does not expose the raw string — this Host does.
	function capturingHost(response: unknown): { host: Host; captured: AgentRequest[] } {
		const captured: AgentRequest[] = [];
		const host: Host = {
			dispatchAgent(request: AgentRequest): Promise<unknown | null> {
				captured.push(request);
				if (request.label === "extract:intent") {
					return Promise.resolve(response);
				}
				return Promise.resolve(lensHolds(request.label.replace(/^adversarial:/u, "")));
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

	it("includes the verbatim chat-context block in the extract prompt when chat_context is supplied", async () => {
		const { host, captured } = capturingHost(makeIntent());
		setHost(host);
		await run({
			task_id: "t",
			task_id_slug: "s",
			chat_context: "SLACK-EXCERPT-VERBATIM",
		});
		const extractReq = captured.find((r) => r.label === "extract:intent");
		expect(extractReq).toBeDefined();
		expect(extractReq?.prompt).toContain("SLACK-EXCERPT-VERBATIM");
		expect(extractReq?.prompt).toContain("Supplementary chat context (verbatim):");
		expect(extractReq?.prompt).toContain("Also weigh the operator-pasted");
	});

	it("emits the 'No supplementary chat context was pasted' branch when chat_context is empty", async () => {
		const { host, captured } = capturingHost(makeIntent());
		setHost(host);
		await run({ task_id: "t", task_id_slug: "s" });
		const extractReq = captured.find((r) => r.label === "extract:intent");
		expect(extractReq).toBeDefined();
		expect(extractReq?.prompt).toContain("No\nsupplementary chat context was pasted");
		expect(extractReq?.prompt).not.toContain("Supplementary chat context (verbatim):");
	});
});

describe("trp-intent-extract — journal shape", () => {
	it("emits Load, Extract, Adversarial, Summarize phase markers in that order", async () => {
		const session = installReplayHost({ responses: fullResponses() });
		await run({ task_id: "t", task_id_slug: "s" });
		const entries = session.finish();
		const phases = entries
			.filter((e): e is Extract<JournalEntry, { kind: "phase" }> => e.kind === "phase")
			.map((e) => e.title);
		expect(phases).toEqual(["Load", "Extract", "Adversarial", "Summarize"]);
	});

	it("records three agent-request entries in the Adversarial phase with the expected labels", async () => {
		const session = installReplayHost({ responses: fullResponses() });
		await run({ task_id: "t", task_id_slug: "s" });
		const entries = session.finish();
		const adversarialReqs = entries.filter(
			(e): e is Extract<JournalEntry, { kind: "agent-request" }> =>
				e.kind === "agent-request" && e.phase === "Adversarial",
		);
		expect(adversarialReqs.map((e) => e.label)).toEqual([
			"adversarial:ambiguity",
			"adversarial:wrong_repo",
			"adversarial:misidentified_modality",
		]);
	});
});

describe("trp-intent-extract — parseArgs nullish fallback", () => {
	// The parseArgs helper hits three branches: string-with-parse, string-that-
	// throws (returns {}), and the non-string path. The non-string path further
	// splits into `raw ?? {}` — a null/undefined raw must fall through to the
	// {} fallback rather than propagating a bad reference down to the required-
	// args guard. Without this path covered, the workflow silently accepts
	// `run(null)` as ready-to-run and only fails at the missing_args gate for
	// the wrong reason.
	it("returns ok:false with missing_args when rawArgs is null", async () => {
		const result = await run(null);
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("missing_args");
		}
	});

	it("returns ok:false with missing_args when rawArgs is undefined", async () => {
		const result = await run(undefined);
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("missing_args");
		}
	});

	it("treats a JSON-string arg that fails to parse as an empty object", async () => {
		// `parseArgs` catches SyntaxError and returns {}. The workflow then hits
		// the missing_args guard on the empty object, same shape as the null /
		// undefined path — but through a different branch.
		const result = await run("{not valid json");
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toBe("missing_args");
		}
	});
});

describe("trp-intent-extract — adversarial lens null fallbacks", () => {
	// The wrong_repo null-fallback is already covered upstream. This pair
	// covers the ambiguity and misidentified_modality null-fallbacks — each
	// must synthesize an `agent returned nothing` verdict rather than
	// silently propagating undefined through the return.
	it("substitutes the synthesized verdict when the ambiguity lens returns null", async () => {
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": makeIntent(),
				"Adversarial:adversarial:ambiguity": null,
				"Adversarial:adversarial:wrong_repo": lensHolds("wrong_repo"),
				"Adversarial:adversarial:misidentified_modality": lensHolds("misidentified_modality"),
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.adversarial_verdict.ambiguity).toEqual({
				lens: "ambiguity",
				holds: true,
				confidence: 0,
				reasoning: "agent returned nothing",
			});
			expect(result.all_lenses_hold).toBe(true);
		}
	});

	it("substitutes the synthesized verdict when the misidentified_modality lens returns null", async () => {
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": makeIntent(),
				"Adversarial:adversarial:ambiguity": lensHolds("ambiguity"),
				"Adversarial:adversarial:wrong_repo": lensHolds("wrong_repo"),
				"Adversarial:adversarial:misidentified_modality": null,
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.adversarial_verdict.misidentified_modality).toEqual({
				lens: "misidentified_modality",
				holds: true,
				confidence: 0,
				reasoning: "agent returned nothing",
			});
			expect(result.all_lenses_hold).toBe(true);
		}
	});
});

describe("trp-intent-extract — intent field nullish coalescing", () => {
	// Every intent.<field> read is wrapped in `?? <default>` so a partial
	// extract-agent payload does not crash the return-shape. This test
	// exercises the fallback branch on every field simultaneously: if the
	// extract agent returns only the schema-required fields as undefined,
	// every ?? must resolve to its default rather than propagating undefined.
	it("substitutes defaults for every intent field when the extract payload is a bare object", async () => {
		// Deliberately partial payload: no fields at all. The workflow's return
		// shape must still be well-formed with defaults.
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": {},
				"Adversarial:adversarial:ambiguity": lensHolds("ambiguity"),
				"Adversarial:adversarial:wrong_repo": lensHolds("wrong_repo"),
				"Adversarial:adversarial:misidentified_modality": lensHolds("misidentified_modality"),
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.intent.what_changes).toBe("");
			expect(result.intent.acceptance_criteria).toEqual([]);
			expect(result.intent.target_repo).toBe("");
			expect(result.intent.task_class).toBe("");
			expect(result.intent.proof_modality).toBe("");
			expect(result.intent.task_mode).toBeNull();
			expect(result.intent.ambiguity_score).toBe(0);
			expect(result.intent.is_spike).toBe(false);
			expect(result.intent.spike_writeup_content).toBeNull();
			expect(result.intent.suggested_follow_up_ticket).toBeNull();
			expect(result.ambiguity_notes).toBe("");
		}
	});

	it("substitutes null for spike_writeup_content when is_spike is true but the field is undefined", async () => {
		// A spike-shaped intent may set is_spike:true without producing the
		// content yet. The workflow's `?? null` fallback catches this case;
		// tests must exercise BOTH the truthy is_spike gate AND the nullish
		// content path so the ??-side is covered.
		const session = installReplayHost({
			responses: {
				"Extract:extract:intent": makeIntent({
					is_spike: true,
					spike_writeup_content: undefined,
					suggested_follow_up_ticket: undefined,
				}),
				"Adversarial:adversarial:ambiguity": lensHolds("ambiguity"),
				"Adversarial:adversarial:wrong_repo": lensHolds("wrong_repo"),
				"Adversarial:adversarial:misidentified_modality": lensHolds("misidentified_modality"),
			},
		});
		const result = await run({ task_id: "t", task_id_slug: "s" });
		session.finish();
		expect(result.ok).toBe(true);
		if (result.ok === true) {
			expect(result.intent.is_spike).toBe(true);
			expect(result.intent.spike_writeup_content).toBeNull();
			expect(result.intent.suggested_follow_up_ticket).toBeNull();
		}
	});
});

// Guard rail — drainJournal() should be empty at the START of every test.
describe("trp-intent-extract — reset discipline", () => {
	it("resetWorkflow before each test leaves the journal empty", () => {
		expect(drainJournal()).toHaveLength(0);
	});
});
