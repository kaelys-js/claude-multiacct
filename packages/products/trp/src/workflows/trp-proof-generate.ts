/**
 * `@foundation/trp` — trp-proof-generate workflow (Phase 4 migration).
 *
 * Task Review Protocol — given a task_intent.proof_modality plus a bundle
 * diff, invoke scripts/proof-recorder.sh with the right modality (ui /
 * backend / terminal / iac / bugfix-red-green) and return a manifest of the
 * artefacts it wrote. The manifest is folded into the bundle
 * proof_manifest field and later posted to the tracker.
 *
 * Migrated line-for-line from `trp/workflows/trp-proof-generate.js`.
 *
 * @module
 */

import { agent, log, phase } from "@foundation/agents";

export const meta = {
	name: "trp-proof-generate",
	description:
		"Task Review Protocol — given a task_intent.proof_modality plus a bundle diff, invoke scripts/proof-recorder.sh with the right modality (ui / backend / terminal / iac / bugfix-red-green) and return a manifest of the artefacts it wrote. The manifest is folded into the bundle proof_manifest field and later posted to the tracker.",
	whenToUse:
		"After scripts/fix-task.sh has produced a bundle and task_intent carries a proof_modality. Main context passes task_intent + bundle diff via args; the workflow decides which recorder invocation fits and returns the resulting artefact list.",
	phases: [
		{ title: "Load", detail: "Parse args, validate modality + task id" },
		{
			title: "PlanScript",
			detail: "Modality-specific agent chooses / drafts the repro script the recorder will run",
		},
		{
			title: "Record",
			detail: "Invoke scripts/proof-recorder.sh with the chosen modality + script",
		},
		{
			title: "Manifest",
			detail: "Read the recorder output directory, hash each artefact, return the manifest",
		},
	],
} as const;

const SCRIPT_SCHEMA = {
	type: "object",
	properties: {
		repro_script_path: { type: "string" },
		repro_script_body: { type: "string" },
		interpreter: { type: "string" },
		env_overrides: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					value: { type: "string" },
				},
				required: ["name", "value"],
			},
		},
		test_cmd: { type: "string" },
		reasoning: { type: "string" },
	},
	required: ["repro_script_path", "repro_script_body", "interpreter", "reasoning"],
} as const;

const MODALITY_HINTS: Record<string, string> = {
	ui: `Playwright test file. proof-recorder runs it with \`npx playwright test <script>\` and preserves .png + .mp4 traces. Target the client repo URL under test; assert the fix's user-visible change.`,
	backend: `Bash script issuing curl calls against the local backend. proof-recorder captures stdout + stderr. Exit non-zero if the endpoint under review misbehaves.`,
	terminal: `Bash script recorded via script(1). Anything the operator would run in a shell to demonstrate the change — CLI commands, log tails, health checks.`,
	iac: `No script needed (interpreter="none"). proof-recorder snapshots \`terraform plan\` + \`docker compose config\` from the fix-src dir. Return an empty body; recorder ignores --script for iac.`,
	"bugfix-red-green": `Bash script is optional; the important field is test_cmd — the exact test invocation to run at HEAD~1 (expect FAIL / red) then HEAD (expect PASS / green). proof-recorder captures both outputs.`,
};

const RECORD_SCHEMA = {
	type: "object",
	properties: {
		exit_code: { type: "integer" },
		stdout_tail: { type: "string" },
		stderr_tail: { type: "string" },
		dest_dir: { type: "string" },
		wrote_script: { type: "boolean" },
	},
	required: ["exit_code", "dest_dir"],
} as const;

const MANIFEST_SCHEMA = {
	type: "object",
	properties: {
		artefacts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					path: { type: "string" },
					sha256: { type: "string" },
					timestamp: { type: "string" },
					bytes: { type: "integer" },
					kind: { type: "string" },
				},
				required: ["path", "sha256", "timestamp"],
			},
		},
	},
	required: ["artefacts"],
} as const;

export type ProofArgs = {
	readonly task_id?: string;
	readonly task_id_slug?: string;
	readonly task_intent?: Record<string, unknown> & { proof_modality?: string };
	readonly proof_modality?: string;
	readonly bundle_diff?: string | ReadonlyArray<{ path: string; full_content: string }>;
	readonly client_repo?: string;
	readonly client_slug?: string;
	readonly fix_src_dir?: string;
	readonly previous_attempt?: {
		attempt_number?: number;
		prior_manifest?: unknown;
		failure?: unknown;
	} | null;
};

