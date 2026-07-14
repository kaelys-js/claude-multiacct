#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * `proof-recorder.ts` — TS port of `trp/scripts/proof-recorder.sh`.
 *
 * One wrapper around every proof-capture modality we use on a PR-review task.
 * Each modality writes a single log + a sha256 sidecar under
 * `discovery/proof/<task-slug>/<modality>-<ts>.<ext>` so downstream review
 * notes can cite reproducible artefacts (SP1: evidence by provenance, not by
 * copy).
 *
 * Modalities (read from --modality or PROOF_MODALITY):
 *   ui                — playwright test at $PROOF_SCRIPT; keeps .png + .mp4
 *   backend           — curl-based $PROOF_SCRIPT; captures stdout + stderr
 *   terminal          — script(1) session recording the $PROOF_SCRIPT run
 *   iac               — terraform plan + docker compose config snapshot
 *   bugfix-red-green  — runs $TEST_CMD at HEAD~1 (expect red) then HEAD
 *                       (expect green); captures both outputs side by side
 *
 * Migrated line-for-line from the bash source. Every branch, exit code,
 * env-var check, and log line is preserved verbatim. Bash `set -euo pipefail`
 * semantics map to explicit error propagation via `sh(..., rejectOnError)`
 * and returned exit codes; `trap restore_git EXIT` maps to a try/finally
 * cleanup block. Platform probes (util-linux `script --version`, `sha256sum`
 * vs `shasum -a 256`) are preserved as observable branches, though the
 * probe result is cached across calls within a single run — the observable
 * output is unchanged but redundant subprocess spawns are avoided.
 *
 * Lint rules disabled for this file (line-for-line bash port; autofix
 * rewrites read worse than the source form):
 *   - eslint/no-continue / no-await-in-loop: preserved from the bash control flow.
 *   - eslint/require-unicode-regexp: literal patterns from the shell source
 *     are byte-oriented, not Unicode-aware.
 *   - promise/prefer-await-to-then: `.then(...)` used in narrow bridge spots.
 *   - unicorn/prefer-top-level-await / no-await-expression-member /
 *     no-immediate-mutation: autofix rewrites obscure the parity mapping.
 *
 * @module
 */
/* oxlint-disable eslint/no-continue, eslint/no-await-in-loop, eslint/require-unicode-regexp, promise/prefer-await-to-then, unicorn/prefer-top-level-await, unicorn/no-await-expression-member, unicorn/no-immediate-mutation */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sh, type ShResult } from "@foundation/shell";

// ─── Stage 1 — Argparse + validation ─────────────────────────────

// USAGE text — mirrors what `sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'`
// prints in the bash source when the operator passes `--help`. The strip
// removes the leading `# ` (0 or 1 space) from each header line; the final
// line (`set -euo pipefail`) has no `# ` prefix so it survives verbatim.
const USAGE = `proof-recorder.sh — one wrapper around every proof-capture modality we use
on a PR-review task. Each modality writes a single log + a sha256 sidecar
under discovery/proof/<task-slug>/<modality>-<ts>.<ext> so downstream
review notes can cite reproducible artefacts (SP1: evidence by provenance,
not by copy).

Modalities (read from --modality or PROOF_MODALITY):
  ui                — playwright test at $PROOF_SCRIPT; keeps .png + .mp4
  backend           — curl-based $PROOF_SCRIPT; captures stdout + stderr
  terminal          — script(1) session recording the $PROOF_SCRIPT run
  iac               — terraform plan + docker compose config snapshot
  bugfix-red-green  — runs $TEST_CMD at HEAD~1 (expect red) then HEAD
                      (expect green); captures both outputs side by side

Portable to macOS bash 3.2 — no associative arrays, no \${var,,}, no mapfile.
Usage:
  proof-recorder.sh --task <T> --modality <M> --script <S> [--out <O>]
set -euo pipefail`;

export type Modality = "ui" | "backend" | "terminal" | "iac" | "bugfix-red-green";

