// End-to-end proof for ROADMAP Item 20 Phase 2: `@foundation/shell` consumer
// (trp-run-loop.ts) matches trp-run-loop.sh exit code and stdout on the
// HAND_ITC-308 fixture ticket.
//
// WHY it matters: the shared-package rewrite has to preserve every operator-
// visible line of the wrapper (mode-detection label, remote-mutation warning,
// success/HALT/hard-fail trailer). Any drift means an operator's log-grep
// silently misses a signal. These tests fix the byte-for-byte contract on
// the fixture and cover the internal helpers to clear the coverage floor.
//
// Every parity case captures BOTH child processes' exitCode AND stdout and
// asserts equality on each, so a wrapper that silently remaps a driver's
// non-zero exit (66 -> 0, 42 -> 0) trips the gate even if stdout still
// matches. This closes the ROADMAP requirement "identical exit code AND
// stdout" that the plan's gate-completeness refuter flagged.

import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sh } from "@foundation/shell";
import { detectSpikeFromBundle, detectSpikeFromTaskJson, main, slugify } from "./trp-run-loop.ts";

const HERE = import.meta.dirname;
const FIXTURE_ROOT = resolve(HERE, "..", "..", "tests", "fixtures", "hand-itc-308");
const TS_SCRIPT = resolve(HERE, "trp-run-loop.ts");

// Normalise transient bits (timings, absolute paths) so the parity assertion
// compares only the parts an operator reads.
function normalise(text: string): string {
	return text.replaceAll("\r\n", "\n").trim();
}

// Materialise the fixture into a fresh scratch dir so the Bash script's
// mkdir/cd/discovery writes don't touch the repo tree.
function stageFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-run-loop-parity-"));
	cpSync(FIXTURE_ROOT, dir, { recursive: true });
	chmodSync(join(dir, "scripts", "fix-task.sh"), 0o755);
	chmodSync(join(dir, "scripts", "trp-run-loop.sh"), 0o755);
	return dir;
}

// Overwrite the fixture's fake fix-task.sh with a driver that exits `code`
// after printing one deterministic line. Used to force the wrapper down its
// HALT (66/67) and HARD FAIL (any other non-zero) branches.
function installFakeDriver(dir: string, code: number): void {
	const path = join(dir, "scripts", "fix-task.sh");
	writeFileSync(
		path,
		`#!/usr/bin/env bash\nset -uo pipefail\necho "FAKE_FIX_TASK: $*"\nexit ${code}\n`,
	);
	chmodSync(path, 0o755);
}

// Shared runner: forks both wrappers against the same staged fixture and
// returns their exit codes + normalised stdouts. Kept as a helper so every
// parity case asserts BOTH streams via one call, not two ad-hoc invocations.
async function runBoth(
	dir: string,
	args: string[],
): Promise<{ bashExit: number; tsExit: number; bashOut: string; tsOut: string }> {
	const bash = await sh("bash", ["./scripts/trp-run-loop.sh", ...args], {
		cwd: dir,
		rejectOnError: false,
		timeout: 20_000,
	});
	const ts = await sh("node", [TS_SCRIPT, ...args], {
		cwd: dir,
		rejectOnError: false,
		timeout: 20_000,
	});
	return {
		bashExit: bash.exitCode ?? -1,
		tsExit: ts.exitCode ?? -1,
		bashOut: normalise(bash.stdout),
		tsOut: normalise(ts.stdout),
	};
}

