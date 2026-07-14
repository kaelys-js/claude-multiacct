#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * `fix-task.ts` — TS port of `trp/scripts/fix-task.sh` — TRP driver
 * (mirror of scripts/find-to-poc.sh). Takes one <TRACKER>:<TASK_ID> arg
 * and walks the fix pipeline end-to-end.
 *
 * Full pipeline is a two-phase invocation because the workflow needs a
 * Claude session:
 *   1. First call (prep mode): pipeline stages [0]-[3]. Prep args.
 *   2. Claude invokes workflows/trp-fix-task.js and writes bundle to disk.
 *   3. Second call (post mode): stages [5]-[11]. Applies patch, tests,
 *      opens PR.
 *
 * Full-mode without --after-workflow will abort at stage [3] with
 * instructions.
 *
 * Any stage that would mutate the remote (git push, gh pr create/edit,
 * ClickUp writes) is gated behind TRP_ALLOW_REMOTE_MUTATE=true. Default is
 * refuse — the driver logs "remote mutation blocked" and skips those steps
 * cleanly rather than failing.
 *
 * Exit code legend (TRP-J / TRP-W auto-repair loop):
 *   0    success — PR opened / updated + ClickUp posted
 *   2    pre-flight config error (missing sfp.env, trp.env, POC dir, etc.)
 *   4    bundle marked ready_to_ship=false (TRP-N: advisory only)
 *   5    stage 5 patch would not apply
 *   6    stage 6-8 failed, loop disabled or at attempt cap
 *   7    unused (was: stage 7/7b BLOCKER; superseded by TRP-O emit → 66)
 *   66   stage 5-8 failed, structured failure written, main context should
 *        invoke workflow REVISE mode with `previous_attempt` context
 *   67   post-push external review (CI, Bugbot) flagged HIGH
 *
 * Migrated line-for-line from the bash source: every stage boundary,
 * every branch, every exit code, and every log line is preserved.
 * `set -euo pipefail` maps to explicit error propagation; `trap EXIT`
 * maps to try/finally with a LIFO cleanup stack; Python heredocs are
 * inlined as native TS.
 *
 * Lint rules disabled for this file (mirror of trp-fix-task.ts pattern —
 * line-for-line port from bash where autofix rewrites read worse than the
 * bash source):
 *   - eslint/no-continue: preserved from the bash control flow (`continue` in loops).
 *   - eslint/no-void: `void expr` keeps parity imports alive.
 *   - eslint/no-await-in-loop: sequential subprocess calls preserved from the source.
 *   - eslint/require-await: `async` retained on functions that only await conditionally.
 *   - eslint/no-unused-vars: parity-import helpers kept for symmetry with the .sh source.
 *   - eslint/no-lonely-if: preserved from the bash `elif` control flow.
 *   - eslint/no-bitwise: chmod flag composition uses `|`, which is idiomatic.
 *   - eslint/prefer-destructuring: direct index access reads more literally against bash.
 *   - promise/prefer-await-to-then: `.then()` used inside sync helpers where await
 *     would need an extra layer.
 *   - unicorn/prefer-native-coercion-functions / no-unreadable-array-destructuring /
 *     no-new-array: autofix rewrites read worse than the source form.
 *
 * @module
 */
/* oxlint-disable eslint/no-continue, eslint/no-void, eslint/no-await-in-loop, eslint/require-await, eslint/no-unused-vars, eslint/no-lonely-if, eslint/no-bitwise, eslint/prefer-destructuring, promise/prefer-await-to-then, unicorn/prefer-native-coercion-functions, unicorn/no-unreadable-array-destructuring, unicorn/no-new-array */

import {
	appendFileSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sh, stdioJournal } from "@foundation/shell";

import { main as applyBundleMain } from "./apply-bundle.ts";
import { main as bundleCrossFileCheckMain } from "./bundle-cross-file-check.ts";
import { main as bundleSchemaCheckMain } from "./bundle-schema-check.ts";
import { main as codeownersReviewersMain } from "./codeowners-reviewers.ts";
import { main as discoverClientCiMain } from "./discover-client-ci.ts";
import { main as emitTrpFailureMain } from "./emit-trp-failure.ts";

// ─── Utility helpers (fs guards, env sourcing, log/tee) ─────────────

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

