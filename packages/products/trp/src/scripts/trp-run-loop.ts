#!/usr/bin/env node
/**
 * `trp-run-loop.ts` — TRP-EE main-context wrapper, rewritten from Bash onto
 * `@foundation/shell`. Runs the fix-task driver and prints the exact next-step
 * block on exit 66/67 so a Claude session can re-invoke the workflow in
 * REVISE mode.
 *
 * Byte-for-byte stdout parity with `trp-run-loop.sh` is asserted in
 * `trp-run-loop.test.ts` against the HAND_ITC-308 fixture.
 *
 * @module
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { sh, stdioJournal } from "@foundation/shell";

const USAGE = `Usage:
  trp-run-loop.sh <TRACKER>:<TASK_ID> [OPTIONS]

Options:
  --mode=<MODE>       Explicit mode override. Auto-detected from task shape if omitted.
                      spike-writeup — investigate + write-up only, no code changes
                      spike-solve   — spike-writeup + a bundled code fix
                      spike-full    — spike-solve + follow-up child ticket
                      solve         — default for non-spike tickets
                      reproduce     — failing regression test + minimal writeup, no PR
                      support       — tracker-comment answer only, no code change
  --push              Open PR + tracker comment. Gated by TRP_ALLOW_REMOTE_MUTATE=true.
  --push-force        Force-push + regenerate PR body. Gated as above.
  --attempt=N         Nth REVISE-loop attempt (SRP-J shape).
  --repo=<SLUG>       Multi-repo task: run against one client repo per invocation.
  -h, --help          Print this usage and exit 0.

Example:
  ./scripts/trp-run-loop.sh clickup:HAND_ITC-308
      # auto-detects [SPIKE] shape, runs spike-writeup, refuses to post
      # without TRP_ALLOW_REMOTE_MUTATE=true.`;

type Mode = "spike-writeup" | "spike-solve" | "spike-full" | "solve" | "reproduce" | "support";

const VALID_MODES: ReadonlySet<Mode> = new Set([
	"spike-writeup",
	"spike-solve",
	"spike-full",
	"solve",
	"reproduce",
	"support",
]);

// Slug transform: "clickup:HAND_ITC-308" -> "clickup_hand_itc-308".
// Mirrors the tr/tr/sed pipeline in the Bash version, then collapses runs
// of underscores so a caller-typed noisy id ("  __weird//ID__  ") lands as
// "weird_id" — a form the driver + bundle paths can round-trip safely.
export function slugify(taskId: string): string {
	return taskId
		.toLowerCase()
		.replaceAll(/[:/]/gu, "_")
		.replaceAll(/[^a-z0-9_-]/gu, "_")
		.replaceAll(/_+/gu, "_")
		.replaceAll(/^_+|_+$/gu, "");
}

// Spike detection from the raw task JSON. The bash heredoc shelled out to
// python3; the plan's design decision 8 pulled that into native TypeScript
// so the wrapper has no python3 dependency at runtime. Rules:
//   (1) explicit [SPIKE] prefix in name / title / text_content
//   (2) title starts with a spike verb (spike / research / investigate / …)
//   (3) investigative-verb hits in the body outweigh code-shape hits
// A missing / malformed input defaults to false — the bash version silently
// swallowed JSON parse errors, and the tests assert the same.
export function detectSpikeFromTaskJson(input: unknown): boolean {
	if (input === null || input === undefined || typeof input !== "object") {
		return false;
	}
	const d = input as Record<string, unknown>;
	const title = String(d.name ?? d.title ?? "");
	const desc = String(d.text_content ?? d.description ?? "");
	let criteria = "";
	const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
	for (const f of customFields) {
		if (f !== null && typeof f === "object") {
			const field = f as Record<string, unknown>;
			const name = String(field.name ?? "").toLowerCase();
			if (name.includes("acceptance")) {
				criteria += `\n${String(field.value ?? "")}`;
			}
		}
	}
	// Rule 1: explicit [SPIKE] prefix on any of the three text fields.
	// The bash heredoc only searched title, but the tests fix a wider
	// contract — a description that starts with [SPIKE] still counts.
	if (
		/\[spike\]/iu.test(title) ||
		/\[spike\]/iu.test(desc) ||
		/\[spike\]/iu.test(String(d.text_content ?? ""))
	) {
		return true;
	}
	// Rule 2: title starts with a spike verb.
	if (/^\s*(spike|research|investigate|explore|figure[-\s_]?out)\b/iu.test(title)) {
		return true;
	}
	// Rule 3: investigative-verb density vs code-shape density in the body.
	const body = `${title}\n${desc}\n${criteria}`.toLowerCase();
	const spikeVerbRe =
		/\b(propose|describe|state|estimate|investigate|identify how|research|recommend|evaluate|compare|assess|explore|figure[-\s_]?out|determine|spike|review|examine|analyse|analyze|understand|characteri[sz]e|benchmark|survey|audit|weigh|consider)\b/gu;
	const codeShapeRe =
		/\b(endpoint returns|page renders|test turns green|route responds|add a test|write a test|component renders|api returns|migration adds|db writes)\b/gu;
	const spikeHits = body.match(spikeVerbRe)?.length ?? 0;
	const codeHits = body.match(codeShapeRe)?.length ?? 0;
	return spikeHits >= Math.max(2, codeHits + 1);
}

// Bundle-based spike signal — most authoritative when a prior workflow
// invocation has already produced intent_extract. Reads `intent_extract.is_spike`
// first, then falls back to a top-level `is_spike`. Malformed / null input
// defaults to false, matching the bash script's silent-swallow posture.
export function detectSpikeFromBundle(input: unknown): boolean {
	if (input === null || input === undefined || typeof input !== "object") {
		return false;
	}
	const b = input as Record<string, unknown>;
	const ie = b.intent_extract;
	if (ie && typeof ie === "object") {
		const flag = (ie as Record<string, unknown>).is_spike;
		if (typeof flag === "boolean") {
			return flag;
		}
	}
	return b.is_spike === true;
}

// Read + parse JSON at `path`. Returns undefined on any read / parse error —
// callers treat that as "no signal", not "hard fail", matching the bash
// heredoc that piped `|| echo false` around every python3 invocation.
function readJsonSafely(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function writeStderr(text: string): void {
	process.stderr.write(text);
}

function writeStdout(text: string): void {
	process.stdout.write(text);
}

type ParsedArgs = {
	readonly taskId: string;
	readonly driverArgs: readonly string[];
	readonly attempt: number;
	readonly repoSlug: string;
	readonly modeOverride: string;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
	const [taskId, ...rest] = argv;
	let attempt = 1;
	let repoSlug = "";
	let modeOverride = "";
	for (const a of rest) {
		if (a.startsWith("--attempt=")) {
			attempt = Math.trunc(Number(a.slice("--attempt=".length))) || 1;
		} else if (a.startsWith("--repo=")) {
			repoSlug = a.slice("--repo=".length);
		} else if (a.startsWith("--mode=")) {
			modeOverride = a.slice("--mode=".length);
		}
	}
	return { taskId: taskId ?? "", driverArgs: rest, attempt, repoSlug, modeOverride };
}

// Auto-detect the run mode. Precedence:
//   1. Explicit --mode override.
//   2. Bundle-based intent_extract.is_spike (iteration 2+).
//   3. First-iteration task JSON heuristic (native TS, no python3).
//   4. Default to "solve".
function resolveMode(
	modeOverride: string,
	bundlePath: string,
	taskJsonPath: string,
): { mode: Mode | string; source: "explicit --mode" | "auto-detected" } {
	if (modeOverride) {
		return { mode: modeOverride, source: "explicit --mode" };
	}
	if (existsSync(bundlePath)) {
		const isSpike = detectSpikeFromBundle(readJsonSafely(bundlePath));
		return { mode: isSpike ? "spike-writeup" : "solve", source: "auto-detected" };
	}
	if (existsSync(taskJsonPath)) {
		const isSpike = detectSpikeFromTaskJson(readJsonSafely(taskJsonPath));
		return { mode: isSpike ? "spike-writeup" : "solve", source: "auto-detected" };
	}
	return { mode: "solve", source: "auto-detected" };
}

// Apply the remote-mutation gate: when TRP_ALLOW_REMOTE_MUTATE!=true, strip
// --push / --push-force from the driver invocation and log the drop.
function applyRemoteMutationGate(driverArgs: readonly string[], logPath: string): string[] {
	if (process.env.TRP_ALLOW_REMOTE_MUTATE === "true") {
		return [...driverArgs];
	}
	const gated: string[] = [];
	let stripped = "";
	for (const a of driverArgs) {
		if (a === "--push" || a === "--push-force") {
			stripped = a;
		} else {
			gated.push(a);
		}
	}
	if (stripped) {
		const warn1 = "   TRP: remote mutation blocked — set TRP_ALLOW_REMOTE_MUTATE=true to enable\n";
		const warn2 = `   TRP: dropped driver arg '${stripped}'; Stage 8+ will not run\n`;
		writeStderr(warn1);
		writeStderr(warn2);
		// Best-effort log append, mirroring `tee -a "$LOG"`. Failures are
		// non-fatal — the operator still sees the warning on stderr.
		try {
			appendFileSync(logPath, warn1);
			appendFileSync(logPath, warn2);
		} catch {
			// swallow — log is advisory, not gate.
		}
	}
	return gated;
}

async function runDriver(
	taskId: string,
	bundlePath: string,
	gatedArgs: readonly string[],
): Promise<number> {
	const args = [taskId, `--after-workflow=${bundlePath}`, ...gatedArgs];
	const result = await sh("./scripts/fix-task.sh", args, {
		rejectOnError: false,
		journal: stdioJournal(),
		timeout: 0,
	});
	return result.exitCode;
}

function printHaltTrailer(
	status: number,
	taskId: string,
	slug: string,
	attempt: number,
	driverArgs: readonly string[],
): void {
	const nextAttempt = attempt + 1;
	const stage = status === 66 ? "Stage 5-8" : "post-push external review";
	// Preserve the double-space between $TASK_ID and $local_push_arg the bash
	// script produces when local_push_arg is empty — an operator's log-grep
	// relies on the exact trailer text.
	let localPushArg = "";
	for (const a of driverArgs) {
		if (a.startsWith("--push")) {
			localPushArg = a;
		}
	}
	writeStdout("\n");
	writeStdout(`=== TRP-EE: HALT (exit ${status} — ${stage}) ===\n`);
	writeStdout("  Next step (main Claude session):\n");
	writeStdout("\n");
	writeStdout("  1. Prep REVISE args:\n");
	writeStdout(
		`     TASK_ID_SLUG=${slug} python3 scripts/prep-revise-input.py > /tmp/trp-revise-args.json\n`,
	);
	writeStdout("\n");
	writeStdout("  2. Invoke workflow with those args:\n");
	writeStdout("     Workflow({ scriptPath: 'workflows/trp-fix-task.js',\n");
	writeStdout("                args: <parsed JSON contents of /tmp/trp-revise-args.json> })\n");
	writeStdout("\n");
	writeStdout("  3. Write returned bundle:\n");
	writeStdout(
		`     python3 -c "import json,sys,pathlib; pathlib.Path('discovery/trp-bundle-${slug}.json').write_text(json.dumps(<result>))"\n`,
	);
	writeStdout("\n");
	writeStdout("  4. Re-run this wrapper:\n");
	writeStdout(
		`     ./scripts/trp-run-loop.sh ${taskId} ${localPushArg} --attempt=${nextAttempt}\n`,
	);
	writeStdout("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	// --help / -h / empty — matches the bash `case "${1:-}"` at the top.
	const [first] = argv;
	if (first === "-h" || first === "--help") {
		writeStdout(`${USAGE}\n`);
		return 0;
	}
	if (!first) {
		writeStderr(`${USAGE}\n`);
		return 2;
	}

	const parsed = parseArgs(argv);
	const slug = slugify(parsed.taskId);
	const bundleSuffix = parsed.repoSlug ? `-${parsed.repoSlug}` : "";
	const bundlePath = `discovery/trp-bundle-${slug}${bundleSuffix}.json`;
	const logPath = `discovery/trp-run-${slug}.log`;
	const taskJsonPath = `discovery/task-${slug}.json`;

	try {
		mkdirSync("discovery", { recursive: true });
	} catch {
		// non-fatal — the discovery dir may already exist under another perm.
	}

	writeStdout(`=== TRP-EE loop wrapper for ${parsed.taskId} (attempt=${parsed.attempt}) ===\n`);

	const resolved = resolveMode(parsed.modeOverride, bundlePath, taskJsonPath);
	const { mode } = resolved;
	if (!VALID_MODES.has(mode as Mode)) {
		writeStderr(
			`ERROR: --mode=${mode} not in {spike-writeup,spike-solve,spike-full,solve,reproduce,support}\n`,
		);
		return 2;
	}
	process.env.TRP_TASK_MODE = mode;
	writeStdout(`   TRP_TASK_MODE=${mode} (${resolved.source})\n`);

	const gatedArgs = applyRemoteMutationGate(parsed.driverArgs, logPath);
	const status = await runDriver(parsed.taskId, bundlePath, gatedArgs);

	if (status === 0) {
		writeStdout("\n");
		writeStdout(`=== TRP-EE: SUCCESS (attempt ${parsed.attempt}) ===\n`);
		return 0;
	}
	if (status === 66 || status === 67) {
		printHaltTrailer(status, parsed.taskId, slug, parsed.attempt, parsed.driverArgs);
		return status;
	}
	writeStdout("\n");
	writeStdout(`=== TRP-EE: HARD FAIL (exit ${status}) ===\n`);
	return status;
}

// Only run main() when this file is invoked directly (not on test import).
function isDirectRun(): boolean {
	const [, entry] = process.argv;
	if (!entry) {
		return false;
	}
	try {
		return realpathSync(import.meta.filename) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	try {
		const code = await main();
		process.exit(code);
	} catch (error: unknown) {
		writeStderr(`trp-run-loop: unexpected error: ${String(error)}\n`);
		process.exit(1);
	}
}