export type ProofArtefact = {
	path: string;
	sha256: string;
	timestamp: string;
	bytes?: number;
	kind?: string;
};

export type ProofResult = {
	modality: string | null;
	artefacts: ProofArtefact[];
	repro_script_path?: string;
	dest_dir?: string;
	task_id?: string;
	task_id_slug?: string;
	error?: string;
	stderr_tail?: string;
};

function parseArgs(raw: unknown): ProofArgs {
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as ProofArgs;
		} catch {
			return {};
		}
	}
	return (raw ?? {}) as ProofArgs;
}

export async function run(rawArgs: unknown): Promise<ProofResult> {
	phase("Load");

	const ctx = parseArgs(rawArgs);

	// Required context from scripts/fix-task.sh:
	//   task_id            "clickup:HAND_ITC-308"  — "<TRACKER>:<TASK_ID>"
	//   task_id_slug       "hand-itc-308"          — slugified, matches recorder DEST_DIR
	//   task_intent        { proof_modality, ... } — parsed intent record
	//   bundle_diff        unified diff text OR array of {path, full_content}
	//   client_repo        "tttstudios/handled"
	//   client_slug        "handled"
	//   fix_src_dir        e.g. "discovery/fix-src/handled-hand-itc-308"
	//   previous_attempt   optional: {attempt_number, prior_manifest, failure}

	const taskId = ctx.task_id || "unknown:UNKNOWN";
	const taskSlug =
		ctx.task_id_slug ||
		(taskId.split(":").pop() || "task").toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
	const intent = ctx.task_intent || {};
	const modality = (intent as { proof_modality?: string }).proof_modality || ctx.proof_modality;
	const prior = ctx.previous_attempt || null;

	if (!modality) {
		log("no proof_modality on task_intent — abort");
		return { modality: null, artefacts: [], error: "task_intent.proof_modality missing" };
	}

	const validModalities = ["ui", "backend", "terminal", "iac", "bugfix-red-green"];
	if (!validModalities.includes(modality)) {
		log(`unknown modality "${modality}" — abort`);
		return {
			modality,
			artefacts: [],
			error: `unknown modality; expected one of ${validModalities.join(", ")}`,
		};
	}

	log(
		`TRP proof-gen for ${taskId} modality=${modality}${prior ? ` (revise attempt ${prior.attempt_number})` : ""}`,
	);

	// ---------------------- Phase: plan the repro script ----------------------
	phase("PlanScript");

	const planPrompt = `
You are choosing the repro script the TRP proof recorder will run for
task ${taskId} (modality: ${modality}).

Client repo: ${ctx.client_repo || "(unknown)"}
Client fix-src dir: ${ctx.fix_src_dir || "(unknown)"}

Task intent (JSON):
${JSON.stringify(intent, null, 2).slice(0, 3000)}

Bundle diff (truncated to 6000 chars):
${
	typeof ctx.bundle_diff === "string"
		? ctx.bundle_diff.slice(0, 6000)
		: JSON.stringify(ctx.bundle_diff || [], null, 2).slice(0, 6000)
}

${
	prior
		? `Prior attempt failed:
${JSON.stringify(
	{
		attempt: prior.attempt_number,
		prior_manifest: prior.prior_manifest,
		failure: prior.failure,
	},
	null,
	2,
).slice(0, 3000)}
Fix what the prior attempt got wrong; keep what worked.`
		: ""
}

Modality contract:
${MODALITY_HINTS[modality]}

Design the repro script.

- Pick \`repro_script_path\` under \`discovery/proof/${taskSlug}/\` so it lives
  beside the artefacts the recorder will write.
- \`repro_script_body\` is the full text. For iac, return an empty string and
  set interpreter to "none".
- \`interpreter\` is what proof-recorder needs to run it: "bash" for backend/
  terminal, "playwright" for ui, "none" for iac, "bash" for bugfix-red-green.
- For \`bugfix-red-green\`, \`test_cmd\` is REQUIRED — the exact command
  (e.g. \`pnpm --filter itc test path/to/spec.ts\`).
- \`env_overrides\` optional; use for things the recorder should export before
  running the script (base URLs, feature flags).

Read-only against the client repo. Under 500 words reasoning.
`.trim();

	const plan = (await agent(planPrompt, {
		label: "plan-repro-script",
		phase: "PlanScript",
		schema: SCRIPT_SCHEMA,
	})) as
		| {
				repro_script_path?: string;
				repro_script_body?: string;
				interpreter?: string;
				env_overrides?: Array<{ name: string; value: string }>;
				test_cmd?: string;
				reasoning?: string;
		  }
		| null
		| undefined;

	if (!plan || !plan.repro_script_path) {
		log("script planning returned no path — abort");
		return {
			modality,
			artefacts: [],
			error: "plan-repro-script returned no repro_script_path",
		};
	}
	log(`planned: ${plan.repro_script_path} (interpreter=${plan.interpreter})`);

	// ---------------------- Phase: record ------------------------------------
	phase("Record");

	const recordPrompt = `
Invoke the proof recorder for TRP task ${taskId} (modality ${modality}).

Steps:

1. ${
		plan.interpreter === "none"
			? "SKIP script write — modality is iac; the recorder snapshots plan/config on its own."
			: `Write \`${plan.repro_script_path}\` with the body below and \`chmod +x\` it. Content:
\`\`\`
${(plan.repro_script_body || "").slice(0, 6000)}
\`\`\``
	}