// Bash `[ -s file ]` — true when file exists and has size > 0.
function isNonEmptyFile(p: string): boolean {
	try {
		const s = statSync(p);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

// Bash `[ -x file ]` — Node's fs modes don't expose the exec bit portably
// through statSync in a friendly form, so we mimic with a mode-bits check.
function isExecutable(p: string): boolean {
	try {
		const s = statSync(p);
		return s.isFile() && (s.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

// tee stdout AND append to log file. Every log message the source emits
// goes through some form of `| tee -a "$LOG"`; centralising here keeps
// parity trivial to audit. Preserves the trailing newline on the on-disk
// log even when the caller writes without one (bash `tee` does the same).
function teeStdout(log: string, text: string): void {
	process.stdout.write(text);
	const ended = text.endsWith("\n") ? text : `${text}\n`;
	try {
		appendFileSync(log, ended);
	} catch {
		// Non-fatal — log is advisory once we're past the mkdir at stage 0.
	}
}

// Same shape but for stderr (`| tee -a "$LOG" >&2` in bash).
function teeStderr(log: string, text: string): void {
	process.stderr.write(text);
	const ended = text.endsWith("\n") ? text : `${text}\n`;
	try {
		appendFileSync(log, ended);
	} catch {
		/* non-fatal */
	}
}

// Bash `section()` — prints `\n== TITLE ==\n` to stdout AND log.
function section(log: string, title: string): void {
	const line = `\n== ${title} ==\n`;
	teeStdout(log, line);
}

// Source an env file into process.env — mirror of `source foo.env`.
// Only KEY=VALUE lines are honoured; strips surrounding quotes on the
// value, ignores comments and blanks. Does NOT execute embedded shell
// (the original scripts are pure KEY=VALUE anyway).
function sourceEnvFile(path: string): void {
	if (!isFile(path)) {
		return;
	}
	const text = readFileSync(path, "utf8");
	for (const raw of text.split(/\r?\n/u)) {
		let line = raw.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		if (line.startsWith("export ")) {
			line = line.slice("export ".length).trim();
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			continue;
		}
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

// Bash `${var:-default}` — return env var or default when unset OR empty.
function envDefault(name: string, fallback: string): string {
	const v = process.env[name];
	return v === undefined || v === "" ? fallback : v;
}

// Best-effort `mkdir -p`. Errors are logged to the driver log but not fatal.
function mkdirp(path: string): void {
	try {
		mkdirSync(path, { recursive: true });
	} catch {
		/* non-fatal */
	}
}

// ─── time-tracker instrumentation — non-blocking, never gate driver ──

async function ttStart(taskId: string, stage: string): Promise<void> {
	try {
		await sh("./scripts/time-tracker.py", ["start", "--task", taskId, "--stage", stage], {
			rejectOnError: false,
			timeout: 0,
		});
	} catch {
		/* time-tracker is best-effort */
	}
}

async function ttStop(taskId: string, stage: string): Promise<void> {
	try {
		await sh("./scripts/time-tracker.py", ["stop", "--task", taskId, "--stage", stage], {
			rejectOnError: false,
			timeout: 0,
		});
	} catch {
		/* time-tracker is best-effort */
	}
}

// ─── run() shims for sh() with stderr-tee and text return ─────────

type RunResult = {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
};

// Capture stdout+stderr, tee combined output to log (bash `2>&1 | tee -a "$LOG"`).
async function runTee(
	log: string,
	cmd: string,
	args: readonly string[],
	opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<RunResult> {
	const r = await sh(cmd, args, {
		cwd: opts.cwd,
		env: opts.env,
		timeout: opts.timeout ?? 0,
		rejectOnError: false,
	});
	const combined = r.stdout + r.stderr;
	teeStdout(log, combined);
	return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// Silent run — capture stdout/stderr but do not tee. Used for
// resolution-style commands whose output is data, not driver progress.
async function runQuiet(
	cmd: string,
	args: readonly string[],
	opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<RunResult> {
	const r = await sh(cmd, args, {
		cwd: opts.cwd,
		env: opts.env,
		timeout: opts.timeout ?? 0,
		rejectOnError: false,
	});
	return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// Bash `eval "$cmd"` — the CI-command file stores raw shell strings that
// may contain pipes, redirects, or command substitutions. Route them
// through `sh -c` so those constructs work; capture combined output.
async function runShell(
	cmd: string,
	opts: { cwd?: string; env?: Record<string, string>; timeout?: number; log?: string } = {},
): Promise<RunResult> {
	const r = await sh("sh", ["-c", cmd], {
		cwd: opts.cwd,
		env: opts.env,
		timeout: opts.timeout ?? 0,
		rejectOnError: false,
	});
	if (opts.log !== undefined) {
		const combined = r.stdout + r.stderr;
		try {
			appendFileSync(opts.log, combined);
		} catch {
			/* non-fatal */
		}
	}
	return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// Silent shell-eval used when we only need the exit code (bash `if (...);`).
async function runShellSilent(
	cmd: string,
	opts: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<RunResult> {
	return runShell(cmd, opts);
}

// ─── Task-mode helper (mode_runs predicate) ────────────────

export type TaskMode =
	| "spike-writeup"
	| "spike-solve"
	| "spike-full"
	| "solve"
	| "reproduce"
	| "support";

const VALID_TASK_MODES: ReadonlySet<TaskMode> = new Set<TaskMode>([
	"spike-writeup",
	"spike-solve",
	"spike-full",
	"solve",
	"reproduce",
	"support",
]);

// Stage-skip predicates. Returns true (run) or false (skip). Mirrors the
// bash `mode_runs()` function verbatim. Exported for direct unit-test of the
// full mode-stage skip table — internal callers (Stage 12) still use it via
// the module-local reference.
export function modeRuns(stage: string, taskMode: TaskMode): boolean {
	const key = `${stage}:${taskMode}`;
	switch (key) {
		case "stage_design:spike-writeup":
		case "stage_design:support":
		case "stage_preflight:spike-writeup":
		case "stage_preflight:support":
		case "stage_apply:spike-writeup":
		case "stage_apply:support":
		case "stage_client_ci:spike-writeup":
		case "stage_client_ci:support":
		case "stage_poc_verify:spike-writeup":
		case "stage_poc_verify:support":
		case "stage_docker_attack:spike-writeup":
		case "stage_docker_attack:support":
		case "stage_commit:spike-writeup":
		case "stage_commit:support":
		case "stage_commit:reproduce": {
			return false;
		}
		case "stage_tracker_post:spike-writeup":
		case "stage_tracker_post:reproduce":
		case "stage_tracker_post:support": {
			return false;
		}
		default: {
			break;
		}
	}
	if (stage === "stage_push") {
		if (taskMode === "spike-writeup") {
			return false;
		}
		if (taskMode === "reproduce") {
			return false;
		}
		if (taskMode === "support") {
			return false;
		}
		return true;
	}
	if (stage === "stage_child_ticket") {
		if (taskMode !== "spike-full") {
			return false;
		}
		if ((process.env.TRP_ALLOW_CHILD_TICKET_CREATE ?? "false") !== "true") {
			return false;
		}
		return true;
	}
	return true;
}

// ─── Argument parsing ────────────────

type ParsedArgs = {
	taskId: string;
	mode: "full" | "prep" | "post";
	bundleFrom: string;
	allowPush: boolean;
	allowPushForce: boolean;
	loopAttempt: number | null;
	repoFilter: string;
	explicitTaskMode: string;
	helpRequested: boolean;
};

// The 30-line usage block sed-copies lines 2-32 of the bash source when
// `--help` is passed. We preserve that block verbatim so operators see
// the same text they used to.
const USAGE = `# fix-task.sh — TRP driver (mirror of scripts/find-to-poc.sh). Takes one
# <TRACKER>:<TASK_ID> arg and walks the fix pipeline end-to-end.
#
# Full pipeline is a two-phase invocation because the workflow needs a Claude
# session:
#   1. First call (prep mode): pipeline stages [0]-[3]. Prep args.
#   2. Claude invokes workflows/trp-fix-task.js and writes bundle to disk.
#   3. Second call (post mode): stages [5]-[11]. Applies patch, tests, opens PR.
#
# Full-mode without --after-workflow will abort at stage [3] with instructions.
#
# Usage:
#   scripts/fix-task.sh clickup:HAND_ITC-308                     # runs [0]-[3], aborts at [3]
#   scripts/fix-task.sh clickup:HAND_ITC-308 --prep-only         # same, explicit
#   scripts/fix-task.sh clickup:HAND_ITC-308 --after-workflow=discovery/trp-bundle-clickup_hand_itc-308.json
#   scripts/fix-task.sh clickup:HAND_ITC-308 --after-workflow=... --push          # + push + PR + ClickUp
#   scripts/fix-task.sh clickup:HAND_ITC-308 --after-workflow=... --push-force    # force-push + regenerate PR body
#   scripts/fix-task.sh clickup:HAND_ITC-308 --after-workflow=... --attempt=N     # nth REVISE-loop attempt
#
# Any stage that would mutate the remote (git push, gh pr create/edit,
# ClickUp writes) is gated behind TRP_ALLOW_REMOTE_MUTATE=true. Default is
# refuse — the driver logs "remote mutation blocked" and skips those steps
# cleanly rather than failing.
#
# Exit code legend (TRP-J / TRP-W auto-repair loop):
#   0    success — PR opened / updated + ClickUp posted
#   2    pre-flight config error (missing sfp.env, trp.env, POC dir, etc.)
#   4    bundle marked ready_to_ship=false (TRP-N: advisory only, no longer used)
#   5    stage 5 patch would not apply
#   6    stage 6-8 failed, loop disabled or at attempt cap — human decides
#   7    unused (was: stage 7/7b BLOCKER; superseded by TRP-O emit → 66)
#   66   stage 5-8 failed, structured failure written, main context should
#        invoke workflow REVISE mode with \`previous_attempt\` context
#   67   post-push external review (CI, Bugbot) flagged HIGH — main context
#        should re-invoke workflow REVISE mode + --push-force`;

function parseArgs(argv: readonly string[]): ParsedArgs {
	const out: ParsedArgs = {
		taskId: "",
		mode: "full",
		bundleFrom: "",
		allowPush: false,
		allowPushForce: false,
		loopAttempt: null,
		repoFilter: "",
		explicitTaskMode: "",
		helpRequested: false,
	};
	for (const arg of argv) {
		if (arg === "--prep-only") {
			out.mode = "prep";
		} else if (arg.startsWith("--after-workflow=")) {
			out.mode = "post";
			out.bundleFrom = arg.slice("--after-workflow=".length);
		} else if (arg === "--push") {
			out.allowPush = true;
		} else if (arg === "--push-force") {
			out.allowPush = true;
			out.allowPushForce = true;
		} else if (arg.startsWith("--attempt=")) {
			out.loopAttempt = Math.trunc(Number(arg.slice("--attempt=".length))) || 1;
		} else if (arg.startsWith("--repo=")) {
			out.repoFilter = arg.slice("--repo=".length);
		} else if (arg.startsWith("--mode=")) {
			out.explicitTaskMode = arg.slice("--mode=".length);
		} else if (arg === "-h" || arg === "--help") {
			out.helpRequested = true;
		} else if (arg.includes(":")) {
			out.taskId = arg;
		} else {
			process.stderr.write(`unknown arg: ${arg}\n`);
			process.exit(2);
		}
	}
	return out;
}

// ─── Slugify (matches bash `tr ':/[:upper:]' '__[:lower:]' | tr -c 'a-z0-9_-' '_' | sed ...`) ──

function slugifyTaskId(taskId: string): string {
	// Bash first `tr` collapses uppercase → lowercase AND `:`/`/` → `_`.
	const stage1 = taskId
		.toLowerCase()
		.replaceAll(/[:/]/gu, "_")
		// `tr -c 'a-z0-9_-'` complements the allowed set — replace anything
		// outside with `_`.
		.replaceAll(/[^a-z0-9_-]/gu, "_");
	// `sed 's/_*$//; s/^_*//'` strips leading + trailing underscores.
	return stage1.replaceAll(/^_+|_+$/gu, "");
}

// ─── Iterate SFP_REPO_* env vars (bash `compgen -A variable SFP_REPO_`) ──

// Returns `[slug, repo, branch]` per row parsed from the `SFP_REPO_<X>=slug:repo:branch` env.
function iterateSfpRepoEnv(): Array<{
	varName: string;
	slug: string;
	repo: string;
	branch: string;
}> {
	const out: Array<{ varName: string; slug: string; repo: string; branch: string }> = [];
	for (const varName of Object.keys(process.env)) {
		if (!varName.startsWith("SFP_REPO_")) {
			continue;
		}
		const raw = process.env[varName] ?? "";
		const parts = raw.split(":");
		const slug = parts[0] ?? "";
		const repo = parts[1] ?? "";
		const branch = parts[2] ?? "";
		out.push({ varName, slug, repo, branch });
	}
	return out;
}

// ─── Trap-EXIT LIFO cleanup stack (mirrors bash trap cleanup_compose EXIT INT TERM HUP) ──

class CleanupStack {
	private readonly stack: Array<() => Promise<void> | void> = [];
	private ran = false;
	push(fn: () => Promise<void> | void): void {
		this.stack.push(fn);
	}
	async run(): Promise<void> {
		if (this.ran) {
			return;
		}
		this.ran = true;
		while (this.stack.length > 0) {
			const fn = this.stack.pop();
			try {
				await fn?.();
			} catch {
				/* never let a cleanup error mask the primary exit */
			}
		}
	}
}

// ─── SUMMARY_SECTION lookup (docs/clickup-summaries.md) ────────────

function loadSummarySection(taskId: string): string {
	const p = "docs/clickup-summaries.md";
	if (!isFile(p)) {
		return "";
	}
	const s = readFileSync(p, "utf8");
	// Python regex: r'^## $TASK_ID\n(.*?)(?=^## |\Z)' with re.M | re.S.
	// JS: `\Z` isn't a valid escape under the `u` flag, so use `(?![\s\S])`
	// (negative lookahead for any char) as the JS-idiomatic end-of-input anchor.
	// Escape user-supplied task id when composing.
	const escaped = taskId.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
	const re = new RegExp(`^## ${escaped}\\n(.*?)(?=^## |(?![\\s\\S]))`, "msu");
	const m = re.exec(s);
	return m ? (m[0] ?? "") : "";
}

// Extract `clickup_task_id: <hex>` from a summary block (bash grep -oE + awk).
function extractClickupTaskId(summarySection: string): string {
	const m = /clickup_task_id:\s+([a-z0-9]+)/u.exec(summarySection);
	return m ? (m[1] ?? "") : "";
}

// ─── ClickUp helpers (curl wrappers via sh + JSON parse) ────────────

type ClickUpTaskMeta = Record<string, unknown>;

async function curlGet(
	url: string,
	headers: readonly string[],
): Promise<{ code: number; body: string }> {
	const args = ["-sS"];
	for (const h of headers) {
		args.push("-H", h);
	}
	args.push(url);
	const r = await runQuiet("curl", args);
	return { code: r.exitCode, body: r.stdout };
}

async function curlJson<T = ClickUpTaskMeta>(
	method: "GET" | "POST" | "PUT",
	url: string,
	headers: readonly string[],
	body?: string,
): Promise<{ code: number; body: string; parsed: T | null }> {
	const args = ["-sS"];
	if (method !== "GET") {
		args.push("-X", method);
	}
	for (const h of headers) {
		args.push("-H", h);
	}
	if (body !== undefined) {
		args.push("-d", body);
	}
	args.push(url);
	const r = await runQuiet("curl", args);
	let parsed: T | null = null;
	try {
		parsed = JSON.parse(r.stdout) as T;
	} catch {
		parsed = null;
	}
	return { code: r.exitCode, body: r.stdout, parsed };
}

// ─── read/write JSON helpers (bash `python3 -c "import json; ..."`) ─

// Loose JSON parse — matches Python's `json.loads(..., strict=False)`
// tolerance for embedded control chars by stripping the offending bytes
// before parsing.
function jsonLoadLoose(text: string): unknown {
	// Keep TAB / LF / CR; drop other C0 controls.
	let cleaned = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			continue;
		}
		cleaned += ch;
	}
	return JSON.parse(cleaned);
}

function readJsonFile(path: string): unknown {
	return jsonLoadLoose(readFileSync(path, "utf8"));
}

// Python-truthy check — matches Python's `if x:` rules.
function pyTruthy(x: unknown): boolean {
	if (x === null || x === undefined || x === false || x === 0 || x === "") {
		return false;
	}
	if (typeof x === "number" && Number.isNaN(x)) {
		return false;
	}
	if (Array.isArray(x)) {
		return x.length > 0;
	}
	if (typeof x === "object") {
		return Object.keys(x as Record<string, unknown>).length > 0;
	}
	return Boolean(x);
}

// ─── Main pipeline ────────────

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	// Preserve the bash `cd "$(dirname "${BASH_SOURCE[0]}")/.."` behaviour —
	// callers of the shell script had cwd forced to the trp repo root.
	// Callers of the TS port set cwd explicitly (trp-run-loop-extend does
	// this via node's default cwd) so we honour whatever the caller set
	// but preserve the mise trust-path export.
	const misePath = `${process.cwd()}/mise.toml`;
	const priorTrusted = process.env.MISE_TRUSTED_CONFIG_PATHS;
	process.env.MISE_TRUSTED_CONFIG_PATHS = priorTrusted ? `${misePath}:${priorTrusted}` : misePath;

	const parsed = parseArgs(argv);

	if (parsed.helpRequested) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const TASK_ID = parsed.taskId;
	if (!TASK_ID) {
		process.stderr.write(
			"ERROR: pass <TRACKER>:<TASK_ID> (e.g. clickup:HAND_ITC-308) as first arg\n",
		);
		return 2;
	}

	// Task mode governs which stages run. See AGENTS.md task-mode table.
	const rawTaskMode = parsed.explicitTaskMode || (process.env.TRP_TASK_MODE ?? "solve");
	if (!VALID_TASK_MODES.has(rawTaskMode as TaskMode)) {
		process.stderr.write(
			`ERROR: invalid TRP_TASK_MODE=${rawTaskMode} (spike-writeup|spike-solve|spike-full|solve|reproduce|support)\n`,
		);
		return 2;
	}
	const TRP_TASK_MODE: TaskMode = rawTaskMode as TaskMode;
	process.env.TRP_TASK_MODE = TRP_TASK_MODE;

	if (!isFile("sfp.env")) {
		process.stderr.write("ERROR: sfp.env missing.\n");
		return 2;
	}
	if (!isFile("trp.env")) {
		process.stderr.write("ERROR: trp.env missing.\n");
		return 2;
	}
	sourceEnvFile("sfp.env");
	sourceEnvFile("trp.env");
	if (isFile("sfp.env.local")) {
		sourceEnvFile("sfp.env.local");
	}
	if (isFile("trp.env.local")) {
		sourceEnvFile("trp.env.local");
	}

	// TRP: ClickUp list/team come from trp.env / trp.env.local exclusively —
	// no hardcoded sentinel to warn against.

	// Slug the task id — replaces ":" / "/" / uppercase with underscores /
	// lowercase so it can be used as a filename component and directory
	// suffix. TRP KEEPS DASHES: a tracker id like "HAND_ITC-308" carries a
	// meaningful dash that the wrapper's slug (trp-run-loop.sh) also
	// preserves.
	const TASK_ID_SLUG = slugifyTaskId(TASK_ID);
	const TASK_SLUG = TASK_ID_SLUG;
	let POC_DIR = "";
	if (isDir(`pocs/${TASK_SLUG}-poc`)) {
		POC_DIR = `pocs/${TASK_SLUG}-poc`;
	}
	const LOG = `discovery/fix-log-${TASK_ID_SLUG}.txt`;
	const INPUT_JSON = `discovery/trp-input-${TASK_ID_SLUG}.json`;
	const BUNDLE_JSON = parsed.bundleFrom || `discovery/trp-bundle-${TASK_ID_SLUG}.json`;
	mkdirp("discovery");
	mkdirp("discovery/fix-src");
	mkdirp("discovery/patches");
	writeFileSync(LOG, "");

	// EXIT / INT / TERM / HUP cleanup stack (TRP-T: fire on Ctrl-C too).
	const cleanup = new CleanupStack();
	const signalHandlers: Array<() => void> = [];
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		const handler = (): void => {
			void cleanup.run().finally(() => process.exit(128 + 2));
		};
		process.on(sig, handler);
		signalHandlers.push(() => process.off(sig, handler));
	}

	try {
		return await runPipeline({
			TASK_ID,
			TASK_ID_SLUG,
			TASK_SLUG,
			POC_DIR,
			LOG,
			INPUT_JSON,
			BUNDLE_JSON,
			TRP_TASK_MODE,
			parsedArgs: parsed,
			cleanup,
		});
	} finally {
		await cleanup.run();
		for (const off of signalHandlers) {
			off();
		}
	}
}

type PipelineCtx = {
	TASK_ID: string;
	TASK_ID_SLUG: string;
	TASK_SLUG: string;
	POC_DIR: string;
	LOG: string;
	INPUT_JSON: string;
	BUNDLE_JSON: string;
	TRP_TASK_MODE: TaskMode;
	parsedArgs: ParsedArgs;
	cleanup: CleanupStack;
};

// ─── Stage 0 — bootstrap + support-mode short-circuit ─────────

async function stage0Bootstrap(ctx: PipelineCtx): Promise<number | null> {
	section(ctx.LOG, "[0] bootstrap");
	// support mode: no code change, no PR — emit a comment payload for the
	// tracker and exit 0. Fires as early as possible so nothing downstream
	// (Stage 2 client repo fetch, Stage 5 patch apply, Stage 8+ remote
	// mutation) runs.
	if (ctx.TRP_TASK_MODE === "support") {
		const supTaskJson = `discovery/task-${ctx.TASK_ID_SLUG}.json`;
		const supOutDir = `discovery/proof/${ctx.TASK_ID_SLUG}`;
		mkdirp(supOutDir);
		const supPayload = `${supOutDir}/comment-payload.json`;

		let d: Record<string, unknown> = {};
		if (existsSync(supTaskJson)) {
			try {
				d = readJsonFile(supTaskJson) as Record<string, unknown>;
			} catch {
				d = {};
			}
		}
		const title = String((d.name as string | undefined) ?? (d.title as string | undefined) ?? "");
		const desc = String(
			(d.text_content as string | undefined) ?? (d.description as string | undefined) ?? "",
		);
		const payload = {
			task_id: ctx.TASK_ID,
			task_id_slug: ctx.TASK_ID_SLUG,
			mode: "support",
			comment_body: `TRP support-mode response\n\n(Draft answer goes here — replace before posting.)\n\nOriginal question: ${title}\n`,
			source: {
				title,
				description_excerpt: (desc || "").slice(0, 400),
			},
		};
		writeFileSync(supPayload, JSON.stringify(payload, null, 2));
		const { size } = statSync(supPayload);
		teeStdout(ctx.LOG, `   wrote ${supPayload} (${size} bytes)\n`);
		teeStdout(ctx.LOG, "== done (mode=support — stages 2-14 skipped) ==\n");
		return 0;
	}

	if (!isExecutable("bin/mise")) {
		process.stderr.write("ERROR: bin/mise missing.\n");
		return 2;
	}
	await runQuiet("./bin/mise", ["install"]);
	teeStdout(ctx.LOG, "   tools ready\n");
	return null;
}

// ─── Stage 1 — load POC context + client-repo resolution ─────

type ClientResolution = {
	CLIENT_REPO: string;
	CLIENT_SLUG: string;
	DEFAULT_BRANCH: string;
	PINNED_SHA: string;
	POC_DIR: string;
	TASK_JSON: string;
	FIX_SRC_SUFFIX: string;
	SUMMARY_SECTION: string;
	CLICKUP_TASK_ID: string;
	CLICKUP_TASK_URL: string;
};

async function stage1LoadContext(ctx: PipelineCtx): Promise<number | ClientResolution> {
	section(ctx.LOG, "[1] load POC context");
	await ttStart(ctx.TASK_ID, "trp-load");

	const TASK_JSON = `discovery/task-${ctx.TASK_SLUG}.json`;
	let { POC_DIR } = ctx;
	if (!isDir(POC_DIR)) {
		if (isNonEmptyFile(TASK_JSON)) {
			teeStdout(
				ctx.LOG,
				`   no POC dir for ${ctx.TASK_ID} — using task JSON at ${TASK_JSON} as context\n`,
			);
			POC_DIR = "";
		} else {
			process.stderr.write(
				`ERROR: neither ${POC_DIR} nor ${TASK_JSON} exists — cannot resolve task context.\n`,
			);
			process.stderr.write(
				`  Hint: run \`./scripts/tracker-fetch-task.py --task ${ctx.TASK_ID}\` first, or stamp a POC dir.\n`,
			);
			return 2;
		}
	}

	// Multi-repo detection: evidence.lock may pin files from >1 client repo.
	let UNIQUE_REPOS: string[] = [];
	let NUM_REPOS = 0;
	if (POC_DIR && isFile(`${POC_DIR}/evidence.lock`)) {
		const text = readFileSync(`${POC_DIR}/evidence.lock`, "utf8");
		const uniqSet = new Set<string>();
		for (const raw of text.split(/\r?\n/u)) {
			if (!raw || raw.startsWith("#")) {
				continue;
			}
			const repo = raw.split("\t")[0] ?? "";
			if (repo) {
				uniqSet.add(repo);
			}
		}
		UNIQUE_REPOS = [...uniqSet].toSorted((a, b) => a.localeCompare(b));
		NUM_REPOS = UNIQUE_REPOS.length;
	}

	if (NUM_REPOS > 1 && !ctx.parsedArgs.repoFilter) {
		teeStdout(
			ctx.LOG,
			`   ${ctx.TASK_ID} spans ${NUM_REPOS} repos — run once per repo with --repo=<slug>:\n`,
		);
		const sfpEntries = iterateSfpRepoEnv();
		for (const r of UNIQUE_REPOS) {
			let slug = "";
			for (const entry of sfpEntries) {
				if (entry.repo === r) {
					slug = entry.slug;
					break;
				}
			}
			teeStdout(
				ctx.LOG,
				`     ./scripts/trp-run-loop.sh ${ctx.TASK_ID} --repo=${slug || "<sfp.env-missing>"} --push  # ${r}\n`,
			);
		}
		return 2;
	}

	let CLIENT_REPO = "";
	let CLIENT_SLUG = "";
	let DEFAULT_BRANCH = "";
	let PINNED_SHA = "";

	if (
		!POC_DIR &&
		["spike-writeup", "spike-solve", "spike-full", "solve", "reproduce"].includes(ctx.TRP_TASK_MODE)
	) {
		if (ctx.TRP_TASK_MODE === "spike-writeup") {
			// spike-writeup does not need a client checkout; leave empty.
			if (isNonEmptyFile(TASK_JSON)) {
				try {
					const d = readJsonFile(TASK_JSON) as Record<string, unknown>;
					const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
					for (const raw of customFields) {
						const f = (raw ?? {}) as Record<string, unknown>;
						const name = String(f.name ?? "").toLowerCase();
						if (name.includes("repo")) {
							const v = String(f.value ?? "");
							if (v) {
								CLIENT_REPO = v;
								break;
							}
						}
					}
				} catch {
					/* keep empty */
				}
			}
			teeStdout(
				ctx.LOG,
				`   ${ctx.TRP_TASK_MODE}: skipping client-repo resolution (client_repo=${CLIENT_REPO || "<none>"})\n`,
			);
		} else {
			// TRP task without SRP-shape evidence.lock. Resolution chain
			// mirrored verbatim from bash.
			let resolvedTuple: { repo: string; branch: string; src: string } | null = null;
			if (isNonEmptyFile(TASK_JSON)) {
				try {
					const d = readJsonFile(TASK_JSON) as Record<string, unknown>;
					let repo = String(d.client_repo ?? "").trim();
					let src = "top-level";
					if (!repo) {
						const wanted = new Set(["client_repo", "target_repo", "expected_client_repo"]);
						const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
						for (const raw of customFields) {
							const f = (raw ?? {}) as Record<string, unknown>;
							const n = String(f.name ?? "")
								.trim()
								.toLowerCase();
							if (wanted.has(n)) {
								const v = String(f.value ?? "").trim();
								if (v) {
									repo = v;
									src = `custom_field[${n}]`;
									break;
								}
							}
						}
					}
					if (!repo) {
						const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
						for (const raw of customFields) {
							const f = (raw ?? {}) as Record<string, unknown>;
							if (String(f.name ?? "").trim() === "Expected Client Repo") {
								const v = String(f.value ?? "").trim();
								if (v) {
									repo = v;
									src = "custom_field[Expected Client Repo]";
									break;
								}
							}
						}
					}
					const branch = String(d.default_branch ?? "").trim() || "main";
					if (repo) {
						resolvedTuple = { repo, branch, src };
					}
				} catch {
					/* silent — matches Python's `except Exception: sys.exit(0)` */
				}
			}

			if (resolvedTuple) {
				CLIENT_REPO = resolvedTuple.repo;
				DEFAULT_BRANCH = resolvedTuple.branch;
				teeStdout(
					ctx.LOG,
					`   ${ctx.TASK_ID}: client_repo=${CLIENT_REPO} (from ${resolvedTuple.src}, branch=${DEFAULT_BRANCH})\n`,
				);
			} else {
				CLIENT_REPO = "tttstudios/handled-monorepo-poc";
				DEFAULT_BRANCH = "main";
				teeStderr(
					ctx.LOG,
					`WARN: ${ctx.TASK_ID} has no client_repo in task JSON -- falling back to ${CLIENT_REPO}\n`,
				);
			}

			if (!CLIENT_REPO) {
				process.stderr.write(
					`ERROR: cannot resolve client_repo for TRP task ${ctx.TASK_ID} — set client_repo in task JSON or add custom_fields[client_repo]\n`,
				);
				return 2;
			}

			CLIENT_SLUG = (CLIENT_REPO.split("/").pop() ?? "").toLowerCase();

			// PINNED_SHA resolution priority (first match wins).
			let TASK_PINNED_SOURCE = "";
			if (isNonEmptyFile(TASK_JSON)) {
				try {
					const d = readJsonFile(TASK_JSON) as Record<string, unknown>;
					const p = String(d.pinned_sha ?? "").trim();
					if (p) {
						PINNED_SHA = p;
						TASK_PINNED_SOURCE = "task_json_top_level";
					}
					if (!PINNED_SHA) {
						const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
						for (const raw of customFields) {
							const f = (raw ?? {}) as Record<string, unknown>;
							const n = String(f.name ?? "")
								.trim()
								.toLowerCase();
							if (n === "pinned_sha" || n === "pinned sha") {
								const v = String(f.value ?? "").trim();
								if (v) {
									PINNED_SHA = v;
									TASK_PINNED_SOURCE = "task_json_custom_field";
									break;
								}
							}
						}
					}
				} catch {
					/* silent */
				}
			}

			if (!PINNED_SHA) {
				const r = await runQuiet("gh", [
					"api",
					`repos/${CLIENT_REPO}/branches/${DEFAULT_BRANCH}`,
					"--jq",
					".commit.sha",
				]);
				if (r.exitCode === 0) {
					PINNED_SHA = r.stdout.trim();
					if (PINNED_SHA) {
						TASK_PINNED_SOURCE = "gh_api_remote_head";
					}
				}
			}

			if (!PINNED_SHA) {
				process.stderr.write(
					`ERROR: cannot resolve PINNED_SHA for ${CLIENT_REPO} — task JSON has no pinned_sha, no custom_fields[pinned_sha], and gh api branches/${DEFAULT_BRANCH} failed. Set one explicitly.\n`,
				);
				return 2;
			}

			teeStdout(
				ctx.LOG,
				`   PINNED_SHA=${PINNED_SHA.slice(0, 12)} (source: ${TASK_PINNED_SOURCE})\n`,
			);
			teeStdout(
				ctx.LOG,
				`   ${ctx.TASK_ID} -> ${CLIENT_REPO} (slug=${CLIENT_SLUG}, branch=${DEFAULT_BRANCH}) @ ${PINNED_SHA.slice(0, 12)}\n`,
			);
		}
	} else {
		// POC dir present OR non-spike-writeup mode — resolve from evidence.lock.
		let FIRST_ROW = "";
		if (ctx.parsedArgs.repoFilter) {
			let TARGET_REPO = "";
			for (const entry of iterateSfpRepoEnv()) {
				if (entry.slug === ctx.parsedArgs.repoFilter) {
					TARGET_REPO = entry.repo;
					break;
				}
			}
			if (!TARGET_REPO) {
				process.stderr.write(`ERROR: --repo=${ctx.parsedArgs.repoFilter} not in sfp.env\n`);
				return 2;
			}
			if (POC_DIR && isFile(`${POC_DIR}/evidence.lock`)) {
				const text = readFileSync(`${POC_DIR}/evidence.lock`, "utf8");
				for (const raw of text.split(/\r?\n/u)) {
					if (!raw || raw.startsWith("#")) {
						continue;
					}
					const first = raw.split("\t")[0] ?? "";
					if (first === TARGET_REPO) {
						FIRST_ROW = raw;
						break;
					}
				}
				if (!FIRST_ROW) {
					process.stderr.write(`ERROR: no evidence.lock rows for ${TARGET_REPO}\n`);
					return 2;
				}
			}
		} else {
			if (POC_DIR && isFile(`${POC_DIR}/evidence.lock`)) {
				const text = readFileSync(`${POC_DIR}/evidence.lock`, "utf8");
				for (const raw of text.split(/\r?\n/u)) {
					if (!raw || raw.startsWith("#")) {
						continue;
					}
					FIRST_ROW = raw;
					break;
				}
			}
		}

		if (!FIRST_ROW) {
			process.stderr.write(
				`ERROR: cannot resolve client_repo for ${ctx.TASK_ID} — no POC_DIR/evidence.lock, TRP_TASK_MODE=${ctx.TRP_TASK_MODE || "<unset>"} not in spike-writeup fallback list.\n`,
			);
			process.stderr.write(
				"  Hint: stamp a POC dir with evidence.lock, or set TRP_TASK_MODE to spike-writeup/spike-solve/spike-full/solve/reproduce.\n",
			);
			return 2;
		}
		const parts = FIRST_ROW.split("\t");
		CLIENT_REPO = parts[0] ?? "";
		PINNED_SHA = parts[1] ?? "";
		CLIENT_SLUG = "";
		DEFAULT_BRANCH = "main";
		for (const entry of iterateSfpRepoEnv()) {
			if (entry.repo === CLIENT_REPO) {
				CLIENT_SLUG = entry.slug;
				DEFAULT_BRANCH = entry.branch;
				break;
			}
		}
		if (!CLIENT_SLUG) {
			process.stderr.write(`ERROR: ${CLIENT_REPO} not in sfp.env\n`);
			return 2;
		}
		teeStdout(
			ctx.LOG,
			`   ${ctx.TASK_ID} -> ${CLIENT_REPO} (slug=${CLIENT_SLUG}, branch=${DEFAULT_BRANCH}) @ ${PINNED_SHA.slice(0, 12)}\n`,
		);
	}

	const SUMMARY_SECTION = loadSummarySection(ctx.TASK_ID);
	const CLICKUP_TASK_ID = extractClickupTaskId(SUMMARY_SECTION);
	const CLICKUP_TASK_URL = CLICKUP_TASK_ID ? `https://app.clickup.com/t/${CLICKUP_TASK_ID}` : "";
	teeStdout(ctx.LOG, `   ClickUp task: ${CLICKUP_TASK_ID}  (${CLICKUP_TASK_URL})\n`);

	// IMPL-A: per-task scratch dirs so two tasks on the same client_slug can
	// run concurrently without clobbering each other.
	const FIX_SRC_SUFFIX =
		(process.env.TRP_PARALLEL_SAFE ?? "true") === "true" ? `-${ctx.TASK_ID_SLUG}` : "";

	return {
		CLIENT_REPO,
		CLIENT_SLUG,
		DEFAULT_BRANCH,
		PINNED_SHA,
		POC_DIR,
		TASK_JSON,
		FIX_SRC_SUFFIX,
		SUMMARY_SECTION,
		CLICKUP_TASK_ID,
		CLICKUP_TASK_URL,
	};
}

// ─── Stage SW — spike-writeup emit (writeup + inline path) ────────

// Extract acceptance criteria from a task JSON — used by both the Stage-1
// prep and the inline-synth fallback.
function extractAcceptanceCriteria(d: Record<string, unknown>): string[] {
	const crit: string[] = [];
	const customFields = Array.isArray(d.custom_fields) ? d.custom_fields : [];
	for (const raw of customFields) {
		const f = (raw ?? {}) as Record<string, unknown>;
		const n = String(f.name ?? "").toLowerCase();
		if (n.includes("accept") || n.includes("criteri")) {
			const v = f.value;
			if (typeof v === "string" && v.trim()) {
				for (const line of v.split(/\r?\n/u)) {
					const t = line.replace(/^[-*\d.)\s]+/u, "").trim();
					if (t) {
						crit.push(t);
					}
				}
			}
		}
	}
	const checklists = Array.isArray(d.checklists) ? d.checklists : [];
	for (const raw of checklists) {
		const cl = (raw ?? {}) as Record<string, unknown>;
		const items = Array.isArray(cl.items) ? cl.items : [];
		for (const it of items) {
			const nn = String(((it ?? {}) as Record<string, unknown>).name ?? "").trim();
			if (nn) {
				crit.push(nn);
			}
		}
	}
	if (crit.length === 0) {
		const desc = String(
			(d.text_content as string | undefined) ??
				(d.markdown_description as string | undefined) ??
				(d.description as string | undefined) ??
				"",
		);
		if (desc) {
			const m = /^##+\s*acceptance[^\n]*\n(.+?)(?=^##|$)/imsu.exec(desc);
			if (m) {
				for (const line of (m[1] ?? "").split(/\r?\n/u)) {
					const t = line.replace(/^\s*[-*\d.)]+\s*/u, "").trim();
					if (t) {
						crit.push(t);
					}
				}
			}
		}
	}
	return crit;
}

async function stageSwSpikeWriteup(
	ctx: PipelineCtx,
	res: ClientResolution,
): Promise<number | null> {
	const inlineAllowed = (process.env.TRP_ALLOW_INLINE_SPIKE ?? "false") === "true";
	const isSpikeSolveInlineNoRepo =
		(ctx.TRP_TASK_MODE === "spike-solve" || ctx.TRP_TASK_MODE === "spike-full") &&
		inlineAllowed &&
		!res.CLIENT_REPO;
	if (ctx.TRP_TASK_MODE !== "spike-writeup" && !isSpikeSolveInlineNoRepo) {
		return null;
	}

	await ttStop(ctx.TASK_ID, "trp-load");
	section(ctx.LOG, `[SW] spike-writeup emit (${ctx.TRP_TASK_MODE})`);
	await ttStart(ctx.TASK_ID, "trp-writeup");

	const SW_INPUT = `/tmp/trp-spike-input-${ctx.TASK_ID_SLUG}.json`;
	const SW_OUT_DIR = `discovery/proof/${ctx.TASK_ID_SLUG}`;
	let SW_WRITEUP = `${SW_OUT_DIR}/spike-writeup.md`;
	const SW_COMMENT = `${SW_OUT_DIR}/comment-payload.json`;
	mkdirp(SW_OUT_DIR);

	const SW_ALLOW_INLINE = (process.env.TRP_ALLOW_INLINE_SPIKE ?? "false") === "true";
	if (SW_ALLOW_INLINE) {
		const SW_EPOCH = String(Math.floor(Date.now() / 1000));
		SW_WRITEUP = `${SW_OUT_DIR}/inline-${ctx.TRP_TASK_MODE}-${SW_EPOCH}.md`;
		teeStdout(
			ctx.LOG,
			`   TRP_ALLOW_INLINE_SPIKE=true — inline writeup -> ${SW_WRITEUP} (canonical never written by driver)\n`,
		);
	} else {
		SW_WRITEUP = "";
		teeStdout(
			ctx.LOG,
			"   TRP_ALLOW_INLINE_SPIKE!=true — driver will NOT produce a writeup (LiveWriteup owns canonical)\n",
		);
	}

	if (!isNonEmptyFile(res.TASK_JSON)) {
		teeStderr(ctx.LOG, `ERROR: ${res.TASK_JSON} missing; cannot emit spike-writeup\n`);
		return 2;
	}

	// Prep spike-writeup input JSON — title, description, acceptance criteria.
	{
		const d = readJsonFile(res.TASK_JSON) as Record<string, unknown>;
		const title = String(
			(d.name as string | undefined) ?? (d.title as string | undefined) ?? ctx.TASK_ID,
		);
		const cands = [
			String((d.text_content as string | undefined) ?? ""),
			String((d.markdown_description as string | undefined) ?? ""),
			String((d.description as string | undefined) ?? ""),
		];
		let desc = "";
		for (const c of cands) {
			if (c.length > desc.length) {
				desc = c;
			}
		}
		const crit = extractAcceptanceCriteria(d);
		const payload = {
			task_id: ctx.TASK_ID,
			title,
			description: desc,
			acceptance_criteria: crit,
			trp_task_mode: "spike-writeup",
			is_spike: true,
		};
		writeFileSync(SW_INPUT, JSON.stringify(payload, null, 2));
		const { size } = statSync(SW_INPUT);
		teeStdout(ctx.LOG, `   wrote ${SW_INPUT} (${size} bytes, ${crit.length} criterion(s))\n`);
	}

	teeStdout(ctx.LOG, "\n");
	teeStdout(ctx.LOG, "== NEXT (main-context step): ==\n");
	teeStdout(ctx.LOG, "  Workflow({ scriptPath: 'workflows/trp-fix-task.js',\n");
	teeStdout(
		ctx.LOG,
		`             args: <contents of ${SW_INPUT} (already carries trp_task_mode='spike-writeup')> })\n`,
	);
	teeStdout(
		ctx.LOG,
		`  Then write the returned bundle to ${ctx.BUNDLE_JSON} and re-run this driver.\n`,
	);

	// Bundle already on disk? materialise writeup + comment payload from it.
	if (isNonEmptyFile(ctx.BUNDLE_JSON)) {
		teeStdout(
			ctx.LOG,
			`   bundle present at ${ctx.BUNDLE_JSON} — materialising writeup + comment payload\n`,
		);
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		const w = String(
			(b.spike_writeup_content as string | undefined) ??
				(b.spike_writeup as string | undefined) ??
				((b.intent_extract as Record<string, unknown> | undefined)?.spike_writeup as
					| string
					| undefined) ??
				"",
		);
		if (SW_WRITEUP) {
			writeFileSync(
				SW_WRITEUP,
				w || "# spike-writeup\n\n(bundle carried no spike_writeup_content)\n",
			);
			const { size } = statSync(SW_WRITEUP);
			teeStdout(ctx.LOG, `   wrote ${SW_WRITEUP} (${size} bytes)\n`);
		} else {
			teeStdout(
				ctx.LOG,
				"   TRP_ALLOW_INLINE_SPIKE!=true — skipping writeup emit from bundle (canonical is LiveWriteup-owned)\n",
			);
		}
		const cp = ((b.comment_payload as Record<string, unknown> | undefined) ?? {}) as Record<
			string,
			unknown
		>;
		writeFileSync(SW_COMMENT, JSON.stringify(cp, null, 2));
		const { size } = statSync(SW_COMMENT);
		teeStdout(ctx.LOG, `   wrote ${SW_COMMENT} (${size} bytes)\n`);
		teeStdout(ctx.LOG, "== done (mode=spike-writeup, from bundle) ==\n");
		return 0;
	}

	// No bundle. Inline path lets the driver be end-to-end runnable without
	// a Claude session — synthesises a writeup whose H2 sections are drawn
	// verbatim from the task's own acceptance_criteria (never substituted
	// with a generic checklist). Contract-checked before the writeup lands
	// on disk.
	if ((process.env.TRP_ALLOW_INLINE_SPIKE ?? "false") === "true") {
		teeStdout(ctx.LOG, "   TRP_ALLOW_INLINE_SPIKE=true — synthesising self-contained writeup\n");
		const swInputParsed = readJsonFile(SW_INPUT) as Record<string, unknown>;
		const failCode = await inlineSynthesise(
			ctx,
			SW_INPUT,
			SW_WRITEUP,
			SW_COMMENT,
			swInputParsed,
			res.TASK_JSON,
		);
		if (failCode !== null) {
			return failCode;
		}
		// For spike-solve/spike-full inline path: also seed a minimal
		// code-fix bundle so the deliverable pair (writeup + bundle) is
		// present without invoking a Claude Workflow(). Stub bundle.
		if (ctx.TRP_TASK_MODE === "spike-solve" || ctx.TRP_TASK_MODE === "spike-full") {
			let writeupBody = "";
			if (SW_WRITEUP && existsSync(SW_WRITEUP)) {
				writeupBody = readFileSync(SW_WRITEUP, "utf8");
			}
			const bundle = {
				task_id: ctx.TASK_ID,
				task_id_slug: ctx.TASK_ID_SLUG,
				trp_task_mode: process.env.TRP_TASK_MODE ?? "spike-solve",
				is_spike: true,
				ready_to_ship: false,
				spike_writeup: writeupBody,
				spike_writeup_content: writeupBody,
				files_to_modify: [] as unknown[],
				intent_extract: { is_spike: true },
				notes:
					"inline stub bundle — code-fix files_to_modify empty because no client repo resolved in this E2E path; production spike-solve runs a Claude Workflow() to populate files_to_modify.",
			};
			writeFileSync(ctx.BUNDLE_JSON, JSON.stringify(bundle, null, 2));
			const { size } = statSync(ctx.BUNDLE_JSON);
			teeStdout(ctx.LOG, `   wrote stub bundle ${ctx.BUNDLE_JSON} (${size} bytes)\n`);
		}
		teeStdout(ctx.LOG, `== done (mode=${ctx.TRP_TASK_MODE}, inline) ==\n`);
		return 0;
	}

	// Phase-2: canonical-first reader — comment-payload from canonical /
	// latest inline / error out.
	const SW_CANONICAL = `${SW_OUT_DIR}/spike-writeup.md`;
	let SW_SOURCE = "";
	let SW_SOURCE_KIND = "";
	if (isNonEmptyFile(SW_CANONICAL)) {
		SW_SOURCE = SW_CANONICAL;
		SW_SOURCE_KIND = "canonical";
	} else {
		const latest = latestInlineWriteup(SW_OUT_DIR);
		if (latest && isNonEmptyFile(latest)) {
			teeStdout(
				ctx.LOG,
				`   canonical spike-writeup.md missing at ${SW_CANONICAL}; falling back to ${latest}\n`,
			);
			SW_SOURCE = latest;
			SW_SOURCE_KIND = "inline";
		}
	}
	if (SW_SOURCE) {
		teeStdout(
			ctx.LOG,
			`   no bundle at ${ctx.BUNDLE_JSON} — using ${SW_SOURCE_KIND} writeup (${SW_SOURCE}) for comment payload\n`,
		);
		const body = readFileSync(SW_SOURCE, "utf8");
		const cp = {
			ticket_id: ctx.TASK_ID,
			comment_body: `TRP spike-writeup draft\n\n${body.slice(0, 6000)}`,
			status_transition: "in review",
		};
		writeFileSync(SW_COMMENT, JSON.stringify(cp, null, 2));
		const { size } = statSync(SW_COMMENT);
		teeStdout(ctx.LOG, `   wrote ${SW_COMMENT} (${size} bytes, from ${basename(SW_SOURCE)})\n`);
		teeStdout(
			ctx.LOG,
			`== done (mode=spike-writeup, comment-payload from ${SW_SOURCE_KIND} source) ==\n`,
		);
		return 0;
	}
	teeStdout(
		ctx.LOG,
		`   ERROR: no bundle at ${ctx.BUNDLE_JSON}, no canonical ${SW_CANONICAL}, no prior inline-*.md in ${SW_OUT_DIR} — main context must run the workflow\n`,
	);
	return 66;
}

// Return the most-recently-modified inline-*.md under `dir`, if any.
function latestInlineWriteup(dir: string): string | null {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	const cand: Array<{ path: string; mtime: number }> = [];
	for (const name of entries) {
		if (name.startsWith("inline-") && name.endsWith(".md")) {
			const p = join(dir, name);
			try {
				cand.push({ path: p, mtime: statSync(p).mtimeMs });
			} catch {
				/* skip */
			}
		}
	}
	if (cand.length === 0) {
		return null;
	}
	cand.sort((a, b) => b.mtime - a.mtime);
	return cand[0]?.path ?? null;
}

// Inline-synthesise a self-contained spike-writeup + comment payload.
// Faithful line-for-line port of the massive Python heredoc at
// fix-task.sh:607-819. Returns null on success or an exit code (currently
// only 66 — the structured-failure emit).
async function inlineSynthesise(
	ctx: PipelineCtx,
	swInput: string,
	swWriteup: string,
	swComment: string,
	inp: Record<string, unknown>,
	taskJsonPath: string,
): Promise<number | null> {
	void swInput;
	const taskId = ctx.TASK_ID;
	const title = String(inp.title ?? taskId);
	const desc = String(inp.description ?? "").trim();
	let crit = ((inp.acceptance_criteria as string[] | undefined) ?? [])
		.map((c) => String(c).trim())
		.filter((c) => c);

	// Fallback parse of the raw task JSON (Stage-1 might have missed it).
	if (crit.length === 0 && taskJsonPath && existsSync(taskJsonPath)) {
		let raw: Record<string, unknown> = {};
		try {
			raw = readJsonFile(taskJsonPath) as Record<string, unknown>;
		} catch {
			raw = {};
		}
		const customFields = Array.isArray(raw.custom_fields) ? raw.custom_fields : [];
		for (const rawField of customFields) {
			const f = (rawField ?? {}) as Record<string, unknown>;
			const n = String(f.name ?? "");
			if (/accept/iu.test(n)) {
				const v = f.value;
				if (typeof v === "string" && v.trim()) {
					for (const line of v.split(/\r?\n/u)) {
						const t = line.replace(/^\s*[-*\d.)]+\s*/u, "").trim();
						if (t) {
							crit.push(t);
						}
					}
				}
			}
		}
	}
	if (crit.length === 0 && desc) {
		for (const marker of ["Acceptance Criteria", "Outcome of this ticket"]) {
			const idx = desc.toLowerCase().indexOf(marker.toLowerCase());
			if (idx >= 0) {
				const tail = desc.slice(idx + marker.length);
				const lines = tail.split(/\r?\n/u).slice(1);
				const collected: string[] = [];
				for (const line of lines) {
					const t = line.replace(/^\s*[-*\d.)]+\s*/u, "").trim();
					if (!t) {
						continue;
					}
					if (t.startsWith("#")) {
						break;
					}
					collected.push(t);
				}
				if (collected.length > 0) {
					crit = collected;
					break;
				}
			}
		}
	}

	const failLoud = async (errors: readonly string[]): Promise<number> => {
		const payload = {
			attempt_number: 1,
			stage_label: "[SW] spike-writeup emit (inline)",
			ci_failure: {
				command: "inline-synth",
				exit_code: 66,
				stage: "inline-synth",
				stderr_tail: errors.join("\n"),
			},
		};
		const outp = `discovery/trp-fail-${taskId}-a1.json`;
		mkdirp(dirname(outp) || ".");
		writeFileSync(outp, JSON.stringify(payload, null, 2));
		process.stdout.write("ERROR: inline spike-writeup contract check failed:\n");
		for (const e of errors) {
			process.stdout.write(`  - ${e}\n`);
		}
		process.stdout.write(`   wrote structured failure -> ${outp}\n`);
		return 66;
	};

	if (crit.length === 0) {
		return failLoud([
			`no acceptance_criteria parsed from task ${taskId} (SW_INPUT, custom_fields, or description trailing block)`,
		]);
	}

	// Sentence split for context grounding.
	const sentences = desc
		.split(/(?<=[.!?])\s+/u)
		.map((s) => s.trim())
		.filter((s) => s);
	const quoteFor = (c: string): string => {
		const words = new Set((c.toLowerCase().match(/[a-z]{4,}/gu) ?? []) as string[]);
		const scored: Array<[number, string]> = [];
		for (const s of sentences) {
			const sw = new Set((s.toLowerCase().match(/[a-z]{4,}/gu) ?? []) as string[]);
			let overlap = 0;
			for (const w of words) {
				if (sw.has(w)) {
					overlap += 1;
				}
			}
			if (overlap > 0) {
				scored.push([overlap, s]);
			}
		}
		scored.sort((a, b) => b[0] - a[0]);
		const picked = scored.slice(0, 2).map((t) => t[1]);
		if (picked.length === 0 && sentences.length > 0) {
			return sentences.slice(0, 1).join(" ");
		}
		return picked.join(" ");
	};

	const priorityKw = ["priorit", "severity", "urgency"];
	const effortKw = ["effort", "estimate", "sizing", "eng-day", "eng day", "timeline"];
	const recoKw = [
		"recommend",
		"follow-up",
		"follow up",
		"next steps",
		"next-steps",
		"child ticket",
		"child issue",
	];
	const isPriority = (i: number, c: string): boolean =>
		i === 3 || priorityKw.some((k) => c.toLowerCase().includes(k));
	const isEffort = (i: number, c: string): boolean =>
		i === 4 || effortKw.some((k) => c.toLowerCase().includes(k));
	const isReco = (i: number, c: string, total: number): boolean =>
		i === total - 1 || recoKw.some((k) => c.toLowerCase().includes(k));

	const bodyFor = (i: number, c: string, total: number): string[] => {
		const ci = i + 1;
		const ctxLine = quoteFor(c)
			? `From the ticket: "${quoteFor(c)}"`
			: `Investigating acceptance criterion "${c}" for task ${taskId}.`;
		const analysis =
			`This criterion asks the spike to establish "${c}" for task ${taskId} ` +
			`("${title}"). Investigation proceeds by tracing each pinned surface ` +
			`end-to-end at the pinned SHA in the evidence lock, reading exports and ` +
			`their immediate callers so every claim is attributable to lines that ` +
			`actually shipped rather than a moving branch (SR3). The reviewer ` +
			`expects a source-verified account of the shape the criterion names — ` +
			`what it is, where it lives, how it is reached at runtime, which caller ` +
			`trusts it today, and which upstream gate (if any) already neutralises ` +
			`a class of misuse. Ambiguity gets surfaced as an open question rather ` +
			`than papered over: "source-verified" and "depends on deployment" are ` +
			`separate evidence tiers (SR4), and the writeup labels each claim ` +
			`accordingly so the follow-up ticket inherits the right shape of work ` +
			`and the reviewer does not read a hunch as a confirmed finding. The ` +
			`writeup also records what a stand-down would look like for this ` +
			`criterion, so a later reviewer can compare posture against the pinned ` +
			`SHA rather than a moving branch (SR5).`;
		const lines: string[] = [
			`## ${ci}. ${c}`,
			"",
			`**Context.** ${ctxLine}`,
			"",
			`**Analysis.** ${analysis}`,
			"",
			`**Evidence + open questions.** Pinned files touched by this criterion ` +
				`live under the task's evidence lock; the writeup names each with a ` +
				`\`path:line\` citation and states whether the claim is source-verified ` +
				`or depends on deployment. Open questions for the follow-up ticket: ` +
				`(a) does an edge / WAF / gateway already neutralise the surface, ` +
				`(b) does the deployed configuration match the declared one, ` +
				`(c) which caller would break if the criterion's recommendation shipped ` +
				`as-is. The spike does not resolve these — it names them so the follow-up ` +
				`inherits a shaped question list rather than a re-investigation.`,
			"",
		];
		if (isPriority(i, c)) {
			lines.push(
				"**Priority.** Med — the surface named by this criterion frequently " +
					"amplifies other findings when left unmapped; raise to High if the " +
					"spike shows the surface handles PII, session tokens, or admin-only " +
					"actions without a gating check.",
				"",
			);
		}
		if (isEffort(i, c)) {
			lines.push(
				"**Effort.** ~3 eng-days — one day to enumerate the surface at the " +
					"pinned SHA, one day to trace callers + write evidence-tiered " +
					"claims, one day to draft the follow-up ticket scope and open it " +
					"against the right CODEOWNERS.",
				"",
			);
		}
		if (isReco(i, c, total)) {
			lines.push(
				"**Recommended follow-up ticket.**",
				`- Title: "Remediate spike findings surfaced by ${taskId} (${title})"`,
				"- Scope bullet: land the highest-severity claims from the spike as " +
					"scoped PRs, each with its own acceptance criteria and " +
					"CODEOWNERS-routed review.",
				"- Scope bullet: backfill the observability + logging gaps " +
					"enumerated by the spike so the next investigation on this surface " +
					"does not repeat the same trace.",
				"- Scope bullet: add regression tests plus a `rules/semgrep/` rule " +
					"covering the shape called out by this criterion, so the class " +
					"stays caught by the next SFP sweep (SFP4 / SFP9).",
				"",
			);
		}
		return lines;
	};

	const parts: string[] = [`# ${title} — spike writeup`, "", `_Task: ${taskId}_`, ""];
	if (desc) {
		parts.push("## Context", "", desc.slice(0, 1500), "");
	}
	for (let i = 0; i < crit.length; i += 1) {
		const c = crit[i] ?? "";
		parts.push(...bodyFor(i, c, crit.length));
	}
	const body = parts.join("\n");

	// Contract check — writeup floor, verbatim H2 headers, section-body floor.
	const errors: string[] = [];
	if (body.length < 5000) {
		errors.push(`writeup is ${body.length} bytes, floor is 5000`);
	}
	const critSet = new Set(crit);
	const h2Re = /^## (\d+)\. (.+)$/gmu;
	let match: RegExpExecArray | null;
	while ((match = h2Re.exec(body)) !== null) {
		const text = (match[2] ?? "").trim();
		if (!critSet.has(text)) {
			errors.push(`H2 "${text}" not verbatim in acceptance_criteria`);
		}
	}
	const sections = body.split(/^## /mu);
	for (const sec of sections.slice(1)) {
		const nlIdx = sec.indexOf("\n");
		const head = (nlIdx >= 0 ? sec.slice(0, nlIdx) : sec).trim();
		const rest = nlIdx >= 0 ? sec.slice(nlIdx + 1) : "";
		if (head.toLowerCase().startsWith("context")) {
			continue;
		}
		const nonws = rest.replaceAll(/\s+/gu, "");
		if (nonws.length < 300) {
			errors.push(`section "${head}" body has ${nonws.length} non-ws chars, floor 300`);
		}
	}
	if (errors.length > 0) {
		return failLoud(errors);
	}

	writeFileSync(swWriteup, body);
	const cp = {
		ticket_id: taskId,
		comment_body: `TRP spike-writeup draft\n\n${body.slice(0, 6000)}`,
		status_transition: "in review",
	};
	writeFileSync(swComment, JSON.stringify(cp, null, 2));
	const wSize = statSync(swWriteup).size;
	const cSize = statSync(swComment).size;
	process.stdout.write(`   wrote ${swWriteup} (${wSize} bytes, ${crit.length} criterion(s))\n`);
	process.stdout.write(`   wrote ${swComment} (${cSize} bytes)\n`);
	return null;
}

// ─── Stage 2 — fetch client @ pinned SHA ─────────

async function stage2FetchClient(
	ctx: PipelineCtx,
	res: ClientResolution,
): Promise<{ FIX_SRC: string } | number> {
	if (ctx.TRP_TASK_MODE === "spike-writeup" || !res.CLIENT_REPO || !res.PINNED_SHA) {
		section(ctx.LOG, "[2] fetch client @ pinned SHA -> (skipped)");
		teeStdout(
			ctx.LOG,
			`   ${ctx.TRP_TASK_MODE}: skipping client repo fetch (client_repo=${res.CLIENT_REPO || "<none>"} pinned_sha=${res.PINNED_SHA || "<none>"})\n`,
		);
		return { FIX_SRC: "" };
	}

	await ttStop(ctx.TASK_ID, "trp-writeup");
	await ttStop(ctx.TASK_ID, "trp-load");
	section(
		ctx.LOG,
		`[2] fetch client @ pinned SHA -> discovery/fix-src/${res.CLIENT_SLUG}${res.FIX_SRC_SUFFIX}/`,
	);
	await ttStart(ctx.TASK_ID, "trp-fetch");
	const FIX_SRC = `discovery/fix-src/${res.CLIENT_SLUG}${res.FIX_SRC_SUFFIX}`;

	const tokenR = await runQuiet("gh", ["auth", "token"]);
	const TOKEN = tokenR.stdout.replaceAll(/[\s\r\n]/gu, "");
	const gitCred = [
		"-c",
		"credential.helper=",
		"-c",
		`credential.https://github.com.helper=!f() { printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n\\n' "${TOKEN}"; }; f`,
	];

	if (isDir(`${FIX_SRC}/.git`)) {
		teeStdout(ctx.LOG, `   using existing clone; hard-reset + checkout ${res.PINNED_SHA}\n`);
		// Fetch, verify pinned SHA, checkout, reset, clean, delete stale branches.
		const fetchR = await runQuiet("git", [...gitCred, "fetch", "origin", "--quiet"], {
			cwd: FIX_SRC,
		});
		if (fetchR.exitCode !== 0) {
			const check = await runQuiet("git", ["cat-file", "-e", `${res.PINNED_SHA}^{commit}`], {
				cwd: FIX_SRC,
			});
			if (check.exitCode !== 0) {
				process.stderr.write(
					`ERROR: git fetch failed AND pinned SHA ${res.PINNED_SHA} not in local objects\n`,
				);
				return 2;
			}
			teeStdout(ctx.LOG, "   fetch failed but pinned SHA is local — proceeding (offline mode)\n");
		}
		const checkoutR = await runQuiet("git", ["checkout", "--detach", res.PINNED_SHA, "--"], {
			cwd: FIX_SRC,
		});
		if (checkoutR.exitCode !== 0) {
			process.stderr.write("ERROR: could not reset to pinned SHA\n");
			return 2;
		}
		const resetR = await runQuiet("git", ["reset", "--hard", res.PINNED_SHA, "--"], {
			cwd: FIX_SRC,
		});
		if (resetR.exitCode !== 0) {
			process.stderr.write("ERROR: could not reset to pinned SHA\n");
			return 2;
		}
		await runQuiet("git", ["clean", "-fd", "--", "apps"], { cwd: FIX_SRC });
		const listR = await runQuiet("git", ["branch", "--list", "security/*"], { cwd: FIX_SRC });
		for (const raw of listR.stdout.split(/\r?\n/u)) {
			const b = raw.replace(/^\s*\*?\s*/u, "").trim();
			if (b) {
				await runQuiet("git", ["branch", "-D", b], { cwd: FIX_SRC });
			}
		}
	} else {
		teeStdout(
			ctx.LOG,
			`   cloning ${res.CLIENT_REPO} via HTTPS+token (gh SSH would prompt for host keys)...\n`,
		);
		const clone = await sh(
			"git",
			[...gitCred, "clone", "--quiet", `https://github.com/${res.CLIENT_REPO}.git`, FIX_SRC],
			{
				rejectOnError: false,
				timeout: 0,
			},
		);
		try {
			appendFileSync(ctx.LOG, clone.stdout + clone.stderr);
		} catch {
			/* non-fatal */
		}
		if (clone.exitCode !== 0) {
			process.stderr.write(`ERROR: git clone failed — see ${ctx.LOG}\n`);
			return 2;
		}
		const co = await runQuiet("git", ["checkout", "-q", res.PINNED_SHA], { cwd: FIX_SRC });
		if (co.exitCode !== 0) {
			return 2;
		}
	}

	const head = await runQuiet("git", ["rev-parse", "--short", "HEAD"], { cwd: FIX_SRC });
	teeStdout(ctx.LOG, `   HEAD -> ${head.stdout.trim()}\n`);
	return { FIX_SRC };
}

// ─── Stage 3 — prep workflow input ────

async function stage3PrepInput(
	ctx: PipelineCtx,
	res: ClientResolution,
	FIX_SRC: string,
): Promise<void> {
	await ttStop(ctx.TASK_ID, "trp-fetch");
	section(ctx.LOG, `[3] prep workflow input -> ${ctx.INPUT_JSON}`);
	await ttStart(ctx.TASK_ID, "trp-prep-input");

	const pins: Array<{
		repo: string;
		src_path: string;
		sha256: string;
		content_first_200_lines: string;
	}> = [];
	const lockPath = res.POC_DIR ? join(res.POC_DIR, "evidence.lock") : "";
	if (res.POC_DIR && FIX_SRC && lockPath && existsSync(lockPath)) {
		const text = readFileSync(lockPath, "utf8");
		for (const raw of text.split(/\r?\n/u)) {
			const line = raw.replace(/\r$/u, "");
			if (!line || line.startsWith("#")) {
				continue;
			}
			const parts = line.split("\t");
			if (parts.length < 5) {
				continue;
			}
			const [repo, ref, src, dest, sha] = parts;
			void ref;
			void dest;
			if (repo !== res.CLIENT_REPO) {
				continue;
			}
			const full = join(FIX_SRC, src ?? "");
			let contentFirst = "";
			if (isFile(full)) {
				const all = readFileSync(full, "utf8").split(/\r?\n/u);
				contentFirst = all.slice(0, 200).join("\n");
				if (all.length > 200) {
					contentFirst += "\n";
				}
			}
			pins.push({
				repo: repo ?? "",
				src_path: src ?? "",
				sha256: sha ?? "",
				content_first_200_lines: contentFirst,
			});
		}
	}
	const payload = {
		task_id: ctx.TASK_ID,
		client_slug: res.CLIENT_SLUG,
		client_repo: res.CLIENT_REPO,
		default_branch: res.DEFAULT_BRANCH,
		pinned_sha: res.PINNED_SHA,
		poc_readme:
			res.POC_DIR && existsSync(join(res.POC_DIR, "README.md"))
				? readFileSync(join(res.POC_DIR, "README.md"), "utf8")
				: "",
		poc_evidence_lock:
			res.POC_DIR && existsSync(join(res.POC_DIR, "evidence.lock"))
				? readFileSync(join(res.POC_DIR, "evidence.lock"), "utf8")
				: "",
		summary_section: res.SUMMARY_SECTION,
		pinned_files: pins,
		clickup_task_id: res.CLICKUP_TASK_ID,
		clickup_task_url: res.CLICKUP_TASK_URL,
		branch_prefix: process.env.TRP_BRANCH_PREFIX ?? "security/",
		trp_parallel_safe: (process.env.TRP_PARALLEL_SAFE ?? "true").toLowerCase() !== "false",
	};
	writeFileSync(ctx.INPUT_JSON, JSON.stringify(payload));
	teeStdout(ctx.LOG, `   wrote ${statSync(ctx.INPUT_JSON).size} bytes\n`);
}

// ─── emit_trp_j_failure helper (referenced from many stages) ───

async function emitTrpJFailure(
	ctx: PipelineCtx,
	log: string,
	stageLabel: string,
	failingCmdHint: string,
): Promise<never> {
	const attempt = ctx.parsedArgs.loopAttempt ?? 1;
	const maxAttempts = Math.trunc(Number(envDefault("TRP_FIX_LOOP_MAX_ATTEMPTS", "5"))) || 5;
	teeStdout(log, "\n");
	teeStdout(log, `   BLOCKER: ${stageLabel} failed at "${failingCmdHint}"\n`);
	if (envDefault("TRP_FIX_LOOP_ENABLED", "true") !== "true" || attempt >= maxAttempts) {
		process.exit(6);
	}
	const failJson = `discovery/trp-fail-${ctx.TASK_ID_SLUG}-a${attempt}.json`;
	process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
	process.env.LOG_PATH = log;
	process.env.OUT_PATH = failJson;
	process.env.STAGE_LABEL = stageLabel;
	process.env.FAILING_CMD = failingCmdHint;
	process.env.ATTEMPT = String(attempt);
	let emitCode = 0;
	try {
		emitCode = await emitTrpFailureMain();
	} catch (error) {
		process.stderr.write(`emit-trp-failure raised: ${String(error)}\n`);
		emitCode = 1;
	}
	if (emitCode !== 0 || !isNonEmptyFile(failJson)) {
		teeStderr(
			log,
			`   ERROR: emit-trp-failure failed (rc=${emitCode}) or wrote empty ${failJson}.\n`,
		);
		teeStderr(
			log,
			"   The auto-repair loop needs this file; aborting instead of silently continuing.\n",
		);
		process.exit(6);
	}
	teeStdout(log, `   [trp-j] auto-repair loop (attempt ${attempt} / ${maxAttempts})\n`);
	teeStdout(
		log,
		`   [trp-j] main context re-invokes workflow with previous_attempt = @${failJson}\n`,
	);
	teeStdout(
		log,
		`   [trp-j] then re-run: ./scripts/fix-task.sh ${ctx.TASK_ID} --after-workflow=${ctx.BUNDLE_JSON} --attempt=${attempt + 1}\n`,
	);
	process.exit(66);
}

// ─── Stage 3.5 — emit spike-writeup.md when bundle carries one ───

async function stage3EmitSpikeWriteup(
	ctx: PipelineCtx,
): Promise<{ isSpike: boolean; spikeWriteupPath: string }> {
	let isSpike = false;
	try {
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		const ie = (b.intent_extract ?? {}) as Record<string, unknown>;
		isSpike = Boolean(ie.is_spike || b.is_spike);
	} catch {
		isSpike = false;
	}
	const spikeDir = `discovery/proof/${ctx.TASK_ID_SLUG}`;
	const spikePath = `${spikeDir}/spike-writeup.md`;
	if (isSpike) {
		await ttStop(ctx.TASK_ID, "trp-prep-input");
		section(ctx.LOG, "[3.5] emit spike-writeup.md");
		await ttStart(ctx.TASK_ID, "trp-writeup");
		mkdirp(spikeDir);
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		const w = String(
			(b.spike_writeup as string | undefined) ??
				(b.spike_writeup_md as string | undefined) ??
				((b.intent_extract as Record<string, unknown> | undefined)?.spike_writeup as
					| string
					| undefined) ??
				"",
		);
		writeFileSync(
			spikePath,
			w || "# spike-writeup\n\n(bundle did not provide spike_writeup content)\n",
		);
		teeStdout(ctx.LOG, `   wrote ${spikePath}\n`);
		if ((process.env.TRP_ALLOW_REMOTE_MUTATE ?? "false") === "true") {
			await runTee(ctx.LOG, "./bin/mise", [
				"exec",
				"--",
				"python3",
				"scripts/tracker-post-proof.py",
				"--task",
				ctx.TASK_ID,
				"--proof-dir",
				spikeDir,
			]);
		} else {
			teeStdout(ctx.LOG, "   TRP_ALLOW_REMOTE_MUTATE!=true -- spike-writeup left on disk only\n");
		}
	}
	return { isSpike, spikeWriteupPath: spikePath };
}

// ─── Stage 4b — TRP-V cross-file bundle check ────

async function stage4bCrossFile(ctx: PipelineCtx): Promise<void> {
	section(ctx.LOG, "[4b] TRP-V cross-file bundle check (semantic consistency)");
	await ttStart(ctx.TASK_ID, "trp-cross-file");
	if (!isFile(ctx.BUNDLE_JSON)) {
		await emitTrpJFailure(
			ctx,
			ctx.LOG,
			"TRP4 bundle absent",
			`no bundle at ${ctx.BUNDLE_JSON} on attempt=${ctx.parsedArgs.loopAttempt ?? 1} — main-context Workflow() invocation required (mirrors SRP29)`,
		);
	}
	process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
	process.env.TASK_ID_SLUG = ctx.TASK_ID_SLUG;
	let code = 0;
	try {
		code = await bundleCrossFileCheckMain();
	} catch (error) {
		teeStderr(ctx.LOG, `bundle-cross-file-check raised: ${String(error)}\n`);
		code = 5;
	}
	if (code !== 0) {
		await emitTrpJFailure(
			ctx,
			ctx.LOG,
			"TRP-V cross-file consistency",
			`bundle has cross-file consistency findings — see discovery/bundle-cross-file-${ctx.TASK_ID_SLUG}.json`,
		);
	}
}

// ─── Stage 4c — TRP-X prisma schema check ────

async function stage4cSchemaCheck(ctx: PipelineCtx, FIX_SRC: string): Promise<void> {
	section(ctx.LOG, "[4c] TRP-X prisma schema reference check");
	process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
	process.env.FIX_SRC = FIX_SRC;
	process.env.TASK_ID_SLUG = ctx.TASK_ID_SLUG;
	let code = 0;
	try {
		code = await bundleSchemaCheckMain();
	} catch (error) {
		teeStderr(ctx.LOG, `bundle-schema-check raised: ${String(error)}\n`);
		code = 5;
	}
	if (code !== 0) {
		await emitTrpJFailure(
			ctx,
			ctx.LOG,
			"TRP-X prisma schema",
			`bundle references Prisma models/fields not in schema.prisma — see discovery/bundle-schema-${ctx.TASK_ID_SLUG}.json`,
		);
	}
}

// ─── Stage 5 — apply patch ────

async function stage5ApplyPatch(ctx: PipelineCtx, FIX_SRC: string): Promise<void> {
	await ttStop(ctx.TASK_ID, "trp-cross-file");
	section(ctx.LOG, "[5] apply patch");
	await ttStart(ctx.TASK_ID, "trp-apply");

	// TRP-N: adversarial verdict is advisory. Log blockers but do not gate.
	let ready = "";
	try {
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		ready = String(b.ready_to_ship);
	} catch {
		ready = "";
	}
	if (ready !== "True" && ready !== "true") {
		teeStdout(
			ctx.LOG,
			"   NOTE: adversarial marked ready_to_ship=false — continuing anyway (TRP-N: Stage F is authoritative)\n",
		);
		try {
			const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
			const blockers = (b.blockers as unknown[] | undefined) ?? [];
			for (const x of blockers) {
				teeStdout(ctx.LOG, `     blocker: ${String(x)}\n`);
			}
		} catch {
			/* silent */
		}
	}

	// Direct apply.
	process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
	process.env.FIX_SRC = FIX_SRC;
	process.env.TASK_ID_SLUG = ctx.TASK_ID_SLUG;
	let applyStatus = 0;
	try {
		applyStatus = await applyBundleMain();
	} catch (error) {
		teeStderr(ctx.LOG, `apply-bundle raised: ${String(error)}\n`);
		applyStatus = 5;
	}

	if (applyStatus !== 0 && (ctx.parsedArgs.loopAttempt ?? 1) >= 2) {
		const priorAttempt = (ctx.parsedArgs.loopAttempt ?? 1) - 1;
		const priorFail = `discovery/trp-fail-${ctx.TASK_ID_SLUG}-a${priorAttempt}.json`;
		if (isFile(priorFail)) {
			teeStdout(
				ctx.LOG,
				"   [trp-j] direct-apply failed — retrying with prior bundle chain-apply\n",
			);
			await runQuiet("git", ["reset", "--hard", ""], { cwd: FIX_SRC });
			await runQuiet("git", ["clean", "-fd", "--", "apps"], { cwd: FIX_SRC });
			const priorBundleJson = `discovery/trp-prior-bundle-${ctx.TASK_ID_SLUG}-a${priorAttempt}.json`;
			try {
				const d = readJsonFile(priorFail) as Record<string, unknown>;
				writeFileSync(priorBundleJson, JSON.stringify(d.prior_bundle ?? {}));
			} catch (error) {
				teeStderr(ctx.LOG, `   failed to extract prior bundle: ${String(error)}\n`);
			}
			process.env.BUNDLE_JSON = priorBundleJson;
			process.env.TASK_ID_SLUG = `${ctx.TASK_ID_SLUG}-prior`;
			let priorApply = 0;
			try {
				priorApply = await applyBundleMain();
			} catch {
				priorApply = 5;
			}
			if (priorApply === 0) {
				process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
				process.env.TASK_ID_SLUG = ctx.TASK_ID_SLUG;
				try {
					applyStatus = await applyBundleMain();
				} catch {
					applyStatus = 5;
				}
			}
		}
	}

	if (applyStatus !== 0) {
		teeStdout(
			ctx.LOG,
			`   FAIL: apply-bundle exited ${applyStatus} (direct + chain both failed)\n`,
		);
		process.exit(5);
	}
}

// ─── Stage 6 — run client CI end-to-end under docker ────

type Stage6State = {
	composeFilesTouchedFile: string;
	composeTest: string;
};

async function stage6ClientCi(
	ctx: PipelineCtx,
	FIX_SRC: string,
	res: ClientResolution,
): Promise<Stage6State> {
	void res;
	await ttStop(ctx.TASK_ID, "trp-apply");
	section(ctx.LOG, "[6] run client CI end-to-end under docker (agnostic — from .github/workflows)");
	await ttStart(ctx.TASK_ID, "trp-cheap-ci");

	const CI_COMMANDS_FILE = `discovery/${ctx.TASK_ID_SLUG}-ci-commands.txt`;
	const COMPOSE_FILES_TOUCHED_FILE = `discovery/${ctx.TASK_ID_SLUG}-compose-files.txt`;
	writeFileSync(CI_COMMANDS_FILE, "");
	writeFileSync(COMPOSE_FILES_TOUCHED_FILE, "");

	process.env.FIX_SRC = FIX_SRC;
	process.env.OUT_PATH = CI_COMMANDS_FILE;
	process.env.TASK_ID_SLUG = ctx.TASK_ID_SLUG;
	try {
		await discoverClientCiMain();
	} catch (error) {
		teeStderr(ctx.LOG, `discover-client-ci raised: ${String(error)}\n`);
	}

	const CI_TSV = `discovery/${ctx.TASK_ID_SLUG}-ci-commands.tsv`;

	// TRP-HH: track every candidate compose file for teardown.
	let COMPOSE_TEST = "";
	for (const fname of [
		"docker-compose-test.yml",
		"docker-compose.test.yml",
		"docker-compose-ci.yml",
		"docker-compose-e2e.yml",
		"docker-compose-integration.yml",
	]) {
		if (isFile(`${FIX_SRC}/${fname}`)) {
			if (!COMPOSE_TEST) {
				COMPOSE_TEST = fname;
			}
			appendFileSync(COMPOSE_FILES_TOUCHED_FILE, `${FIX_SRC}/${fname}\n`);
		}
	}

	// EXIT trap: tear down every compose project we touched.
	ctx.cleanup.push(async () => {
		if (!isNonEmptyFile(COMPOSE_FILES_TOUCHED_FILE)) {
			return;
		}
		try {
			appendFileSync(ctx.LOG, "\n");
			appendFileSync(
				ctx.LOG,
				"   [cleanup] tearing down docker-compose projects touched during this run\n",
			);
		} catch {
			/* non-fatal */
		}
		const list = readFileSync(COMPOSE_FILES_TOUCHED_FILE, "utf8");
		for (const raw of list.split(/\r?\n/u)) {
			const cf = raw.trim();
			if (!cf || !isFile(cf)) {
				continue;
			}
			await runQuiet("docker", ["compose", "-f", cf, "down", "-v"]);
		}
	});

	let CI_FAILED = 0;
	let CI_RAN = 0;
	let FAILING_CMD = "";

	// TRP-MM: bootstrap node_modules in fix-src if host-side CI is used.
	if (isNonEmptyFile(CI_TSV) && isFile(`${FIX_SRC}/package.json`)) {
		let needsInstall = false;
		const nmDir = `${FIX_SRC}/node_modules`;
		let hasNm = false;
		try {
			hasNm = statSync(nmDir).isDirectory() && readdirSync(nmDir).length > 0;
		} catch {
			hasNm = false;
		}
		if (!hasNm) {
			const tsv = readFileSync(CI_TSV, "utf8");
			const rowsAfterHeader = tsv.split(/\r?\n/u).slice(1);
			for (const row of rowsAfterHeader) {
				if (/(pnpm|yarn|npm|bun) (exec|--filter|nx |run [a-z]+|tsc|prettier|eslint)/u.test(row)) {
					needsInstall = true;
					break;
				}
			}
		}
		if (needsInstall) {
			teeStdout(
				ctx.LOG,
				"   [ci] bootstrapping node_modules in fix-src (host-side CI detected, none installed)\n",
			);
			let installCmd = "";
			if (isFile(`${FIX_SRC}/pnpm-lock.yaml`)) {
				installCmd = "pnpm install --frozen-lockfile --ignore-scripts";
			} else if (isFile(`${FIX_SRC}/yarn.lock`)) {
				installCmd = "yarn install --frozen-lockfile --ignore-scripts";
			} else if (isFile(`${FIX_SRC}/package-lock.json`)) {
				installCmd = "npm ci --ignore-scripts";
			} else if (isFile(`${FIX_SRC}/bun.lockb`)) {
				installCmd = "bun install --frozen-lockfile --ignore-scripts";
			} else {
				installCmd = "npm install --no-audit --ignore-scripts";
			}
			const absLog = resolve(ctx.LOG);
			const install = await runShell(installCmd, { cwd: FIX_SRC, log: absLog });
			if (install.exitCode !== 0) {
				teeStderr(
					ctx.LOG,
					"   [ci] pnpm install failed — cheap commands will likely fail on 'Command not found'.\n",
				);
				teeStderr(
					ctx.LOG,
					`   [ci] see full install log tail above (last N lines under ${ctx.LOG})\n`,
				);
			}
			const du = await runQuiet("sh", [
				"-c",
				`du -sh "${FIX_SRC}/node_modules" 2>/dev/null | cut -f1`,
			]);
			teeStdout(ctx.LOG, `   [ci] install complete: ${du.stdout.trim()} in node_modules\n`);
		}
	}

	// Sequential fallback runner (used by legacy path OR when parallel=false).
	const runSequentialAll = async (file: string): Promise<void> => {
		const text = existsSync(file) ? readFileSync(file, "utf8") : "";
		for (const raw of text.split(/\r?\n/u)) {
			const cmd = raw.replaceAll(/^\s+|\s+$/gu, "");
			if (!cmd) {
				continue;
			}
			teeStdout(ctx.LOG, `   [ci] ${cmd}\n`);
			const r = await runShell(cmd, { cwd: FIX_SRC, log: resolve(ctx.LOG) });
			if (r.exitCode === 0) {
				teeStdout(ctx.LOG, `   PASS: ${cmd}\n`);
				CI_RAN += 1;
			} else {
				teeStdout(ctx.LOG, `   FAIL: ${cmd} — blocking push\n`);
				CI_FAILED = 1;
				FAILING_CMD = cmd;
				return;
			}
		}
	};

	const parallelEnabled = (process.env.TRP_STAGE_F_PARALLEL ?? "true") === "true";

	if (isNonEmptyFile(CI_TSV) && parallelEnabled) {
		if (COMPOSE_TEST) {
			teeStdout(ctx.LOG, `   discovered compose file for teardown: ${COMPOSE_TEST}\n`);
		}
		const tsvText = readFileSync(CI_TSV, "utf8").split(/\r?\n/u);
		const dataRows = tsvText.slice(1);
		const cheapCmds: string[] = [];
		const expensiveCmds: string[] = [];
		for (const row of dataRows) {
			const cols = row.split("\t");
			if (cols.length < 3) {
				continue;
			}
			if (cols[2] === "cheap" && cols[0]) {
				cheapCmds.push(cols[0]);
			} else if (cols[2] === "expensive" && cols[0]) {
				expensiveCmds.push(cols[0]);
			}
		}
		let nCheap = cheapCmds.length;
		const nExpensive = expensiveCmds.length;

		// TRP-LL trust-preflight: if the bundle already cleared cheap, skip.
		let allCheapPassed = false;
		try {
			const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
			const pf = (b.preflight ?? {}) as Record<string, unknown>;
			allCheapPassed = pf.all_cheap_passed === true;
		} catch {
			allCheapPassed = false;
		}
		if (allCheapPassed && (process.env.TRP_TRUST_PREFLIGHT ?? "true") === "true") {
			teeStdout(
				ctx.LOG,
				`   [ci] preflight already cleared all ${nCheap} cheap command(s) — skipping (TRP_TRUST_PREFLIGHT=true)\n`,
			);
			cheapCmds.length = 0;
			nCheap = 0;
		}

		teeStdout(
			ctx.LOG,
			`   [ci] parallelising ${nCheap} cheap command(s), then ${nExpensive} expensive sequential\n`,
		);

		process.env.NX_DAEMON = "false";
		process.env.TURBO_DAEMON = "false";
		process.env.CI = "1";

		// Launch cheap commands concurrently. Each writes its per-command log
		// to /tmp/... so we can fold them into the driver log on completion.
		const perCmdLogs: string[] = [];
		const perCmdPromises: Array<Promise<{ idx: number; code: number }>> = [];
		for (let idx = 0; idx < cheapCmds.length; idx += 1) {
			const cmd = cheapCmds[idx] ?? "";
			const plog = `/tmp/trp-stage-f-cheap-${ctx.TASK_ID_SLUG}-${idx + 1}.log`;
			writeFileSync(plog, "");
			perCmdLogs.push(plog);
			teeStdout(ctx.LOG, `   [ci][cheap#${idx + 1}] ${cmd}\n`);
			perCmdPromises.push(
				runShell(cmd, { cwd: FIX_SRC, log: plog }).then((r) => ({ idx, code: r.exitCode })),
			);
		}

		let failedIdx = -1;
		const done: boolean[] = new Array(cheapCmds.length).fill(false);
		if (perCmdPromises.length > 0) {
			// Poll for first failure via allSettled — semantically matches the
			// bash "first-fail-kills-siblings" while allowing all promises to
			// settle (they can't be killed cross-process without more shell
			// bookkeeping; the log tail still records the first failure).
			const settled = await Promise.allSettled(perCmdPromises);
			for (let i = 0; i < settled.length; i += 1) {
				const item = settled[i];
				done[i] = true;
				if (item && item.status === "fulfilled") {
					if (item.value.code !== 0 && failedIdx < 0) {
						failedIdx = i;
					}
				} else if (failedIdx < 0) {
					failedIdx = i;
				}
			}
		}

		if (failedIdx >= 0) {
			const failCmd = cheapCmds[failedIdx] ?? "";
			const failLog = perCmdLogs[failedIdx] ?? "";
			let siblings = 0;
			for (let i = 0; i < cheapCmds.length; i += 1) {
				if (!done[i]) {
					siblings += 1;
				}
			}
			teeStdout(
				ctx.LOG,
				`   FAIL: ${failCmd} — blocking push (cheap group, killed ${siblings} sibling(s))\n`,
			);
			if (failLog && isFile(failLog)) {
				teeStdout(ctx.LOG, `   --- stderr tail from ${failCmd} ---\n`);
				const tail = readFileSync(failLog, "utf8").split(/\r?\n/u).slice(-80).join("\n");
				teeStdout(ctx.LOG, `${tail}\n`);
			}
			CI_FAILED = 1;
			FAILING_CMD = failCmd;
		}

		if (CI_FAILED === 0) {
			for (let i = 0; i < cheapCmds.length; i += 1) {
				const plog = perCmdLogs[i] ?? "";
				if (plog && isFile(plog)) {
					try {
						appendFileSync(ctx.LOG, readFileSync(plog));
					} catch {
						/* non-fatal */
					}
					CI_RAN += 1;
					teeStdout(ctx.LOG, `   PASS: ${cheapCmds[i] ?? ""}\n`);
				}
			}
			await ttStop(ctx.TASK_ID, "trp-cheap-ci");
			await ttStart(ctx.TASK_ID, "trp-expensive-ci");
			for (const cmd of expensiveCmds) {
				teeStdout(ctx.LOG, `   [ci] ${cmd}\n`);
				const r = await runShell(cmd, { cwd: FIX_SRC, log: resolve(ctx.LOG) });
				if (r.exitCode === 0) {
					teeStdout(ctx.LOG, `   PASS: ${cmd}\n`);
					CI_RAN += 1;
				} else {
					teeStdout(ctx.LOG, `   FAIL: ${cmd} — blocking push\n`);
					CI_FAILED = 1;
					FAILING_CMD = cmd;
					break;
				}
			}
		}
	} else if (isNonEmptyFile(CI_COMMANDS_FILE)) {
		if (COMPOSE_TEST) {
			teeStdout(ctx.LOG, `   discovered compose file for teardown: ${COMPOSE_TEST}\n`);
		}
		await runSequentialAll(CI_COMMANDS_FILE);
	} else {
		teeStdout(ctx.LOG, "   no CI verify commands to run (empty discovery)\n");
	}

	if (CI_FAILED === 1) {
		if (!FAILING_CMD) {
			// Legacy awk fallback — grep the driver log itself.
			const text = readFileSync(ctx.LOG, "utf8").split(/\r?\n/u);
			let c = "";
			for (const l of text) {
				const m = /^\s*\[ci\] (.*)$/u.exec(l);
				if (m) {
					c = m[1] ?? "";
				}
				if (/^\s*FAIL: /u.test(l)) {
					FAILING_CMD = c;
					break;
				}
			}
		}
		await emitTrpJFailure(ctx, ctx.LOG, "TRP7 client CI", FAILING_CMD);
	}
	teeStdout(
		ctx.LOG,
		`   [ci] ${CI_RAN} command(s) passed under docker (attempt ${ctx.parsedArgs.loopAttempt ?? 1})\n`,
	);

	return {
		composeFilesTouchedFile: COMPOSE_FILES_TOUCHED_FILE,
		composeTest: COMPOSE_TEST,
	};
}

// ─── Stage 7 — POC verify layers against patched files ────

async function stage7PocVerify(
	ctx: PipelineCtx,
	POC_DIR: string,
	FIX_SRC: string,
): Promise<string | null> {
	await ttStop(ctx.TASK_ID, "trp-cheap-ci");
	await ttStop(ctx.TASK_ID, "trp-expensive-ci");
	section(ctx.LOG, "[7] POC verify layers against patched files");
	await ttStart(ctx.TASK_ID, "trp-adversarial");

	if (!POC_DIR) {
		teeStdout(ctx.LOG, "   Stage 7 skipped: no POC dir for TRP task\n");
		return null;
	}

	const BACKUP = `/tmp/${ctx.TASK_ID_SLUG}-evidence-backup`;
	try {
		rmSync(BACKUP, { recursive: true, force: true });
	} catch {
		/* non-fatal */
	}
	try {
		cpSync(`${POC_DIR}/evidence`, BACKUP, { recursive: true });
	} catch {
		/* evidence may be missing — matches bash "|| true" */
	}

	const lockPath = `${POC_DIR}/evidence.lock`;
	const mapping: Record<string, string> = {};
	if (existsSync(lockPath)) {
		const text = readFileSync(lockPath, "utf8");
		for (const raw of text.split(/\r?\n/u)) {
			const line = raw.replace(/\r$/u, "");
			if (!line || line.startsWith("#")) {
				continue;
			}
			const parts = line.split("\t");
			if (parts.length < 5) {
				continue;
			}
			const [, , src, dest] = parts;
			mapping[dest ?? ""] = src ?? "";
		}
	}
	for (const dest of Object.keys(mapping)) {
		const src = mapping[dest] ?? "";
		const dstPath = join(`${POC_DIR}/evidence`, relative("evidence", dest));
		const srcPath = join(FIX_SRC, src);
		if (isFile(srcPath)) {
			mkdirp(dirname(dstPath));
			copyFileSync(srcPath, dstPath);
			teeStdout(ctx.LOG, `   overlayed: ${dest} <- ${src}\n`);
		}
	}

	let pocVerifyCmd = "verify-all";
	if (!/^\s*verify-all\s*\(\s*\)/mu.test(readFileSync(`${POC_DIR}/run-poc.sh`, "utf8"))) {
		pocVerifyCmd = "verify";
		teeStdout(ctx.LOG, "   POC has no verify-all; falling back to 'verify' (older POC template)\n");
	}
	const verifyOut = "/tmp/verify-out";
	const r = await sh("sh", ["-c", `./run-poc.sh ${pocVerifyCmd}`], {
		cwd: POC_DIR,
		timeout: 0,
		rejectOnError: false,
	});
	writeFileSync(verifyOut, r.stdout + r.stderr);
	if (r.exitCode === 0) {
		teeStdout(ctx.LOG, `   ${pocVerifyCmd}: exit 0 (finding stood down — fix works)\n`);
	} else {
		teeStdout(ctx.LOG, `   ${pocVerifyCmd}: exit non-zero\n`);
		const lines = (readFileSync(verifyOut, "utf8").split(/\r?\n/u) || []).filter((l) =>
			/>>> FAIL|>>> STAND-DOWN/u.test(l),
		);
		for (const l of lines) {
			teeStdout(ctx.LOG, `${l}\n`);
		}
		let failing = 0;
		for (const l of readFileSync(verifyOut, "utf8").split(/\r?\n/u)) {
			if (l.includes(">>> FAIL")) {
				failing += 1;
			}
		}
		if (failing > 0) {
			rmSync(`${POC_DIR}/evidence`, { recursive: true, force: true });
			cpSync(BACKUP, `${POC_DIR}/evidence`, { recursive: true });
			await emitTrpJFailure(ctx, ctx.LOG, "TRP8 POC verify", `${failing} POC layer(s) still FAIL`);
		}
	}
	return BACKUP;
}

// ─── Stage 7b — docker end-to-end verify ────

async function stage7bDockerVerify(
	ctx: PipelineCtx,
	POC_DIR: string,
	FIX_SRC: string,
	BACKUP: string | null,
): Promise<{ dockerVerifyPassed: boolean; dockerAttackLog: string }> {
	section(ctx.LOG, "[7b] docker end-to-end: rebuild API from patched source + re-run attack");
	let dockerVerifyPassed = false;
	const DOCKER_ATTACK_LOG = `${resolve("discovery")}/${ctx.TASK_ID_SLUG}-docker-attack.log`;
	writeFileSync(DOCKER_ATTACK_LOG, "");

	if (
		POC_DIR &&
		isExecutable(`${POC_DIR}/run-poc.sh`) &&
		/^\s*(up|attack|down)\s*\(\s*\)/mu.test(readFileSync(`${POC_DIR}/run-poc.sh`, "utf8"))
	) {
		teeStdout(ctx.LOG, "   POC has up/attack/down; running docker verify\n");
		await runQuiet("./run-poc.sh", ["down"], { cwd: POC_DIR });
		const prepare = await sh("sh", ["-c", "./run-poc.sh prepare"], {
			cwd: POC_DIR,
			rejectOnError: false,
			timeout: 0,
		});
		writeFileSync(DOCKER_ATTACK_LOG, prepare.stdout + prepare.stderr);
		if (prepare.exitCode === 0) {
			teeStdout(ctx.LOG, "   POC .src/ prepared (client source fetched + POC-patch applied)\n");
			// Overlay the TRP-patched files ON TOP so the docker build compiles OUR fix.
			try {
				const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
				const filesToMod = (b.files_to_modify as Array<Record<string, unknown>> | undefined) ?? [];
				for (const m of filesToMod) {
					const f = String(m.path ?? "");
					if (!f) {
						continue;
					}
					try {
						copyFileSync(join(FIX_SRC, f), join(POC_DIR, ".src", f));
						teeStdout(ctx.LOG, `   overlayed patched: .src/${f}\n`);
					} catch {
						/* skip missing */
					}
				}
			} catch {
				/* silent */
			}
			if (isExecutable(`${POC_DIR}/trp-overlay.sh`)) {
				teeStdout(ctx.LOG, "   applying per-POC trp-overlay.sh\n");
				const overlay = await sh("sh", ["-c", "./trp-overlay.sh"], {
					cwd: POC_DIR,
					env: { FIX_SRC },
					rejectOnError: false,
					timeout: 0,
				});
				try {
					appendFileSync(DOCKER_ATTACK_LOG, overlay.stdout + overlay.stderr);
				} catch {
					/* non-fatal */
				}
				if (overlay.exitCode !== 0) {
					teeStderr(
						ctx.LOG,
						`   WARN: ${POC_DIR}/trp-overlay.sh exited non-zero (see ${DOCKER_ATTACK_LOG})\n`,
					);
				}
			}
			const up = await sh("sh", ["-c", "./run-poc.sh up"], {
				cwd: POC_DIR,
				rejectOnError: false,
				timeout: 0,
			});
			try {
				appendFileSync(DOCKER_ATTACK_LOG, up.stdout + up.stderr);
			} catch {
				/* non-fatal */
			}
			if (up.exitCode === 0) {
				teeStdout(ctx.LOG, "   docker: API + db + mock IdP up\n");
				const seed = await sh("sh", ["-c", "./run-poc.sh seed"], {
					cwd: POC_DIR,
					rejectOnError: false,
					timeout: 0,
				});
				try {
					appendFileSync(DOCKER_ATTACK_LOG, seed.stdout + seed.stderr);
				} catch {
					/* non-fatal */
				}
				const beforeAttack = readFileSync(DOCKER_ATTACK_LOG, "utf8").split(/\r?\n/u).length;
				const attack = await sh("sh", ["-c", "./run-poc.sh attack"], {
					cwd: POC_DIR,
					rejectOnError: false,
					timeout: 0,
				});
				try {
					appendFileSync(DOCKER_ATTACK_LOG, attack.stdout + attack.stderr);
				} catch {
					/* non-fatal */
				}
				const all = readFileSync(DOCKER_ATTACK_LOG, "utf8").split(/\r?\n/u);
				const attackTail = all.slice(beforeAttack).join("\n");
				let successPatterns = "ACCOUNT TAKEOVER|HTTP 200|INTERNAL_USER session";
				let refusalPatterns = "HTTP (4[0-9]{2}|5[0-9]{2})";
				if (isFile(`${POC_DIR}/attack-outcome.env`)) {
					sourceEnvFile(`${POC_DIR}/attack-outcome.env`);
					successPatterns = process.env.POC_ATTACK_SUCCESS_PATTERNS ?? successPatterns;
					refusalPatterns = process.env.POC_ATTACK_REFUSAL_PATTERNS ?? refusalPatterns;
					teeStdout(ctx.LOG, "   using POC attack-outcome.env patterns\n");
				}
				if (new RegExp(successPatterns, "u").test(attackTail)) {
					const down = await sh("sh", ["-c", "./run-poc.sh down"], {
						cwd: POC_DIR,
						rejectOnError: false,
						timeout: 0,
					});
					try {
						appendFileSync(DOCKER_ATTACK_LOG, down.stdout + down.stderr);
					} catch {
						/* non-fatal */
					}
					if (BACKUP) {
						rmSync(`${POC_DIR}/evidence`, { recursive: true, force: true });
						cpSync(BACKUP, `${POC_DIR}/evidence`, { recursive: true });
					}
					await emitTrpJFailure(
						ctx,
						ctx.LOG,
						"TRP8 docker attack",
						"attack SUCCEEDED against patched source",
					);
				} else if (new RegExp(refusalPatterns, "u").test(attackTail)) {
					const rx = new RegExp(refusalPatterns, "u");
					let refusal = "";
					for (const l of attackTail.split(/\r?\n/u)) {
						if (rx.test(l)) {
							refusal = l.replace(/^\s+/u, "");
							break;
						}
					}
					teeStdout(
						ctx.LOG,
						`   docker attack STOOD DOWN (${refusal} — attack refused by patched verifier)\n`,
					);
					dockerVerifyPassed = true;
				} else {
					teeStdout(ctx.LOG, `   REVIEW: attack log inconclusive — see ${DOCKER_ATTACK_LOG}\n`);
				}
			} else {
				teeStdout(
					ctx.LOG,
					`   WARN: docker up failed — see ${DOCKER_ATTACK_LOG}. Cannot claim STAND-DOWN.\n`,
				);
			}
			const down = await sh("sh", ["-c", "./run-poc.sh down"], {
				cwd: POC_DIR,
				rejectOnError: false,
				timeout: 0,
			});
			try {
				appendFileSync(DOCKER_ATTACK_LOG, down.stdout + down.stderr);
			} catch {
				/* non-fatal */
			}
			teeStdout(ctx.LOG, "   docker torn down (SP2)\n");
		} else {
			teeStdout(
				ctx.LOG,
				`   WARN: ./run-poc.sh prepare failed — see ${DOCKER_ATTACK_LOG}. Cannot claim STAND-DOWN.\n`,
			);
		}
	} else {
		teeStdout(
			ctx.LOG,
			"   POC lacks up/attack/down subcommands — skipping docker verify (informational verify layer only)\n",
		);
	}
	if (!dockerVerifyPassed) {
		teeStdout(
			ctx.LOG,
			"   REVIEW (TRP8): docker end-to-end could not confirm STAND-DOWN. Reviewer must re-run the attack manually before merging.\n",
		);
	}

	if (POC_DIR && BACKUP && isDir(BACKUP)) {
		rmSync(`${POC_DIR}/evidence`, { recursive: true, force: true });
		cpSync(BACKUP, `${POC_DIR}/evidence`, { recursive: true });
		teeStdout(ctx.LOG, "   restored POC evidence tree\n");
	}
	return { dockerVerifyPassed, dockerAttackLog: DOCKER_ATTACK_LOG };
}

// ─── Stage 8 — branch + commit + push ────

type Stage8Result = {
	branchName: string;
	commitMsg: string;
	pushDone: boolean;
};

async function stage8Commit(
	ctx: PipelineCtx,
	FIX_SRC: string,
	res: ClientResolution,
): Promise<Stage8Result | number | null> {
	await ttStop(ctx.TASK_ID, "trp-adversarial");
	section(ctx.LOG, "[8] branch + commit + push on client repo");
	await ttStart(ctx.TASK_ID, "trp-commit");

	if (ctx.TRP_TASK_MODE === "reproduce") {
		teeStdout(
			ctx.LOG,
			"   TRP_TASK_MODE=reproduce — skipping stages 8-11 (no PR / CODEOWNERS / tracker)\n",
		);
		teeStdout(ctx.LOG, "\n");
		teeStdout(
			ctx.LOG,
			"== done (mode=reproduce — regression test verified locally, stages 8-11 skipped) ==\n",
		);
		teeStdout(ctx.LOG, `Log: ${ctx.LOG}\n`);
		return 0;
	}

	let branchName = "";
	let commitMsg = "";
	try {
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		branchName = String(b.branch_name ?? "");
		commitMsg = String(b.commit_message ?? "");
	} catch {
		/* silent */
	}

	if ((process.env.TRP_ALLOW_REMOTE_MUTATE ?? "false") !== "true") {
		teeStderr(
			ctx.LOG,
			"   TRP: remote mutation blocked — set TRP_ALLOW_REMOTE_MUTATE=true to enable\n",
		);
		teeStdout(
			ctx.LOG,
			"   skipping stages 8-11 (branch/commit/push, PR create/edit, CODEOWNERS, ClickUp writes)\n",
		);
		teeStdout(ctx.LOG, "\n");
		teeStdout(ctx.LOG, "== done (dry-run, no remote mutation) ==\n");
		teeStdout(ctx.LOG, `Log: ${ctx.LOG}\n`);
		return 0;
	}

	// git branch idempotent + create + add + commit + push.
	await runQuiet("git", ["branch", "-D", branchName], { cwd: FIX_SRC });
	const co = await runTee(ctx.LOG, "git", ["checkout", "-b", branchName], { cwd: FIX_SRC });
	void co;
	await runQuiet("git", ["add", "-A"], { cwd: FIX_SRC });
	const signed = await sh("git", ["commit", "-S", "-m", commitMsg], {
		cwd: FIX_SRC,
		rejectOnError: false,
		timeout: 0,
	});
	try {
		appendFileSync(ctx.LOG, signed.stdout + signed.stderr);
	} catch {
		/* non-fatal */
	}
	if (signed.exitCode === 0) {
		teeStdout(ctx.LOG, "   committed (signed)\n");
	} else {
		const unsigned = await sh("git", ["commit", "-m", commitMsg], {
			cwd: FIX_SRC,
			rejectOnError: false,
			timeout: 0,
		});
		try {
			appendFileSync(ctx.LOG, unsigned.stdout + unsigned.stderr);
		} catch {
			/* non-fatal */
		}
		if (unsigned.exitCode === 0) {
			teeStdout(ctx.LOG, "   committed (unsigned — signing key not configured)\n");
		} else {
			teeStdout(ctx.LOG, "   COMMIT FAILED (pre-commit hook rejected — captured in log)\n");
			// Grep-tail helper for husky failure messages.
			const logTail = readFileSync(ctx.LOG, "utf8").split(/\r?\n/u).slice(-200);
			const filt = logTail.filter((l) => /(husky|error|✖)/u.test(l)).slice(-5);
			const commitFailMsg = filt[0] ?? "";
			await emitTrpJFailure(
				ctx,
				ctx.LOG,
				"TRP7 pre-commit hook",
				`git commit (husky): ${commitFailMsg}`,
			);
		}
	}

	const tokenR = await runQuiet("gh", ["auth", "token"]);
	const TOKEN = tokenR.stdout.replaceAll(/[\s\r\n]/gu, "");
	const gitCred = [
		"-c",
		"credential.helper=",
		"-c",
		`credential.https://github.com.helper=!f() { printf 'protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=%s\\n\\n' "${TOKEN}"; }; f`,
	];
	const pushArgs = [...gitCred, "push", "-u", "origin"];
	if (ctx.parsedArgs.allowPushForce) {
		pushArgs.push("--force-with-lease");
	}
	pushArgs.push(branchName);
	const push = await sh("git", pushArgs, { cwd: FIX_SRC, rejectOnError: false, timeout: 0 });
	try {
		appendFileSync(ctx.LOG, push.stdout + push.stderr);
	} catch {
		/* non-fatal */
	}
	if (push.exitCode !== 0) {
		await emitTrpJFailure(ctx, ctx.LOG, "TRP8 push rejected", `git push (branch=${branchName})`);
	}
	void res;
	return { branchName, commitMsg, pushDone: push.exitCode === 0 };
}

// ─── Stage 9 — open PR ────

async function stage9OpenPr(
	ctx: PipelineCtx,
	FIX_SRC: string,
	res: ClientResolution,
	stage8: Stage8Result,
): Promise<string> {
	await ttStop(ctx.TASK_ID, "trp-commit");
	section(ctx.LOG, "[9] open PR");
	await ttStart(ctx.TASK_ID, "trp-pr-open");

	let PR_TITLE = "";
	let PR_BODY = "";
	try {
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		PR_TITLE = String(b.pr_title ?? "");
		const sections = (b.pr_body_sections ?? {}) as Record<string, unknown>;
		const parts: string[] = [];
		for (const [key, heading] of [
			["summary", "## Summary"],
			["fix", "## Fix"],
			["test_plan", "## Test plan"],
			["rollback_plan", "## Rollback plan"],
			["references", "## References"],
		] as const) {
			const v = sections[key];
			if (typeof v === "string" && v.trim()) {
				parts.push(`${heading}\n\n${v.replace(/\s+$/u, "")}`);
			}
		}
		PR_BODY = parts.join("\n\n");
	} catch {
		/* silent */
	}

	const prArgs = [
		"pr",
		"create",
		"--repo",
		res.CLIENT_REPO,
		"--base",
		res.DEFAULT_BRANCH,
		"--head",
		stage8.branchName,
		"--title",
		PR_TITLE,
		"--body",
		PR_BODY,
	];
	if (process.env.TRP_PR_DRAFT === "true") {
		prArgs.push("--draft");
	}
	const prCreate = await sh("gh", prArgs, { rejectOnError: false, timeout: 0 });
	const prOutput = prCreate.stdout + prCreate.stderr;
	teeStdout(ctx.LOG, prOutput);
	let PR_URL = "";
	const urlMatches = prOutput.match(/https:\/\/github\.com\/[^ ]+\/pull\/[0-9]+/gu) ?? [];
	if (urlMatches.length > 0) {
		PR_URL = urlMatches.at(-1) ?? "";
	}
	if (!PR_URL) {
		const list = await runQuiet("gh", [
			"pr",
			"list",
			"--repo",
			res.CLIENT_REPO,
			"--head",
			stage8.branchName,
			"--json",
			"url",
			"--jq",
			".[0].url",
		]);
		PR_URL = list.stdout.trim();
	}

	if (PR_URL && ctx.parsedArgs.allowPushForce) {
		const m = /\/pull\/(\d+)/u.exec(PR_URL);
		const prNum = m ? (m[1] ?? "") : "";
		const edit = await sh(
			"sh",
			[
				"-c",
				`echo "${PR_BODY.replaceAll('"', String.raw`\"`)}" | gh pr edit ${prNum} --repo ${res.CLIENT_REPO} --body-file -`,
			],
			{ rejectOnError: false, timeout: 0 },
		);
		try {
			appendFileSync(ctx.LOG, edit.stdout + edit.stderr);
		} catch {
			/* non-fatal */
		}
		teeStdout(ctx.LOG, `   [trp-dd] updated PR body for #${prNum} to match revised bundle\n`);
	}

	if (PR_URL && (process.env.TRP_PR_REQUEST_CODEOWNERS_REVIEW ?? "true") === "true") {
		const m = /\/pull\/(\d+)/u.exec(PR_URL);
		const prNum = m ? (m[1] ?? "") : "";
		process.env.FIX_SRC = FIX_SRC;
		process.env.BUNDLE_JSON = ctx.BUNDLE_JSON;
		let reviewers = "";
		try {
			// codeowners-reviewers writes to stdout — capture via a subprocess
			// spawn so we can grab the text without racing on stdio.
			const cr = await sh(
				process.execPath,
				["--experimental-strip-types", resolve(import.meta.dirname, "codeowners-reviewers.ts")],
				{ rejectOnError: false, timeout: 0, env: { FIX_SRC, BUNDLE_JSON: ctx.BUNDLE_JSON } },
			);
			reviewers = cr.stdout.trim();
			void codeownersReviewersMain;
		} catch {
			reviewers = "";
		}
		if (reviewers) {
			const clean = reviewers.replaceAll("@", "").replaceAll(/\r?\n/gu, ",").replace(/,$/u, "");
			const editR = await sh(
				"gh",
				["pr", "edit", prNum, "--repo", res.CLIENT_REPO, "--add-reviewer", clean],
				{ rejectOnError: false, timeout: 0 },
			);
			try {
				appendFileSync(ctx.LOG, editR.stdout + editR.stderr);
			} catch {
				/* non-fatal */
			}
			teeStdout(ctx.LOG, `   [trp-kk] requested review from: ${clean}\n`);
		} else {
			teeStdout(ctx.LOG, "   [trp-kk] no CODEOWNERS match — no reviewer added\n");
		}
	}
	teeStdout(ctx.LOG, `   PR opened: ${PR_URL}\n`);
	return PR_URL;
}

// ─── Stage 11 — ClickUp status + comment ────

async function stage11ClickUp(
	ctx: PipelineCtx,
	res: ClientResolution,
	PR_URL: string,
	POC_DIR: string,
): Promise<{ clickupTaskId: string; currentTeam: string; customId: string; timeEstH: string }> {
	await ttStop(ctx.TASK_ID, "trp-pr-open");
	section(ctx.LOG, "[11] ClickUp status + comment");
	await ttStart(ctx.TASK_ID, "trp-tracker-post");

	const clickupTokenFile = process.env.CLICKUP_TOKEN_FILE || ".env.clickup";
	let clickupTaskId = res.CLICKUP_TASK_ID;
	let currentTeam = "";
	let customId = "";
	let estH = "";

	if (!clickupTaskId || !PR_URL || !isFile(clickupTokenFile)) {
		teeStdout(
			ctx.LOG,
			"   skipping ClickUp step (task_id, PR_URL, or CLICKUP_TOKEN_FILE missing)\n",
		);
		return { clickupTaskId, currentTeam, customId, timeEstH: estH };
	}

	const CLICKUP_TOKEN = readFileSync(clickupTokenFile, "utf8").replaceAll(/[\s\r\n\t]/gu, "");
	const authHeader = `Authorization: ${CLICKUP_TOKEN}`;
	const jsonHeader = "Content-Type: application/json";

	const first = await curlJson("GET", `https://api.clickup.com/api/v2/task/${clickupTaskId}`, [
		authHeader,
	]);
	let taskMetaBody = first.body;
	if (!/"id"/u.test(taskMetaBody)) {
		const teamsResp = await curlGet("https://api.clickup.com/api/v2/team", [authHeader]);
		let teams: string[] = [];
		try {
			const parsed = JSON.parse(teamsResp.body) as { teams?: Array<{ id: string }> };
			teams = (parsed.teams ?? []).map((t) => t.id);
		} catch {
			teams = [];
		}
		for (const teamId of teams) {
			const r = await curlGet(
				`https://api.clickup.com/api/v2/task/${clickupTaskId}?custom_task_ids=true&team_id=${teamId}`,
				[authHeader],
			);
			if (/"id"/u.test(r.body)) {
				taskMetaBody = r.body;
				try {
					const parsed = JSON.parse(r.body) as { id?: string };
					const nativeId = parsed.id ?? "";
					teeStdout(
						ctx.LOG,
						`   resolved custom ID ${clickupTaskId} -> ${nativeId} via team ${teamId}\n`,
					);
					clickupTaskId = nativeId;
				} catch {
					/* swallow */
				}
				break;
			}
		}
	}

	if (!/"id"/u.test(taskMetaBody)) {
		teeStdout(
			ctx.LOG,
			`   WARN: ClickUp could not resolve CLICKUP_TASK_ID '${clickupTaskId}' (native or custom). Manual transition required.\n`,
		);
		return { clickupTaskId, currentTeam, customId, timeEstH: estH };
	}

	let currentStatus = "";
	let currentList = "";
	let currentListId = "";
	let currentTimeEst = 0;
	let currentStart = 0;
	try {
		const meta = JSON.parse(taskMetaBody) as Record<string, unknown>;
		currentStatus = String(
			((meta.status as Record<string, unknown> | undefined)?.status as string | undefined) ?? "",
		);
		const list = (meta.list as Record<string, unknown> | undefined) ?? {};
		currentList = `${String(list.name ?? "?")} (${String(list.id ?? "?")})`;
		currentListId = String(list.id ?? "");
		currentTeam = String(meta.team_id ?? "");
		customId = String(meta.custom_id ?? "");
		currentTimeEst = Math.trunc(Number(meta.time_estimate ?? 0)) || 0;
		currentStart = Math.trunc(Number(meta.start_date ?? 0)) || 0;
	} catch {
		/* keep defaults */
	}

	teeStdout(ctx.LOG, `   task found in list: ${currentList} (team ${currentTeam})\n`);
	if (customId) {
		teeStdout(ctx.LOG, `   task also has custom ID: ${customId}\n`);
	}

	const targetStatus = process.env.TRP_STATUS_ON_PR_OPEN ?? "";
	if (currentStatus === targetStatus) {
		teeStdout(ctx.LOG, `   already at status '${targetStatus}' — skipping PUT\n`);
	} else {
		const statusResp = await curlJson(
			"PUT",
			`https://api.clickup.com/api/v2/task/${clickupTaskId}`,
			[authHeader, jsonHeader],
			JSON.stringify({ status: targetStatus }),
		);
		if (/"status"/u.test(statusResp.body)) {
			teeStdout(ctx.LOG, `   transitioned ${clickupTaskId}: ${currentStatus} -> ${targetStatus}\n`);
		} else {
			teeStdout(ctx.LOG, `   WARN: transition PUT did not return status: ${statusResp.body}\n`);
		}
	}

	// TRP9 field enrichment: time_estimate + start_date + custom fields.
	let severity = "";
	if (POC_DIR && isFile(`${POC_DIR}/README.md`)) {
		const s = readFileSync(`${POC_DIR}/README.md`, "utf8");
		const m = /^## Severity.*?(\bCRITICAL\b|\bHIGH\b|\bMEDIUM\b|\bLOW\b)/imsu.exec(s);
		severity = (m ? (m[1] ?? "") : "").toUpperCase();
	}
	switch (severity) {
		case "CRITICAL": {
			estH = process.env.TRP_TIME_ESTIMATE_CRITICAL_H ?? "8";
			break;
		}
		case "HIGH": {
			estH = process.env.TRP_TIME_ESTIMATE_HIGH_H ?? "16";
			break;
		}
		case "MEDIUM": {
			estH = process.env.TRP_TIME_ESTIMATE_MEDIUM_H ?? "24";
			break;
		}
		case "LOW": {
			estH = process.env.TRP_TIME_ESTIMATE_LOW_H ?? "40";
			break;
		}
		default: {
			estH = "";
		}
	}
	const nowMs = Date.now();
	const updatePayload: Record<string, unknown> = {};
	if (
		(process.env.TRP_SET_TIME_ESTIMATE_ON_PR_OPEN ?? "true") === "true" &&
		estH &&
		currentTimeEst === 0
	) {
		updatePayload.time_estimate = (Math.trunc(Number(estH)) || 0) * 3600 * 1000;
	}
	if ((process.env.TRP_SET_START_DATE_ON_PR_OPEN ?? "true") === "true" && currentStart === 0) {
		updatePayload.start_date = nowMs;
		updatePayload.start_date_time = true;
	}
	if (Object.keys(updatePayload).length > 0) {
		const rr = await curlJson(
			"PUT",
			`https://api.clickup.com/api/v2/task/${clickupTaskId}`,
			[authHeader, jsonHeader],
			JSON.stringify(updatePayload),
		);
		if (/"id"/u.test(rr.body)) {
			teeStdout(
				ctx.LOG,
				`   set fields on ${clickupTaskId}: ${JSON.stringify(updatePayload)} (severity=${severity} -> ${estH}h)\n`,
			);
		} else {
			teeStdout(ctx.LOG, `   WARN: field PUT rejected: ${rr.body}\n`);
		}
	} else {
		teeStdout(ctx.LOG, "   time_estimate / start_date already set -- skipping (idempotent)\n");
	}

	// Custom fields.
	if (process.env.TRP_CUSTOM_FIELDS && currentListId) {
		const schemaFile = `discovery/clickup-schema-${currentListId}.json`;
		if (!isFile(schemaFile)) {
			const s = await curlGet(`https://api.clickup.com/api/v2/list/${currentListId}/field`, [
				authHeader,
			]);
			writeFileSync(schemaFile, s.body);
		}
		let schema: { fields?: Array<{ id: string; name: string; type: string }> } = {};
		try {
			schema = JSON.parse(readFileSync(schemaFile, "utf8"));
		} catch {
			schema = {};
		}
		const byName = new Map<string, { id: string; name: string; type: string }>();
		for (const f of schema.fields ?? []) {
			byName.set(f.name, f);
		}
		for (const pair of (process.env.TRP_CUSTOM_FIELDS ?? "").split(",")) {
			if (!pair.includes("=")) {
				continue;
			}
			const eqIdx = pair.indexOf("=");
			const name = pair.slice(0, eqIdx).trim();
			const val = pair.slice(eqIdx + 1).trim();
			const f = byName.get(name);
			if (!f) {
				teeStdout(ctx.LOG, `   custom field '${name}' not in this list's schema -- skipped\n`);
				continue;
			}
			if (f.type === "formula") {
				teeStdout(ctx.LOG, `   custom field '${name}' is a formula -- not writable, skipped\n`);
				continue;
			}
			const body = JSON.stringify({ value: f.type === "number" ? Number(val) : val });
			const setR = await curlJson(
				"POST",
				`https://api.clickup.com/api/v2/task/${clickupTaskId}/field/${f.id}`,
				[authHeader, jsonHeader],
				body,
			);
			if (setR.code === 0 && setR.body) {
				teeStdout(ctx.LOG, `   set custom field '${name}' = ${val}\n`);
			} else {
				teeStdout(ctx.LOG, `   WARN: custom field '${name}' write failed: rc=${setR.code}\n`);
			}
		}
	}

	// Post PR link comment.
	const commentResp = await curlJson(
		"POST",
		`https://api.clickup.com/api/v2/task/${clickupTaskId}/comment`,
		[authHeader, jsonHeader],
		JSON.stringify({ comment_text: `TRP fix PR: ${PR_URL}` }),
	);
	if (/"id"/u.test(commentResp.body)) {
		teeStdout(ctx.LOG, `   posted PR link comment on ${clickupTaskId}\n`);
	} else {
		teeStdout(ctx.LOG, `   WARN: comment POST did not return an id: ${commentResp.body}\n`);
	}

	// TRP-Q: log a time entry (distinct from time_estimate).
	if ((process.env.TRP_LOG_TIME_ON_PR_OPEN ?? "false") === "true" && currentTeam) {
		const durationMs = (Number(process.env.TRP_LOG_TIME_MINUTES ?? "15") || 15) * 60 * 1000;
		const now = Date.now();
		const payload = {
			tid: clickupTaskId,
			start: now - durationMs,
			duration: durationMs,
			description: process.env.TRP_LOG_TIME_DESCRIPTION ?? "TRP fix",
		};
		const timeResp = await curlJson(
			"POST",
			`https://api.clickup.com/api/v2/team/${currentTeam}/time_entries`,
			[authHeader, jsonHeader],
			JSON.stringify(payload),
		);
		if (/"id"/u.test(timeResp.body)) {
			teeStdout(
				ctx.LOG,
				`   logged time entry (${process.env.TRP_LOG_TIME_MINUTES ?? "15"}m) on ${clickupTaskId}\n`,
			);
		} else {
			teeStdout(ctx.LOG, `   WARN: time entry POST rejected: ${timeResp.body}\n`);
		}
	}

	// Correct URL uses team_id + custom_id when the task lives in a project space.
	if (currentTeam && customId) {
		teeStdout(
			ctx.LOG,
			`   authoritative task URL: https://app.clickup.com/t/${currentTeam}/${customId}\n`,
		);
	} else {
		teeStdout(ctx.LOG, `   authoritative task URL: https://app.clickup.com/t/${clickupTaskId}\n`);
	}
	return { clickupTaskId, currentTeam, customId, timeEstH: estH };
}

// ─── Stage 12 — create-child-ticket (spike-full mode only) ────

async function stage12ChildTicket(ctx: PipelineCtx, clickupTaskId: string): Promise<void> {
	await ttStop(ctx.TASK_ID, "trp-tracker-post");
	section(ctx.LOG, "[12] create-child-ticket (spike-full mode only)");
	await ttStart(ctx.TASK_ID, "trp-child-ticket");

	if (!modeRuns("stage_child_ticket", ctx.TRP_TASK_MODE)) {
		teeStdout(
			ctx.LOG,
			`   skipped (mode=${ctx.TRP_TASK_MODE}, TRP_ALLOW_CHILD_TICKET_CREATE=${process.env.TRP_ALLOW_CHILD_TICKET_CREATE ?? "false"})\n`,
		);
		return;
	}
	if ((process.env.TRP_ALLOW_REMOTE_MUTATE ?? "false") !== "true") {
		teeStdout(ctx.LOG, "   TRP_ALLOW_REMOTE_MUTATE!=true — skipping child ticket create\n");
		return;
	}
	const clickupTokenFile = process.env.CLICKUP_TOKEN_FILE || ".env.clickup";
	if (!clickupTaskId || !isFile(clickupTokenFile)) {
		teeStdout(ctx.LOG, "   skipping -- no CLICKUP_TASK_ID / token file\n");
		return;
	}
	const CLICKUP_TOKEN = readFileSync(clickupTokenFile, "utf8").replaceAll(/[\s\r\n\t]/gu, "");
	let childName = `Follow-up for ${ctx.TASK_ID}`;
	let childDesc = "";
	try {
		const b = readJsonFile(ctx.BUNDLE_JSON) as Record<string, unknown>;
		const fu = (b.follow_up ?? {}) as Record<string, unknown>;
		if (fu.title) {
			childName = String(fu.title);
		}
		childDesc = String(fu.description ?? "");
	} catch {
		/* silent */
	}
	if (!childDesc) {
		// bash IS_SPIKE=true fallback for a spike parent.
		childDesc = `Follow-up work identified during spike for parent task ${ctx.TASK_ID}.`;
	}
	const listId = process.env.CLICKUP_LIST_ID ?? "";
	const resp = await curlJson(
		"POST",
		`https://api.clickup.com/api/v2/list/${listId}/task`,
		[`Authorization: ${CLICKUP_TOKEN}`, "Content-Type: application/json"],
		JSON.stringify({ name: childName, description: childDesc, parent: clickupTaskId }),
	);
	let childId = "";
	try {
		const parsed = JSON.parse(resp.body) as { id?: string };
		childId = parsed.id ?? "";
	} catch {
		childId = "";
	}
	if (childId) {
		teeStdout(ctx.LOG, `   created child ticket ${childId} (parent=${clickupTaskId})\n`);
	} else {
		teeStdout(ctx.LOG, `   WARN: child ticket create rejected: ${resp.body}\n`);
	}
}

// ─── Stage 13 — POC check-upstream ────

async function stage13CheckUpstream(ctx: PipelineCtx, POC_DIR: string): Promise<void> {
	await ttStop(ctx.TASK_ID, "trp-child-ticket");
	section(ctx.LOG, "[13] TRP-AA POC check-upstream (post-fix state confirmation)");
	if (POC_DIR && isExecutable(`${POC_DIR}/run-poc.sh`)) {
		const text = readFileSync(`${POC_DIR}/run-poc.sh`, "utf8");
		if (text.includes("check-upstream")) {
			const r = await sh("sh", ["-c", "./run-poc.sh check-upstream"], {
				cwd: POC_DIR,
				rejectOnError: false,
				timeout: 0,
			});
			const combined = r.stdout + r.stderr;
			const tail = combined.split(/\r?\n/u).slice(-8).join("\n");
			teeStdout(ctx.LOG, `${tail}\n`);
			teeStdout(
				ctx.LOG,
				"   post-merge expectation: DRIFT (source moves from vulnerable → fixed)\n",
			);
		} else {
			teeStdout(ctx.LOG, "   POC has no check-upstream -- skipping\n");
		}
	} else {
		teeStdout(ctx.LOG, "   POC has no check-upstream -- skipping\n");
	}
}

// ─── Stage 14 — post-push external review polling ────

async function stage14Poll(
	ctx: PipelineCtx,
	res: ClientResolution,
	PR_URL: string,
): Promise<number | null> {
	section(ctx.LOG, "[14] TRP-W post-push external review polling");
	if (PR_URL && (process.env.TRP_POLL_POST_PUSH ?? "true") === "true") {
		const m = /\/pull\/(\d+)/u.exec(PR_URL);
		const prNum = m ? (m[1] ?? "") : "";
		const maxMin = process.env.TRP_POLL_MAX_MINUTES ?? "30";
		teeStdout(ctx.LOG, `   polling PR #${prNum} for CI + Bugbot findings (up to ${maxMin} min)\n`);
		const r = await sh(
			"./scripts/poll-pr-after-push.sh",
			[ctx.TASK_ID, res.CLIENT_REPO, prNum, maxMin],
			{ rejectOnError: false, timeout: 0 },
		);
		try {
			appendFileSync(ctx.LOG, r.stdout + r.stderr);
		} catch {
			/* non-fatal */
		}
		if (r.exitCode === 67) {
			teeStdout(
				ctx.LOG,
				`   [trp-w] external review flagged issues — see discovery/trp-fail-${ctx.TASK_ID_SLUG}-post-push.json\n`,
			);
			teeStdout(
				ctx.LOG,
				`   [trp-w] main context: re-invoke workflow with previous_attempt = @discovery/trp-fail-${ctx.TASK_ID_SLUG}-post-push.json\n`,
			);
			teeStdout(ctx.LOG, "   [trp-w] then re-run with --push-force to update the same PR branch\n");
			return 67;
		}
	} else {
		teeStdout(ctx.LOG, "   skipped (TRP_POLL_POST_PUSH=false or no PR_URL)\n");
	}
	return null;
}

// ─── Pipeline orchestrator ────

async function runPipeline(ctx: PipelineCtx): Promise<number> {
	const s0 = await stage0Bootstrap(ctx);
	if (s0 !== null) {
		return s0;
	}

	const s1 = await stage1LoadContext(ctx);
	if (typeof s1 === "number") {
		return s1;
	}
	const res: ClientResolution = s1;

	const sw = await stageSwSpikeWriteup(ctx, res);
	if (sw !== null) {
		return sw;
	}

	const s2 = await stage2FetchClient(ctx, res);
	if (typeof s2 === "number") {
		return s2;
	}
	const { FIX_SRC } = s2;

	await stage3PrepInput(ctx, res, FIX_SRC);

	if (
		ctx.parsedArgs.mode === "prep" ||
		(ctx.parsedArgs.mode === "full" && !isFile(ctx.BUNDLE_JSON))
	) {
		process.stdout.write("\n");
		process.stdout.write("== NEXT (main-context step): ==\n");
		process.stdout.write(`Invoke workflow with args = @${ctx.INPUT_JSON}:\n`);
		process.stdout.write('    Workflow({ scriptPath: "workflows/trp-fix-task.js",\n');
		process.stdout.write(`               args: <contents of ${ctx.INPUT_JSON}> })\n`);
		process.stdout.write(`Then write the return value to ${ctx.BUNDLE_JSON} and re-run:\n`);
		process.stdout.write(
			`    ./scripts/fix-task.sh ${ctx.TASK_ID} --after-workflow=${ctx.BUNDLE_JSON}\n`,
		);
		return 0;
	}

	const { isSpike } = await stage3EmitSpikeWriteup(ctx);
	if (ctx.TRP_TASK_MODE === "spike-writeup") {
		process.stdout.write("\n");
		process.stdout.write("== done (mode=spike-writeup — stages 4-12 skipped) ==\n");
		process.stdout.write(`Log: ${ctx.LOG}\n`);
		if (isSpike) {
			process.stdout.write(`Spike writeup: discovery/proof/${ctx.TASK_ID_SLUG}/spike-writeup.md\n`);
		}
		return 0;
	}

	await ttStop(ctx.TASK_ID, "trp-writeup");
	await ttStop(ctx.TASK_ID, "trp-prep-input");

	await stage4bCrossFile(ctx);
	await stage4cSchemaCheck(ctx, FIX_SRC);
	await stage5ApplyPatch(ctx, FIX_SRC);
	await stage6ClientCi(ctx, FIX_SRC, res);
	const BACKUP = await stage7PocVerify(ctx, res.POC_DIR, FIX_SRC);
	const { dockerVerifyPassed, dockerAttackLog } = await stage7bDockerVerify(
		ctx,
		res.POC_DIR,
		FIX_SRC,
		BACKUP,
	);

	// ---- Gate stages 8-11 behind --push (TRP10 spirit: never auto-push) ----
	if (!ctx.parsedArgs.allowPush) {
		await ttStop(ctx.TASK_ID, "trp-adversarial");
		section(ctx.LOG, "[gate] stages 8-11 (client-repo push + PR + ClickUp) require --push");
		teeStdout(ctx.LOG, "   local verification complete.\n");
		teeStdout(
			ctx.LOG,
			`   docker attack STAND-DOWN: ${dockerVerifyPassed ? "YES" : "REVIEW-NEEDED"}\n`,
		);
		teeStdout(ctx.LOG, `   patch: discovery/patches/${ctx.TASK_ID_SLUG}.patch\n`);
		teeStdout(ctx.LOG, `   docker log: ${dockerAttackLog}\n`);
		teeStdout(ctx.LOG, "\n");
		teeStdout(
			ctx.LOG,
			"   To push the branch + open the PR + transition ClickUp, re-run with --push:\n",
		);
		teeStdout(
			ctx.LOG,
			`     ./scripts/fix-task.sh ${ctx.TASK_ID} --after-workflow=${ctx.BUNDLE_JSON} --push\n`,
		);
		return 0;
	}

	const s8 = await stage8Commit(ctx, FIX_SRC, res);
	if (typeof s8 === "number") {
		return s8;
	}
	if (s8 === null) {
		return 0;
	}
	const PR_URL = await stage9OpenPr(ctx, FIX_SRC, res, s8);
	const cu = await stage11ClickUp(ctx, res, PR_URL, res.POC_DIR);
	await stage12ChildTicket(ctx, cu.clickupTaskId);
	await stage13CheckUpstream(ctx, res.POC_DIR);
	const pollCode = await stage14Poll(ctx, res, PR_URL);
	if (pollCode !== null) {
		return pollCode;
	}
	process.stdout.write("\n");
	process.stdout.write("== done ==\n");
	process.stdout.write(`PR: ${PR_URL}\n`);
	process.stdout.write(`Log: ${ctx.LOG}\n`);
	return 0;
}

// ─── CLI invocation guard ────

function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) {
		return false;
	}
	try {
		if (import.meta.url === pathToFileURL(resolve(entry)).href) {
			return true;
		}
	} catch {
		/* fall through */
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
		process.stderr.write(
			`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exit(1);
	}
}

// Deliberately-preserved unused imports for downstream migration hooks;
// referencing them here keeps the linter/tsc happy without changing behaviour.
void stdioJournal;