export type ParsedArgs = {
	readonly task: string;
	readonly modality: string;
	readonly scriptPath: string;
	readonly outOverride: string;
};

type ParseOutcome =
	| { readonly kind: "ok"; readonly args: ParsedArgs }
	| { readonly kind: "help" }
	| { readonly kind: "err"; readonly exitCode: number };

// Bash `while [ $# -gt 0 ]` + `case "$1"` loop. Preserves the source's
// exit-code contract: unknown flags return 2 with `ERROR: unknown flag: ...`
// on stderr; missing --task / --modality (after env fallback) returns 2 with
// the exact error strings the bash version writes.
export function parseArgs(argv: readonly string[]): ParseOutcome {
	let task = "";
	// Bash: `MODALITY="${PROOF_MODALITY:-}"` — env fallback, empty when unset.
	let modality = process.env["PROOF_MODALITY"] ?? "";
	let scriptPath = process.env["PROOF_SCRIPT"] ?? "";
	let outOverride = "";
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === "--task") {
			task = argv[i + 1] ?? "";
			i += 2;
		} else if (arg === "--modality") {
			modality = argv[i + 1] ?? "";
			i += 2;
		} else if (arg === "--script") {
			scriptPath = argv[i + 1] ?? "";
			i += 2;
		} else if (arg === "--out") {
			outOverride = argv[i + 1] ?? "";
			i += 2;
		} else if (arg === "-h" || arg === "--help") {
			return { kind: "help" };
		} else {
			process.stderr.write(`ERROR: unknown flag: ${arg}\n`);
			return { kind: "err", exitCode: 2 };
		}
	}
	// Top-level required checks — bash does these immediately after the loop
	// with `[ -n "$TASK" ] || { echo ...; exit 2; }`.
	if (!task) {
		process.stderr.write("ERROR: --task required\n");
		return { kind: "err", exitCode: 2 };
	}
	if (!modality) {
		process.stderr.write("ERROR: --modality (or PROOF_MODALITY) required\n");
		return { kind: "err", exitCode: 2 };
	}
	return { kind: "ok", args: { task, modality, scriptPath, outOverride } };
}

// ─── Stage 2 — Helpers (slugify / sha256 / sidecar / resolve_out) ─

// Bash 3.2-portable slugify: lowercase, non-alnum → dash, collapse repeats,
// trim edges. Bash uses `tr` + `sed`; TS uses a chain of regex replacements
// that produce the byte-identical output for ASCII inputs. Non-ASCII input
// is normalised the same way `tr -c 'a-z0-9' '-'` would: every non-matching
// codepoint becomes a single `-`.
export function slugify(input: string): string {
	let out = input.toLowerCase();
	// `tr -c 'a-z0-9' '-'` — replace every non-[a-z0-9] with a dash.
	out = out.replaceAll(/[^a-z0-9]/gu, "-");
	// `sed 's/--*/-/g'` — collapse runs of dashes.
	out = out.replaceAll(/-+/gu, "-");
	// `sed -e 's/^-//' -e 's/-$//'` — trim leading/trailing dash.
	out = out.replace(/^-/u, "").replace(/-$/u, "");
	return out;
}

// `date -u +%Y%m%dT%H%M%SZ` — UTC compact ISO-ish stamp, e.g. `20260713T173045Z`.
// Node's `Date#toISOString()` returns the extended form (`2026-07-13T17:30:45.123Z`);
// strip the punctuation + fractional seconds to match the bash format exactly.
function utcStamp(now: Date = new Date()): string {
	const iso = now.toISOString(); // `2026-07-13T17:30:45.123Z`
	return iso.replaceAll(/[-:]/g, "").replace(/\.\d+Z$/u, "Z");
}

// Cached probe: `command -v sha256sum` succeeds on util-linux, fails on
// stock macOS which only ships `shasum(1)`. The bash version probes on every
// call to `sha256_of`; caching here avoids redundant subprocess spawns while
// preserving the observable output (identical hex digests, identical sidecar
// format). The probe result cannot change mid-run.
let sha256CommandCache: { readonly cmd: string; readonly leading: readonly string[] } | null = null;