2. Export env vars from env_overrides then invoke:

    ${(plan.env_overrides || [])
			.map(
				(e) =>
					`TRP_${e.name.replaceAll(/[^A-Z0-9_]/giu, "_").toUpperCase()}='${(e.value || "").replaceAll("'", String.raw`'\''`)}'`,
			)
			.join(" ")} \\
    ${modality === "bugfix-red-green" ? `TEST_CMD='${(plan.test_cmd || "").replaceAll("'", String.raw`'\''`)}' ` : ""}\\
    ./scripts/proof-recorder.sh \\
      --task '${taskId}' \\
      --modality '${modality}' \\
      ${plan.interpreter === "none" ? "" : `--script '${plan.repro_script_path}'`}

3. Capture exit code, stdout tail (~40 lines), stderr tail (~40 lines).
4. Report the recorder's DEST_DIR: \`discovery/proof/${taskSlug}/\`.

Return the RECORD_SCHEMA object. Don't summarise — just execute.
`.trim();

	const recorded = (await agent(recordPrompt, {
		label: "invoke-proof-recorder",
		phase: "Record",
		schema: RECORD_SCHEMA,
	})) as
		| {
				exit_code?: number;
				stdout_tail?: string;
				stderr_tail?: string;
				dest_dir?: string;
				wrote_script?: boolean;
		  }
		| null
		| undefined;

	if (!recorded || recorded.exit_code !== 0) {
		log(`proof-recorder failed exit=${recorded?.exit_code}`);
		return {
			modality,
			artefacts: [],
			repro_script_path: plan.repro_script_path,
			error: "proof-recorder non-zero exit",
			stderr_tail: recorded?.stderr_tail || "",
		};
	}
	log(`recorder ok, dest_dir=${recorded.dest_dir}`);

	// ---------------------- Phase: manifest ----------------------------------
	phase("Manifest");

	const manifestPrompt = `
List every artefact written to \`${recorded.dest_dir}\` by the recorder run.

For each file (recursive):
- \`path\`: repo-relative
- \`sha256\`: run \`shasum -a 256 <file>\` (prefer the recorder's sidecar
  \`<file>.sha256\` when present — read the hex value directly rather than
  re-hashing).
- \`timestamp\`: ISO-8601 UTC of the file's mtime (\`date -u -r <file> +%Y-%m-%dT%H:%M:%SZ\`).
- \`bytes\`: \`stat -f%z <file>\` on macOS, \`stat -c%s\` on Linux.
- \`kind\`: infer from extension (.log / .png / .mp4 / .json / .diff / .txt).

Skip \`.sha256\` sidecars themselves — they're metadata, not artefacts. Under
300 words explanation.
`.trim();

	const manifest = (await agent(manifestPrompt, {
		label: "collect-manifest",
		phase: "Manifest",
		schema: MANIFEST_SCHEMA,
	})) as { artefacts?: ProofArtefact[] } | null | undefined;

	const artefacts = ((manifest && manifest.artefacts) || []).filter(Boolean);
	log(`manifest: ${artefacts.length} artefact(s) at ${recorded.dest_dir}`);

	return {
		modality,
		artefacts,
		repro_script_path: plan.interpreter === "none" ? undefined : plan.repro_script_path,
		dest_dir: recorded.dest_dir,
		task_id: taskId,
		task_id_slug: taskSlug,
	};
}

export default run;