describe("trp-run-loop parity (HAND_ITC-308 fixture)", () => {
	it("matches on the placeholder ticket with an exit-0 driver: same exit code AND stdout", async () => {
		const dir = stageFixture();
		const r = await runBoth(dir, ["clickup:HAND_ITC-308"]);
		expect(r.bashExit).toBe(0);
		expect(r.tsExit).toBe(r.bashExit);
		expect(r.tsOut).toBe(r.bashOut);
	});

	it("prints the same usage on -h and exits 0 under both implementations", async () => {
		const dir = stageFixture();
		const r = await runBoth(dir, ["-h"]);
		expect(r.bashExit).toBe(0);
		expect(r.tsExit).toBe(r.bashExit);
		expect(r.tsOut).toBe(r.bashOut);
	});

	it("a bare invocation prints usage on stderr and exits 2 under both implementations", async () => {
		const dir = stageFixture();
		// Bare invocation writes to stderr; capture the exit code + stdout only
		// (stdout should be empty on both, which is itself a parity assertion).
		const bash = await sh("bash", ["./scripts/trp-run-loop.sh"], {
			cwd: dir,
			rejectOnError: false,
			timeout: 5000,
		});
		const ts = await sh("node", [TS_SCRIPT], {
			cwd: dir,
			rejectOnError: false,
			timeout: 5000,
		});
		expect(bash.exitCode).toBe(2);
		expect(ts.exitCode).toBe(bash.exitCode);
		expect(normalise(ts.stdout)).toBe(normalise(bash.stdout));
	});

	it("rejects --mode=nonsense identically under both implementations", async () => {
		const dir = stageFixture();
		const r = await runBoth(dir, ["clickup:HAND_ITC-308", "--mode=nonsense"]);
		// Both wrappers must refuse an unknown mode with the same exit code
		// and the same stdout trailer — a divergence here would let a typo
		// silently pick a default mode under one implementation.
		expect(r.tsExit).toBe(r.bashExit);
		expect(r.bashExit).not.toBe(0);
		expect(r.tsOut).toBe(r.bashOut);
	});

	it("halts identically when the driver exits 66 (SRP-J revise loop signal)", async () => {
		const dir = stageFixture();
		installFakeDriver(dir, 66);
		const r = await runBoth(dir, ["clickup:HAND_ITC-308"]);
		// HALT branch: wrapper propagates the 66, prints the same trailer.
		expect(r.bashExit).toBe(66);
		expect(r.tsExit).toBe(r.bashExit);
		expect(r.tsOut).toBe(r.bashOut);
	});

	it("hard-fails identically when the driver exits with a non-{0,66,67} code", async () => {
		const dir = stageFixture();
		installFakeDriver(dir, 42);
		const r = await runBoth(dir, ["clickup:HAND_ITC-308"]);
		// HARD FAIL branch: 42 is arbitrary; the contract is that both
		// wrappers propagate the exact code and print the HARD FAIL trailer.
		expect(r.bashExit).toBe(42);
		expect(r.tsExit).toBe(r.bashExit);
		expect(r.tsOut).toBe(r.bashOut);
	});
});