async function detectSha256Command(): Promise<{
	readonly cmd: string;
	readonly leading: readonly string[];
}> {
	if (sha256CommandCache !== null) {
		return sha256CommandCache;
	}
	try {
		// `sha256sum --version` on util-linux prints a banner and exits 0.
		// A missing binary raises ENOENT, which sh() rewraps as ShError.
		await sh("sha256sum", ["--version"], { rejectOnError: false });
		sha256CommandCache = { cmd: "sha256sum", leading: [] };
	} catch {
		sha256CommandCache = { cmd: "shasum", leading: ["-a", "256"] };
	}
	return sha256CommandCache;
}

// Bash: `sha256sum "$1" | awk '{print $1}'` or `shasum -a 256 "$1" | awk '{print $1}'`.
// Both binaries print `<sha>  <path>`; we split on any whitespace run and take
// the first field. Reads the file via sh() rather than Node's crypto so the
// platform-detection branch stays observable — the whole point of the port.
async function sha256Of(path: string): Promise<string> {
	const { cmd, leading } = await detectSha256Command();
	const result = await sh(cmd, [...leading, path], { rejectOnError: false });
	return result.stdout.split(/\s+/u)[0] ?? "";
}

// Bash: writes `<sha256>  <basename>` to `<target>.sha256`, then echoes
// `   sha256 <sha>` to stdout so the run log traces the artefact-hash pair
// inline. The three-space indent matches the source verbatim.
async function writeSidecar(target: string): Promise<void> {
	const sum = await sha256Of(target);
	writeFileSync(`${target}.sha256`, `${sum}  ${basename(target)}\n`);
	process.stdout.write(`   sha256 ${sum}\n`);
}

// Bash: `resolve_out` — `--out` wins; otherwise `<dest>/<modality>-<ts>.<ext>`.
// Callers pass `log` as the default extension; the ui/backend/terminal/iac
// paths all keep `log`, matching the source.
function resolveOut(
	destDir: string,
	modality: string,
	ts: string,
	outOverride: string,
	ext = "log",
): string {
	if (outOverride) {
		return outOverride;
	}
	return `${destDir}/${modality}-${ts}.${ext}`;
}

// Bash: `require_script` — SCRIPT_PATH must be set AND the file must exist.
// Both errors are `exit 2` on stderr with the exact strings the bash writes.
function requireScript(scriptPath: string, modality: string): number {
	if (!scriptPath) {
		process.stderr.write(`ERROR: --script (or PROOF_SCRIPT) required for modality '${modality}'\n`);
		return 2;
	}
	if (!isFile(scriptPath)) {
		process.stderr.write(`ERROR: script not found: ${scriptPath}\n`);
		return 2;
	}
	return 0;
}

// Bash `[ -f path ]` — permission errors and broken symlinks return false,
// not thrown. Matches the source's silent-false semantics.
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// Combined stdout+stderr capture. Bash `>"$OUT" 2>&1` on a subprocess merges
// both streams into the file. sh() captures them separately; we concatenate
// stdout then stderr into the log file so the ordering is preserved for
// commands that print both. Not a byte-perfect merge (bash interleaves at
// buffer flush boundaries) but the observable content is the same.
function combinedOutput(r: Pick<ShResult, "stdout" | "stderr">): string {
	return r.stdout + r.stderr;
}

// ─── Stage 3 — Modality: ui ──────────────────────────────────────

