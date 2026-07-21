/**
 * `@foundation/trp` — trp-intent-extract workflow (Phase 4 migration).
 *
 * TRP Phase 1: extract structured intent from a tracker task + optional
 * Slack/Teams context, then run a 3-lens adversarial refute panel (ambiguity,
 * wrong-repo, misidentified-modality) in parallel.
 *
 * Migrated line-for-line from `trp/workflows/trp-intent-extract.js`.
 *
 * @module
 */

import { agent, type InferSchema, log, parallel, phase } from "@foundation/agents";

export const meta = {
	name: "trp-intent-extract",
	description:
		"TRP Phase 1: extract structured intent from a tracker task + optional Slack/Teams context, then run a 3-lens adversarial refute panel (ambiguity, wrong-repo, misidentified-modality) in parallel.",
	whenToUse:
		"After scripts/trp-fetch-task.sh has produced discovery/task-<task_id_slug>.json; caller passes { task_id, task_id_slug, task_json_path, chat_context } via args.",
	phases: [
		{ title: "Load", detail: "Parse args and read the raw task JSON + optional chat context" },
		{ title: "Extract", detail: "One agent turns raw task text into structured intent" },
		{
			title: "Adversarial",
			detail: "Three refute lenses in parallel: ambiguity, wrong-repo, misidentified-modality",
		},
		{
			title: "Summarize",
			detail: "Aggregate intent + adversarial verdict, return structured result",
		},
	],
} as const;

const TASK_CLASSES = [
	"ui",
	"backend",
	"schema",
	"iac",
	"bugfix",
	"chore",
	"docs",
	"test",
	"refactor",
	"deps",
	"security",
] as const;
const PROOF_MODALITIES = ["ui", "backend", "terminal", "iac", "bugfix-red-green"] as const;
const TASK_MODES = [
	"spike-writeup",
	"spike-solve",
	"spike-full",
	"solve",
	"reproduce",
	"support",
] as const;

const INTENT_V2_SCHEMA = {
	type: "object",
	properties: {
		what_changes: { type: "string" },
		acceptance_criteria: { type: "array", items: { type: "string" } },
		target_repo: { type: "string" },
		task_class: { type: "string", enum: TASK_CLASSES },
		proof_modality: { type: "string", enum: PROOF_MODALITIES },
		task_mode: { type: ["string", "null"], enum: [...TASK_MODES, null] },
		ambiguity_score: { type: "number", minimum: 0, maximum: 1 },
		ambiguity_notes: { type: "string" },
		is_spike: { type: "boolean" },
		spike_writeup_content: { type: ["string", "null"] },
		suggested_follow_up_ticket: {
			type: ["object", "null"],
			properties: {
				title: { type: "string" },
				description: { type: "string" },
				priority: { type: "string" },
				list_id_hint: { type: "string" },
			},
		},
	},
	required: [
		"what_changes",
		"acceptance_criteria",
		"target_repo",
		"task_class",
		"proof_modality",
		"ambiguity_score",
		"ambiguity_notes",
		"is_spike",
		"spike_writeup_content",
		"suggested_follow_up_ticket",
	],
} as const;

const LENS_SCHEMA = {
	type: "object",
	properties: {
		lens: { type: "string" },
		holds: { type: "boolean" },
		confidence: { type: "number", minimum: 0, maximum: 1 },
		reasoning: { type: "string" },
		counter_evidence: { type: "string" },
		suggested_correction: { type: "string" },
	},
	required: ["lens", "holds", "confidence", "reasoning"],
} as const;

export type IntentArgs = {
	readonly task_id?: string;
	readonly task_id_slug?: string;
	readonly task_json_path?: string;
	readonly chat_context?: string;
};

export type IntentResult =
	| {
			ok: false;
			reason: string;
			task_id?: string;
			task_id_slug?: string;
	  }
	| {
			ok: true;
			task_id: string;
			task_id_slug: string;
			intent: {
				what_changes: string;
				acceptance_criteria: string[];
				target_repo: string;
				task_class: string;
				proof_modality: string;
				task_mode: string | null;
				ambiguity_score: number;
				is_spike: boolean;
				spike_writeup_content: string | null;
				suggested_follow_up_ticket: Record<string, unknown> | null;
			};
			ambiguity_notes: string;
			adversarial_verdict: {
				ambiguity: unknown;
				wrong_repo: unknown;
				misidentified_modality: unknown;
			};
			all_lenses_hold: boolean;
	  };