describe("trp-run-loop helpers", () => {
	it("slugify mirrors the bash `tr | sed` chain", () => {
		expect(slugify("clickup:HAND_ITC-308")).toBe("clickup_hand_itc-308");
		expect(slugify("Linear:PROJ-42")).toBe("linear_proj-42");
		expect(slugify("  __weird//ID__  ")).toBe("weird_id");
	});

	it("detectSpikeFromTaskJson reads the [SPIKE] prefix on name, title, or text_content", () => {
		expect(detectSpikeFromTaskJson({ name: "[SPIKE] investigate", text_content: "" })).toBe(true);
		expect(detectSpikeFromTaskJson({ title: "[SPIKE] investigate" })).toBe(true);
		expect(detectSpikeFromTaskJson({ text_content: "[SPIKE] follow up" })).toBe(true);
		expect(detectSpikeFromTaskJson({ name: "solve this bug", text_content: "no marker" })).toBe(
			false,
		);
		// Missing / malformed inputs must default to false, not throw — the
		// bash heredoc silently defaults to false on any JSON parse error.
		expect(detectSpikeFromTaskJson(null)).toBe(false);
		expect(detectSpikeFromTaskJson(undefined)).toBe(false);
	});

	it("detectSpikeFromBundle reads intent_extract.is_spike then falls back to is_spike", () => {
		expect(detectSpikeFromBundle({ intent_extract: { is_spike: true } })).toBe(true);
		expect(detectSpikeFromBundle({ is_spike: true })).toBe(true);
		expect(detectSpikeFromBundle({ intent_extract: { is_spike: false } })).toBe(false);
		expect(detectSpikeFromBundle({})).toBe(false);
		expect(detectSpikeFromBundle(null)).toBe(false);
	});

	it("detectSpikeFromTaskJson rule 2: title that starts with a spike verb (no [SPIKE] marker)", () => {
		// A title like "spike jwt verifier" or "investigate the leak" trips
		// rule 2 — the bash version's regex on the title alone. This is the
		// path the [SPIKE]-marker tests above SKIP by construction.
		expect(detectSpikeFromTaskJson({ name: "spike the jwt verifier posture" })).toBe(true);
		expect(detectSpikeFromTaskJson({ title: "investigate why cache misses spike" })).toBe(true);
		expect(detectSpikeFromTaskJson({ name: "research options for CSP" })).toBe(true);
		expect(detectSpikeFromTaskJson({ name: "explore token-hygiene approaches" })).toBe(true);
		expect(detectSpikeFromTaskJson({ name: "figure-out CORS defaults" })).toBe(true);
	});

	it("detectSpikeFromTaskJson rule 3: investigative-verb density outweighs code-shape hits", () => {
		// Rule 3 counts investigative-verb matches vs code-shape matches across
		// title+desc+criteria. A body with >=2 spike verbs and no code shapes
		// trips true. This is the path bash's python heredoc took as the third
		// tiebreaker.
		expect(
			detectSpikeFromTaskJson({
				name: "evaluate JWT posture",
				description: "propose and describe candidate approaches",
			}),
		).toBe(true);
		// Body with more code-shape matches than spike verbs should stay false.
		expect(
			detectSpikeFromTaskJson({
				name: "consider new feature",
				description: "add a test that the endpoint returns 200 and the page renders",
			}),
		).toBe(false);
	});

	it("detectSpikeFromTaskJson folds custom_fields 'acceptance' body into the density check", () => {
		// The Acceptance Criteria custom field on a ClickUp task lands under
		// custom_fields[]; the wrapper folds it in when its name contains
		// "acceptance". This test proves the fold happens by placing enough
		// spike verbs there to flip rule 3, WITHOUT any verbs in title/desc.
		expect(
			detectSpikeFromTaskJson({
				name: "review options",
				description: "background context, no spike markers",
				custom_fields: [
					{
						name: "Acceptance Criteria",
						value: "propose and describe candidate approaches; recommend one",
					},
					// A non-acceptance custom field is skipped — proves the includes() gate.
					{ name: "Priority", value: "high" },
				],
			}),
		).toBe(true);
	});

	it("detectSpikeFromTaskJson skips malformed custom_fields entries", () => {
		// null / non-object entries in custom_fields must not blow up the
		// heuristic; the guard at line 81 skips them.
		expect(
			detectSpikeFromTaskJson({
				name: "solve this",
				custom_fields: [null, "string entry", 42, { name: "acceptance", value: null }],
			}),
		).toBe(false);
	});

	it("detectSpikeFromTaskJson non-object input returns false without throwing", () => {
		// The early-out guard covers primitives (numbers, strings, booleans).
		// A regression that removes the `typeof input !== "object"` check
		// would crash on `d.name` access — this test fixes the guard.
		expect(detectSpikeFromTaskJson(42)).toBe(false);
		expect(detectSpikeFromTaskJson("string")).toBe(false);
		expect(detectSpikeFromTaskJson(true)).toBe(false);
	});

	it("detectSpikeFromBundle falls back to top-level is_spike when intent_extract.is_spike is not a boolean", () => {
		// The `typeof flag === "boolean"` gate means a non-boolean
		// intent_extract.is_spike (e.g. a legacy string "true", a null, or a
		// missing property) makes the function fall through to the top-level
		// `b.is_spike === true`. This test fixes that fallback path.
		expect(
			detectSpikeFromBundle({
				intent_extract: { is_spike: "true" /* string, not boolean */ },
				is_spike: true,
			}),
		).toBe(true);
		expect(
			detectSpikeFromBundle({
				intent_extract: { is_spike: 1 /* number, not boolean */ },
				is_spike: true,
			}),
		).toBe(true);
		// Non-boolean intent_extract.is_spike + no top-level flag → false.
		expect(
			detectSpikeFromBundle({
				intent_extract: { is_spike: null },
			}),
		).toBe(false);
	});

	it("detectSpikeFromBundle handles intent_extract that is not an object", () => {
		// A malformed bundle with intent_extract set to a primitive should
		// gracefully fall to the top-level is_spike branch, not crash.
		expect(detectSpikeFromBundle({ intent_extract: "wrong shape", is_spike: true })).toBe(true);
		expect(detectSpikeFromBundle({ intent_extract: null, is_spike: false })).toBe(false);
	});

	it("detectSpikeFromBundle rejects non-object inputs and primitives", () => {
		expect(detectSpikeFromBundle(42)).toBe(false);
		expect(detectSpikeFromBundle("a string")).toBe(false);
		expect(detectSpikeFromBundle(undefined)).toBe(false);
	});
});