// Playwright test. Bash:
//   PLAYWRIGHT_OUTPUT_DIR="$ARTIFACT_DIR" \
//     npx playwright test "$SCRIPT_PATH" >"$OUT" 2>&1 || {
//       echo "   playwright exited non-zero — log kept for review" >&2
//     }
// The `||` block runs only on non-zero exit; it prints to stderr and lets
// the script continue (`set -e` is dodged by the compound `|| { ... }`).
// After the run, the .png / .mp4 / .webm artefacts under $ARTIFACT_DIR each
// get their own sha256 sidecar (mirrors the `find -print0 | while` loop).
async function runModalityUi(
	destDir: string,
	modality: string,
	ts: string,
	scriptPath: string,
	outOverride: string,
): Promise<void> {
	const out = resolveOut(destDir, modality, ts, outOverride, "log");
	const artifactDir = `${destDir}/ui-${ts}-artifacts`;
	mkdirSync(artifactDir, { recursive: true });
	const result = await sh("npx", ["playwright", "test", scriptPath], {
		env: { PLAYWRIGHT_OUTPUT_DIR: artifactDir },
		rejectOnError: false,
		timeout: 0,
	});
	writeFileSync(out, combinedOutput(result));
	if (result.exitCode !== 0) {
		process.stderr.write("   playwright exited non-zero — log kept for review\n");
	}
	await writeSidecar(out);
	// Bash: `find "$ARTIFACT_DIR" -type f \( -name '*.png' -o -name '*.mp4' -o -name '*.webm' \) -print0`.
	// Recursively walk the artifact dir and sidecar each match. `-name` is
	// case-sensitive so the regex is too (`u` flag only, no `i`). Path handling
	// is safe for spaces because we join arg-side, never quote-side.
	for (const rel of readdirSync(artifactDir, { recursive: true }) as string[]) {
		if (!/\.(png|mp4|webm)$/u.test(rel)) {
			continue;
		}
		const full = join(artifactDir, rel);
		if (!isFile(full)) {
			continue;
		}
		await writeSidecar(full);
	}
}

// ─── Stage 4 — Modality: backend ─────────────────────────────────

// curl-based bash script. Bash:
//   bash "$SCRIPT_PATH" >"$OUT" 2>&1 || {
//     echo "   backend script exited non-zero — log kept for review" >&2
//   }
// Same `|| { ... }` idiom as ui — non-zero exit is logged but does not abort.
async function runModalityBackend(
	destDir: string,
	modality: string,
	ts: string,
	scriptPath: string,
	outOverride: string,
): Promise<void> {
	const out = resolveOut(destDir, modality, ts, outOverride, "log");
	const result = await sh("bash", [scriptPath], { rejectOnError: false, timeout: 0 });
	writeFileSync(out, combinedOutput(result));
	if (result.exitCode !== 0) {
		process.stderr.write("   backend script exited non-zero — log kept for review\n");
	}
	await writeSidecar(out);
}

// ─── Stage 5 — Modality: terminal ────────────────────────────────

// script(1) session capture. Bash:
//   if script --version >/dev/null 2>&1; then
//     script -q -c "bash $SCRIPT_PATH" "$OUT" || true
//   else
//     script -q "$OUT" bash "$SCRIPT_PATH" || true
//   fi
// util-linux `script` supports `--version` and `-c "command"`; BSD/macOS
// `script` predates both and takes `file command args...` positionally.
// The `|| true` swallows the exit (recording a failed session is still
// evidence).
async function runModalityTerminal(
	destDir: string,
	modality: string,
	ts: string,
	scriptPath: string,
	outOverride: string,
): Promise<void> {
	const out = resolveOut(destDir, modality, ts, outOverride, "log");
	let utilLinux = false;
	try {
		const probe = await sh("script", ["--version"], { rejectOnError: false });
		utilLinux = probe.exitCode === 0;
	} catch {
		utilLinux = false;
	}
	if (utilLinux) {
		// util-linux: script [options] [file] -c "command"
		await sh("script", ["-q", "-c", `bash ${scriptPath}`, out], {
			rejectOnError: false,
			timeout: 0,
		});
	} else {
		// BSD / macOS: script [-q] file command [args...]
		await sh("script", ["-q", out, "bash", scriptPath], {
			rejectOnError: false,
			timeout: 0,
		});
	}
	await writeSidecar(out);
}

// ─── Stage 6 — Modality: iac ─────────────────────────────────────