function parseArgs(raw: unknown): IntentArgs {
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as IntentArgs;
		} catch {
			return {};
		}
	}
	return (raw ?? {}) as IntentArgs;
}

export async function run(rawArgs: unknown): Promise<IntentResult> {
	phase("Load");
	const parsedArgs = parseArgs(rawArgs);
	log(`args typeof(post-parse)=${typeof parsedArgs}`);

	const TASK_ID = parsedArgs.task_id || process.env.TASK_ID || "";
	const TASK_ID_SLUG = parsedArgs.task_id_slug || process.env.TASK_ID_SLUG || "";
	const TASK_JSON_PATH =
		parsedArgs.task_json_path || (TASK_ID_SLUG ? `discovery/task-${TASK_ID_SLUG}.json` : "");
	const CHAT_CONTEXT = parsedArgs.chat_context || "";

	if (!TASK_ID_SLUG || !TASK_JSON_PATH) {
		log("missing required args: task_id_slug + task_json_path");
		return { ok: false, reason: "missing_args", task_id: TASK_ID, task_id_slug: TASK_ID_SLUG };
	}

	log(`TASK_ID=${TASK_ID} slug=${TASK_ID_SLUG} json=${TASK_JSON_PATH}`);
	log(`chat_context length=${(CHAT_CONTEXT || "").length}`);

	phase("Extract");

	const extractPrompt = `
Read the raw task JSON at \`${TASK_JSON_PATH}\` (fetched from a tracker via
scripts/trp-fetch-task.sh). ${CHAT_CONTEXT ? "Also weigh the operator-pasted\nSlack/Teams context below when the tracker task alone is under-specified." : "No\nsupplementary chat context was pasted; work from the tracker task alone."}

Extract a structured intent record. Default posture: be honest about
ambiguity — the adversarial phase will refute this record, so a high
\`ambiguity_score\` with specific notes beats a confident guess.

Fields:
- \`what_changes\` — one paragraph in plain English: what the code change
  must do. No exploit / attack framing; this is delivery, not disclosure.
- \`acceptance_criteria\` — 2-6 concrete bullet-sized criteria. Each must be
  observable (a URL renders X; endpoint returns Y; a red test turns green).
- \`target_repo\` — best guess of the client repo slug (\`owner/repo\`), or
  a short label the operator would recognise. Say "unknown" when the task
  doesn't name one.
- \`task_class\` — one of: ${TASK_CLASSES.map((c) => `\`${c}\``).join(", ")}. Heuristics:
  * \`ui\` — page/component render, layout, copy shown in a browser.
  * \`backend\` — endpoint / service / job / API behaviour, no schema shape change.
  * \`schema\` — a data-model migration (Prisma / SQL / Mongo / Zod contract).
  * \`iac\` — Terraform / Bicep / Kubernetes / GH-Actions / infra config only.
  * \`bugfix\` — restores intended behaviour; ships with a failing-then-green test.
  * \`chore\` — cleanup with no user-visible behaviour change (dead code, rename).
  * \`docs\` — README / ADR / runbook / inline-comment / prose-only edits.
  * \`test\` — adds or hardens tests without production-code change.
  * \`refactor\` — restructures code, no behaviour change, no visible surface change.
  * \`deps\` — bumps a dependency version, lockfile edit, package.json range change.
  * \`security\` — remediates a disclosed finding (auth / crypto / injection / posture).
- \`task_mode\` — one of: ${TASK_MODES.map((m) => `\`${m}\``).join(", ")}, or null when
  no signal is strong enough to override the caller's default. Auto-detect signals:
  * \`reproduce\` — title contains 'reproduce', 'repro', 'failing test',
    'add test', 'flaky', OR acceptance criteria describes producing a test
    that turns red then green (no product-code change asked for).
  * \`support\` — title contains 'how do I', 'question', 'help', '[QUESTION]',
    OR acceptance criteria ask for a response / explanation on the tracker
    thread, not a code change.
  * \`spike-writeup\` / \`spike-solve\` / \`spike-full\` — see \`is_spike\` rules.
  * \`solve\` — the plain implementation default.
- \`proof_modality\` — how a reviewer will verify the fix ships:
  ${PROOF_MODALITIES.map((m) => `\`${m}\``).join(", ")}. Choose the modality
  the acceptance criteria actually demand — a UI ticket needs \`ui\`, a
  bug ticket that ships with a failing test wants \`bugfix-red-green\`.
- \`ambiguity_score\` — 0.0 (fully specified) to 1.0 (need to ask).
- \`ambiguity_notes\` — one short paragraph naming the specific gaps.
- \`is_spike\` — true when any of these hold:
  1. Title matches /\\[SPIKE\\]/i.
  2. Title starts with a spike verb: /^(spike|research|investigate|
     explore|figure out|figure-out|figure_out)\\b/i.
  3. A MAJORITY of the acceptance criteria use investigative verbs from
     this set (NOT a "purely" gate — a mix of investigate + prototype is
     still a spike): propose, describe, state, estimate, investigate,
     identify how, research, recommend, evaluate, compare, assess,
     explore, figure out, determine, spike, review, examine, analyse,
     analyze, understand, characterize, characterise, benchmark,
     survey, audit, weigh, consider, prototype (only when paired with
     one of the other verbs on a sibling criterion — a pure "prototype"
     is not a spike).
  Otherwise false. False positives are cheaper than false negatives here:
  when the criteria are borderline, prefer is_spike=true and let the
  spike-writeup path produce a write-up. The operator can override with
  --mode=solve if needed.
- \`spike_writeup_content\` — when \`is_spike\` is true, a Markdown draft
  of the spike outcome, roughly 1500-3000 words. Each acceptance
  criterion becomes an H2 section. Cover, in order: (1) what the
  finding is, (2) priority with justification, (3) effort estimate
  with justification, (4) detection strategy, (5) systematic-flagging
  approach, (6) recommended follow-up including an optional suggested
  follow-up-ticket title. When \`is_spike\` is false, set this to null.
- \`suggested_follow_up_ticket\` — when the spike writeup recommends a
  concrete child ticket, an object \`{ title, description, priority,
  list_id_hint }\` payload that a later spike-full mode can turn into
  a child task. Null when \`is_spike\` is false or no follow-up is
  warranted.

Read-only. Keep the JSON body concise; the spike writeup is the one
field allowed to be long when \`is_spike\` is true.
${CHAT_CONTEXT ? `\n\nSupplementary chat context (verbatim):\n---\n${CHAT_CONTEXT}\n---\n` : ""}
`.trim();

	const intent = await agent(extractPrompt, {
		label: "extract:intent",
		phase: "Extract",
		schema: INTENT_V2_SCHEMA,
	});

	if (!intent) {
		log("extract agent returned nothing — aborting");
		return { ok: false, reason: "extract_failed", task_id: TASK_ID, task_id_slug: TASK_ID_SLUG };
	}

	log(
		`extracted: class=${intent.task_class} modality=${intent.proof_modality} repo=${intent.target_repo} ambiguity=${intent.ambiguity_score}`,
	);

	phase("Adversarial");

	const intentBlock = JSON.stringify(intent, null, 2);

	const commonPreamble = `
The extract phase produced this intent record for task \`${TASK_ID}\`
(slug \`${TASK_ID_SLUG}\`):

\`\`\`json
${intentBlock}
\`\`\`

Raw task JSON is at \`${TASK_JSON_PATH}\`. ${CHAT_CONTEXT ? "Operator-pasted chat context was also weighed during extract." : "No chat context was supplied."}

Your job is refute-first: assume the extract is WRONG on your specific lens
until source proves otherwise. Read the raw task JSON via Read, and any
repo-tree evidence you need via Bash/Grep. Cite \`file:line\` or a quoted
task field when you claim counter-evidence.

Fields:
- \`holds\` — true if the extract record survives your refute attempt on
  this lens; false if you found counter-evidence.
- \`confidence\` — 0.0..1.0 in your verdict.
- \`reasoning\` — one short paragraph.
- \`counter_evidence\` — the specific quote/citation that moves the verdict
  (empty string when \`holds: true\` and nothing surfaced).
- \`suggested_correction\` — when \`holds: false\`, what the extract should
  have said instead. Empty string otherwise.

Read-only. Under 200 words.
`.trim();

	const ambiguityPrompt = `
Lens: AMBIGUITY.

${commonPreamble}

Specifically challenge \`ambiguity_score\` and \`ambiguity_notes\`. A common
failure mode: the extract agent under-rates ambiguity because the tracker
task uses confident language that hides missing detail (which page? which
tenant? which state?). Try to identify at least one concrete question a
human implementer would have to ask before writing code. If you find one,
the intent's ambiguity is under-stated and \`holds\` is false.
`.trim();

	const wrongRepoPrompt = `
Lens: WRONG-REPO.

${commonPreamble}

Specifically challenge \`target_repo\`. Common failure modes: the task
names a product feature (e.g. "the itc portal") that maps to a specific
app inside a monorepo, not the monorepo root; the task names a UI symptom
that actually lands in the backend repo; the operator pasted a chat
excerpt that names a different service than the tracker task. If the
extract's \`target_repo\` is wrong (or "unknown" when the task actually
does name one), \`holds\` is false.
`.trim();

	const modalityPrompt = `
Lens: MISIDENTIFIED-MODALITY.

${commonPreamble}

Specifically challenge \`task_class\` + \`proof_modality\`. Common failure
modes: a "bugfix" filed with a repro but no failing test still wants
\`bugfix-red-green\` because the acceptance criterion is "this stops
happening"; a schema migration filed as a "backend" ticket needs \`iac\`
or \`terminal\` proof; a copy change filed as "ui" is actually \`chore\`
with no proof modality worth running. If the pairing doesn't match the
acceptance criteria as written, \`holds\` is false.
`.trim();

	type LensVerdict = InferSchema<typeof LENS_SCHEMA> | null;
	const [ambiguityVerdict, wrongRepoVerdict, modalityVerdict] = await parallel([
		(): Promise<LensVerdict> =>
			agent(ambiguityPrompt, {
				label: "adversarial:ambiguity",
				phase: "Adversarial",
				schema: LENS_SCHEMA,
			}),
		(): Promise<LensVerdict> =>
			agent(wrongRepoPrompt, {
				label: "adversarial:wrong_repo",
				phase: "Adversarial",
				schema: LENS_SCHEMA,
			}),
		(): Promise<LensVerdict> =>
			agent(modalityPrompt, {
				label: "adversarial:misidentified_modality",
				phase: "Adversarial",
				schema: LENS_SCHEMA,
			}),
	]);

	phase("Summarize");

	const adversarial_verdict = {
		ambiguity: ambiguityVerdict || {
			lens: "ambiguity",
			holds: true,
			confidence: 0,
			reasoning: "agent returned nothing",
		},
		wrong_repo: wrongRepoVerdict || {
			lens: "wrong_repo",
			holds: true,
			confidence: 0,
			reasoning: "agent returned nothing",
		},
		misidentified_modality: modalityVerdict || {
			lens: "misidentified_modality",
			holds: true,
			confidence: 0,
			reasoning: "agent returned nothing",
		},
	};

	const anyFail = Object.values(adversarial_verdict).some(
		(v) => v && (v as { holds: boolean }).holds === false,
	);
	log(
		`adversarial: ambiguity.holds=${(adversarial_verdict.ambiguity as { holds: boolean }).holds} wrong_repo.holds=${(adversarial_verdict.wrong_repo as { holds: boolean }).holds} misidentified_modality.holds=${(adversarial_verdict.misidentified_modality as { holds: boolean }).holds}`,
	);
	if (anyFail) {
		log("at least one lens rejected the extract — see counter_evidence");
	}

	return {
		ok: true,
		task_id: TASK_ID,
		task_id_slug: TASK_ID_SLUG,
		intent: {
			what_changes: intent.what_changes ?? "",
			acceptance_criteria: (intent.acceptance_criteria as string[] | undefined) ?? [],
			target_repo: intent.target_repo ?? "",
			task_class: intent.task_class ?? "",
			proof_modality: intent.proof_modality ?? "",
			task_mode: (intent.task_mode as string | null) ?? null,
			ambiguity_score: intent.ambiguity_score ?? 0,
			is_spike: intent.is_spike === true,
			spike_writeup_content:
				intent.is_spike === true ? ((intent.spike_writeup_content as string | null) ?? null) : null,
			suggested_follow_up_ticket:
				intent.is_spike === true
					? ((intent.suggested_follow_up_ticket as Record<string, unknown> | null) ?? null)
					: null,
		},
		ambiguity_notes: intent.ambiguity_notes ?? "",
		adversarial_verdict,
		all_lenses_hold: !anyFail,
	};
}

export default run;