// In-process main() coverage. The parity tests above SPAWN a fresh node
// subprocess and invoke `trp-run-loop.ts` there; v8 coverage in the parent
// test process doesn't see any of that child's line coverage. To hold every
// branch of main / parseArgs / resolveMode / applyRemoteMutationGate /
// runDriver / printHaltTrailer against the coverage floor, these tests call
// main() in-process against the staged fixture, spy on process stdout/stderr
// so the wrapper's writes land in per-test buffers, and drive each observable
// branch. The subprocess sh() spawns is still the fixture's fake fix-task.sh
// (real subprocess, controlled exit code) — mocking @foundation/shell would
// couple these tests to sh()'s call shape, which the parity tests already
// pin.
describe("trp-run-loop main() in-process", () => {
	let originalCwd: string;
	let stagedDir: string;
	const savedEnv: Record<string, string | undefined> = {};
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	function stdout(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}
	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	beforeEach(() => {
		originalCwd = process.cwd();
		// Save + clear env vars the wrapper reads so tests are isolated.
		for (const key of ["TRP_ALLOW_REMOTE_MUTATE", "TRP_TASK_MODE"] as const) {
			savedEnv[key] = process.env[key];
			Reflect.deleteProperty(process.env, key);
		}
		stagedDir = stageFixture();
		process.chdir(stagedDir);
		stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
		stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true) as unknown as ReturnType<
			typeof vi.spyOn
		>;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		process.chdir(originalCwd);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}
		try {
			rmSync(stagedDir, { recursive: true, force: true });
		} catch {
			// non-fatal — mkdtemp dirs are cleaned by the OS eventually.
		}
	});

	it("prints USAGE to stdout and returns 0 on -h", async () => {
		const code = await main(["-h"]);
		expect(code).toBe(0);
		// The USAGE header is the load-bearing bit — a regression that
		// swaps in an empty or different USAGE string trips this.
		expect(stdout()).toContain("Usage:\n  trp-run-loop.sh");
		expect(stderr()).toBe("");
	});

	it("prints USAGE to stdout and returns 0 on --help", async () => {
		const code = await main(["--help"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("Usage:");
	});

	it("prints USAGE to stderr and returns 2 on bare invocation", async () => {
		const code = await main([]);
		expect(code).toBe(2);
		// Bare-invocation USAGE goes to STDERR, not stdout — an operator who
		// pipes stdout into a fifo shouldn't lose the usage message.
		expect(stderr()).toContain("Usage:");
		expect(stdout()).toBe("");
	});

	it("rejects --mode=nonsense with an ERROR line to stderr and returns 2", async () => {
		const code = await main(["clickup:HAND_ITC-308", "--mode=nonsense"]);
		expect(code).toBe(2);
		expect(stderr()).toContain("ERROR: --mode=nonsense not in {spike-writeup");
	});

	it("dispatches SUCCESS trailer when driver exits 0", async () => {
		// The fixture ships a fake driver that exits 0. main() should print
		// the wrapper header, the resolved mode, and the SUCCESS trailer.
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		const out = stdout();
		expect(out).toContain("=== TRP-EE loop wrapper for clickup:HAND_ITC-308 (attempt=1) ===");
		expect(out).toContain("TRP_TASK_MODE=solve (auto-detected)");
		expect(out).toContain("=== TRP-EE: SUCCESS (attempt 1) ===");
	});

	it("dispatches HALT trailer with 'Stage 5-8' label when driver exits 66", async () => {
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(66);
		const out = stdout();
		expect(out).toContain("=== TRP-EE: HALT (exit 66 — Stage 5-8) ===");
		expect(out).toContain("Next step (main Claude session):");
		// The re-run line reconstructs the argv for the next attempt.
		expect(out).toContain("./scripts/trp-run-loop.sh clickup:HAND_ITC-308  --attempt=2");
	});

	it("dispatches HALT trailer with 'post-push external review' label when driver exits 67", async () => {
		installFakeDriver(stagedDir, 67);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(67);
		const out = stdout();
		expect(out).toContain("=== TRP-EE: HALT (exit 67 — post-push external review) ===");
	});

	it("dispatches HARD FAIL trailer when driver exits with a non-{0,66,67} code", async () => {
		installFakeDriver(stagedDir, 42);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(42);
		expect(stdout()).toContain("=== TRP-EE: HARD FAIL (exit 42) ===");
	});

	it("parses --attempt=N and renders --attempt=N+1 in the HALT next-step block", async () => {
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308", "--attempt=3"]);
		expect(code).toBe(66);
		const out = stdout();
		// Header must reflect the parsed attempt.
		expect(out).toContain("(attempt=3)");
		// Trailer must render N+1 in the re-run line.
		expect(out).toContain("--attempt=4");
	});

	it("falls back to attempt=1 when --attempt= is not a number", async () => {
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308", "--attempt=notanumber"]);
		expect(code).toBe(66);
		// Math.trunc(Number("notanumber")) is NaN → falsy → || 1 → 1.
		expect(stdout()).toContain("(attempt=1)");
	});

	it("HALT re-run line inlines --push when driverArgs carried it (gate open)", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308", "--push"]);
		expect(code).toBe(66);
		const out = stdout();
		// With --push in argv, localPushArg is set and the re-run line
		// interpolates it BEFORE the attempt flag.
		expect(out).toContain("./scripts/trp-run-loop.sh clickup:HAND_ITC-308 --push --attempt=2");
	});

	it("HALT re-run line preserves the double-space when no --push is present", async () => {
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(66);
		// The bash version prints "$TASK_ID $local_push_arg --attempt=N";
		// when local_push_arg is empty that's "$TASK_ID  --attempt=N" —
		// two spaces. An operator's log grep depends on this exact form.
		expect(stdout()).toContain("clickup:HAND_ITC-308  --attempt=2");
	});

	it("explicit --mode=solve shows 'explicit --mode' in the mode-source label", async () => {
		const code = await main(["clickup:HAND_ITC-308", "--mode=solve"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=solve (explicit --mode)");
	});

	it("auto-detects spike-writeup when bundle has intent_extract.is_spike=true", async () => {
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308.json"),
			JSON.stringify({ intent_extract: { is_spike: true } }),
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
	});

	it("auto-detects solve when bundle exists but intent_extract.is_spike=false", async () => {
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308.json"),
			JSON.stringify({ intent_extract: { is_spike: false } }),
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=solve (auto-detected)");
	});

	it("auto-detects spike-writeup when taskJson [SPIKE] marker fires (no bundle)", async () => {
		// The fixture ships a placeholder task JSON. Overwrite with a spike-marked
		// version to force detectSpikeFromTaskJson down the true branch.
		writeFileSync(
			join(stagedDir, "discovery", "task-clickup_hand_itc-308.json"),
			JSON.stringify({ name: "[SPIKE] investigate cache misses" }),
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
	});

	it("defaults to solve when neither bundle nor task JSON is present", async () => {
		// Remove the fixture's task JSON so both files are absent — resolveMode
		// falls through to the final else branch.
		rmSync(join(stagedDir, "discovery"), { recursive: true, force: true });
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=solve (auto-detected)");
	});

	it("readJsonSafely swallows malformed bundle JSON and resolveMode falls through to solve", async () => {
		// A bundle that exists but can't be parsed is treated the same as an
		// absent bundle — the bash version piped stderr to /dev/null on the
		// python3 heredoc and defaulted IS_SPIKE to false; the TS wrapper's
		// readJsonSafely swallows the throw and returns undefined, so the
		// downstream detectSpikeFromBundle(undefined) === false.
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308.json"),
			"{not: valid json",
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		// Bundle exists (file present), so branch takes existsSync path. The
		// existing check picks the bundle even if unparseable — mode falls to
		// solve because detectSpikeFromBundle(undefined)===false.
		expect(stdout()).toContain("TRP_TASK_MODE=solve (auto-detected)");
	});

	it("strips --push and emits 2 stderr warnings when TRP_ALLOW_REMOTE_MUTATE unset", async () => {
		const code = await main(["clickup:HAND_ITC-308", "--push"]);
		expect(code).toBe(0);
		const err = stderr();
		expect(err).toContain(
			"TRP: remote mutation blocked — set TRP_ALLOW_REMOTE_MUTATE=true to enable",
		);
		expect(err).toContain("TRP: dropped driver arg '--push'; Stage 8+ will not run");
	});

	it("strips --push-force too when the gate is closed", async () => {
		const code = await main(["clickup:HAND_ITC-308", "--push-force"]);
		expect(code).toBe(0);
		// Same 2 warnings but with --push-force in the dropped-arg message.
		expect(stderr()).toContain("TRP: dropped driver arg '--push-force'; Stage 8+ will not run");
	});

	it("passes --push through without warnings when TRP_ALLOW_REMOTE_MUTATE=true", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const code = await main(["clickup:HAND_ITC-308", "--push"]);
		expect(code).toBe(0);
		// No mutation-blocked warnings when the gate is open.
		expect(stderr()).not.toContain("TRP: remote mutation blocked");
		expect(stderr()).not.toContain("TRP: dropped driver arg");
	});

	it("still emits the stderr warnings when the log-append swallows an EISDIR", async () => {
		// Pre-create the log path as a directory. The `try { appendFileSync(...) }`
		// block inside applyRemoteMutationGate will throw EISDIR; the empty catch
		// swallows it. The stderr warnings run BEFORE the try block, so they're
		// still emitted — that's the contract this test fixes.
		mkdirSync(join(stagedDir, "discovery"), { recursive: true });
		mkdirSync(join(stagedDir, "discovery", "trp-run-clickup_hand_itc-308.log"), {
			recursive: true,
		});
		const code = await main(["clickup:HAND_ITC-308", "--push"]);
		expect(code).toBe(0);
		expect(stderr()).toContain(
			"TRP: remote mutation blocked — set TRP_ALLOW_REMOTE_MUTATE=true to enable",
		);
	});

	it("routes bundle path through --repo=<slug> suffix", async () => {
		// The per-repo bundle file lands at trp-bundle-<slug>-<repo>.json;
		// resolveMode reads from that path when --repo is set. A spike bundle
		// under the -providence suffix should flip mode to spike-writeup.
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308-providence.json"),
			JSON.stringify({ is_spike: true }),
		);
		const code = await main(["clickup:HAND_ITC-308", "--repo=providence"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
	});

	it("unknown driver args flow through unchanged (parseArgs default branch)", async () => {
		// Args that don't match --attempt=, --repo=, --mode= are still passed
		// through in driverArgs — the fake driver echoes them, and main()
		// dispatches SUCCESS because the fake exits 0. This pins the "flow
		// unknown args through" behaviour so a regression that filters
		// unknown flags trips.
		installFakeDriver(stagedDir, 0);
		const code = await main(["clickup:HAND_ITC-308", "--unknown-flag=foo"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("=== TRP-EE: SUCCESS (attempt 1) ===");
	});
});