// Terraform + docker-compose snapshot. Bash:
//   {
//     echo "== iac snapshot @ $TS =="
//     echo
//     if [ -f terraform.tf ] || ls ./*.tf >/dev/null 2>&1; then
//       echo "-- terraform plan --"
//       terraform plan -no-color 2>&1 || echo "(terraform plan exited non-zero)"
//     else
//       echo "-- terraform plan -- (no .tf files at cwd; skipped)"
//     fi
//     echo
//     if [ -f docker-compose.yml ] || [ -f docker-compose.yaml ] || [ -f compose.yml ]; then
//       echo "-- docker compose config --"
//       docker compose config 2>&1 || echo "(docker compose config exited non-zero)"
//     else
//       echo "-- docker compose config -- (no compose file at cwd; skipped)"
//     fi
//   } >"$OUT" 2>&1
// The block's stdout+stderr both redirect to OUT; each command's `2>&1` merges
// its stderr into stdout so the terraform / docker output arrives in ordering.
async function runModalityIac(
	destDir: string,
	modality: string,
	ts: string,
	outOverride: string,
): Promise<void> {
	const out = resolveOut(destDir, modality, ts, outOverride, "log");
	const parts: string[] = [];
	parts.push(`== iac snapshot @ ${ts} ==\n`, "\n");
	if (hasTerraformFiles()) {
		parts.push("-- terraform plan --\n");
		try {
			const r = await sh("terraform", ["plan", "-no-color"], {
				rejectOnError: false,
				timeout: 0,
			});
			parts.push(combinedOutput(r));
			if (r.exitCode !== 0) {
				parts.push("(terraform plan exited non-zero)\n");
			}
		} catch {
			// Spawn failure (ENOENT — terraform not installed). Bash `||` fires
			// on non-zero exit of the pipeline; a missing binary reports "command
			// not found" and the || branch runs. Preserve that shape.
			parts.push("(terraform plan exited non-zero)\n");
		}
	} else {
		parts.push("-- terraform plan -- (no .tf files at cwd; skipped)\n");
	}
	parts.push("\n");
	if (
		existsSync("docker-compose.yml") ||
		existsSync("docker-compose.yaml") ||
		existsSync("compose.yml")
	) {
		parts.push("-- docker compose config --\n");
		try {
			const r = await sh("docker", ["compose", "config"], {
				rejectOnError: false,
				timeout: 0,
			});
			parts.push(combinedOutput(r));
			if (r.exitCode !== 0) {
				parts.push("(docker compose config exited non-zero)\n");
			}
		} catch {
			parts.push("(docker compose config exited non-zero)\n");
		}
	} else {
		parts.push("-- docker compose config -- (no compose file at cwd; skipped)\n");
	}
	writeFileSync(out, parts.join(""));
	await writeSidecar(out);
}

// Bash: `[ -f terraform.tf ] || ls ./*.tf >/dev/null 2>&1`. Either a specific
// `terraform.tf` in cwd, or a glob match for any `*.tf`. In Node: check the
// single file first, then scan cwd's entries for `.tf` extension.
function hasTerraformFiles(): boolean {
	if (existsSync("terraform.tf")) {
		return true;
	}
	try {
		return readdirSync(".").some((entry) => entry.endsWith(".tf"));
	} catch {
		return false;
	}
}

// ─── Stage 7 — Modality: bugfix-red-green ────────────────────────

// Runs $TEST_CMD at HEAD~1 (expect red / non-zero) then at HEAD (expect
// green / zero). Stashes uncommitted work first and restores it via
// try/finally regardless of how the run ends. Bash exit codes:
//   4 — HEAD~1 was already green (no regression demonstrated)
//   5 — HEAD is not green (fix does not pass its own test)
async function runModalityBugfixRedGreen(
	destDir: string,
	modality: string,
	ts: string,
): Promise<number> {
	// Bash: `[ -n "${TEST_CMD:-}" ]` — env fallback, empty when unset.
	const testCmd = process.env["TEST_CMD"] ?? "";
	if (!testCmd) {
		process.stderr.write("ERROR: TEST_CMD required for bugfix-red-green\n");
		return 2;
	}
	// Bash: `command -v git >/dev/null || { ... }`. `execSync("command -v git")`
	// is a shell builtin so we can't `sh()` it; run `git --version` via sh()
	// with rejectOnError:false and check both exit and spawn failure.
	if (!(await hasGit())) {
		process.stderr.write("ERROR: git not found\n");
		return 2;
	}

	// Bash: `START_REF=$(git rev-parse --abbrev-ref HEAD)`. If HEAD is detached,
	// abbrev-ref prints `HEAD`; in that case fall back to `git rev-parse HEAD`
	// for the raw SHA so `git checkout $START_REF` still works.
	let startRef = (await shOut("git", ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
	if (startRef === "HEAD") {
		startRef = (await shOut("git", ["rev-parse", "HEAD"])).trim();
	}
	// Bash: `if ! git diff --quiet || ! git diff --cached --quiet; then git stash ...`.
	// `--quiet` exits 0 when clean, non-zero when dirty. Any dirty flag → stash.
	const workingDirty =
		(await sh("git", ["diff", "--quiet"], { rejectOnError: false })).exitCode !== 0;
	const stagedDirty =
		(await sh("git", ["diff", "--cached", "--quiet"], { rejectOnError: false })).exitCode !== 0;
	let stashed = false;
	if (workingDirty || stagedDirty) {
		await sh("git", ["stash", "push", "-u", "-m", `proof-recorder-${ts}`], {
			rejectOnError: false,
		});
		stashed = true;
	}

	// Bash: `trap restore_git EXIT` — LIFO cleanup on any exit path. TS
	// equivalent is try/finally; the finally block runs regardless of return
	// value, exception, or early return.
	const redOut = `${destDir}/${modality}-${ts}-red.log`;
	const greenOut = `${destDir}/${modality}-${ts}-green.log`;
	let redRc = 0;
	let greenRc = 0;
	try {
		process.stdout.write("   HEAD~1 (expect red)\n");
		await sh("git", ["checkout", "--quiet", "HEAD~1"], { rejectOnError: false });
		// Bash: `set +e; bash -c "$TEST_CMD" >"$RED_OUT" 2>&1; RED_RC=$?; set -e`.
		// Capture combined stdout+stderr and the exit code without aborting.
		const redResult = await sh("bash", ["-c", testCmd], {
			rejectOnError: false,
			timeout: 0,
		});
		writeFileSync(redOut, combinedOutput(redResult));
		redRc = redResult.exitCode;
		process.stdout.write(`   exit=${redRc} (non-zero = red as expected)\n`);

		process.stdout.write("   HEAD (expect green)\n");
		await sh("git", ["checkout", "--quiet", startRef], { rejectOnError: false });
		const greenResult = await sh("bash", ["-c", testCmd], {
			rejectOnError: false,
			timeout: 0,
		});
		writeFileSync(greenOut, combinedOutput(greenResult));
		greenRc = greenResult.exitCode;
		process.stdout.write(`   exit=${greenRc} (zero = green as expected)\n`);

		await writeSidecar(redOut);
		await writeSidecar(greenOut);
	} finally {
		// Bash `restore_git`:
		//   git checkout --quiet "$START_REF" 2>/dev/null || true
		//   [ "$STASHED" = "1" ] && git stash pop --quiet 2>/dev/null || true
		// Both are best-effort — a failure to restore is loud on stderr but
		// does not shadow the primary exit code.
		await sh("git", ["checkout", "--quiet", startRef], { rejectOnError: false });
		if (stashed) {
			await sh("git", ["stash", "pop", "--quiet"], { rejectOnError: false });
		}
	}

	// SR11 fail-loud (per the bash source comment): if the red/green shape
	// is inverted, the proof does not prove what it claims. Report and exit
	// non-zero rather than pretend.
	if (redRc === 0) {
		process.stderr.write("WARN: HEAD~1 was green — no regression demonstrated\n");
		return 4;
	}
	if (greenRc !== 0) {
		process.stderr.write("WARN: HEAD was not green — fix does not pass its own test\n");
		return 5;
	}
	return 0;
}

// Bash: `command -v git >/dev/null`. sh() can't invoke shell builtins, so
// probe `git --version` — a missing binary raises ENOENT (rewrapped as
// ShError) and a present binary exits 0.
async function hasGit(): Promise<boolean> {
	try {
		const r = await sh("git", ["--version"], { rejectOnError: false });
		return r.exitCode === 0;
	} catch {
		return false;
	}
}

// Helper for capturing stdout from a subprocess that we do NOT want to
// journal to the parent's stdout (e.g. `git rev-parse` output). Non-zero
// exit returns the captured stdout regardless — matches bash's `$(...)`
// which captures whatever the child printed.
async function shOut(cmd: string, args: readonly string[]): Promise<string> {
	const r = await sh(cmd, args, { rejectOnError: false });
	return r.stdout;
}

// ─── Stage 8 — main() + CLI guard ────────────────────────────────

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const outcome = parseArgs(argv);
	if (outcome.kind === "help") {
		// Bash: `sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'` then `exit 0`.
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (outcome.kind === "err") {
		return outcome.exitCode;
	}
	const { task, modality, scriptPath, outOverride } = outcome.args;

	const taskSlug = slugify(task);
	const ts = utcStamp();

	// Bash: `DEST_DIR="discovery/proof/$TASK_SLUG"; mkdir -p "$DEST_DIR"`.
	// Anchored at cwd; the caller's discovery/ tree is authoritative.
	const destDir = `discovery/proof/${taskSlug}`;
	mkdirSync(destDir, { recursive: true });

	// Bash echoes the run header before dispatch, then the dispatch is the
	// case statement; on success, the `== done ==` + destDir footer follow.
	process.stdout.write(`>> proof-recorder task=${task} modality=${modality} ts=${ts}\n`);
	process.stdout.write(`   dest=${destDir}\n`);

	// Bash `case "$MODALITY" in ... esac`. Each modality that needs $SCRIPT_PATH
	// calls `require_script` first; iac and bugfix-red-green skip it (iac needs
	// no script; bugfix uses $TEST_CMD instead).
	switch (modality) {
		case "ui": {
			const rc = requireScript(scriptPath, modality);
			if (rc !== 0) {
				return rc;
			}
			await runModalityUi(destDir, modality, ts, scriptPath, outOverride);
			break;
		}
		case "backend": {
			const rc = requireScript(scriptPath, modality);
			if (rc !== 0) {
				return rc;
			}
			await runModalityBackend(destDir, modality, ts, scriptPath, outOverride);
			break;
		}
		case "terminal": {
			const rc = requireScript(scriptPath, modality);
			if (rc !== 0) {
				return rc;
			}
			await runModalityTerminal(destDir, modality, ts, scriptPath, outOverride);
			break;
		}
		case "iac": {
			await runModalityIac(destDir, modality, ts, outOverride);
			break;
		}
		case "bugfix-red-green": {
			const rc = await runModalityBugfixRedGreen(destDir, modality, ts);
			if (rc !== 0) {
				// Bash `exit 4` / `exit 5` skip the `== done ==` footer; preserve
				// that by returning early without the trailing echoes.
				return rc;
			}
			break;
		}
		default: {
			process.stderr.write(`ERROR: unknown modality: ${modality}\n`);
			process.stderr.write("       one of: ui backend terminal iac bugfix-red-green\n");
			return 2;
		}
	}

	// Bash trailing footer — only reached on a normal successful dispatch.
	process.stdout.write("== done ==\n");
	process.stdout.write(`${destDir}\n`);
	return 0;
}

// Bash `if [ "${BASH_SOURCE[0]}" = "$0" ]` idiom. In TS, compare the module
// URL against the pathToFileURL of the direct entrypoint.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main()
		.then((code) => {
			process.exit(code);
		})
		.catch((error: unknown) => {
			process.stderr.write(
				`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
			);
			process.exit(1);
		});
}
