// SPDX-FileCopyrightText: 2026 TTT Studios
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Behaviour tests for `trp-run-loop-extend.ts` — the extend variant of the
// TRP-EE wrapper. The extend port is a line-for-line copy of
// `trp-run-loop.ts` with two intentional divergences the trailer + Stage 4
// contract encode:
//
//   1. Stage 4 (`runDriver`) shells to `node ./scripts/fix-task.ts` rather
//      than `./scripts/fix-task.sh`. Exit-code semantics (0 / 66 / 67 /
//      HARD FAIL) are preserved so downstream operators keep the same
//      log-grep signals.
//   2. Stage 3 (`honorBundleFixturePath`) is a native TS short-circuit
//      that, when `TRP_BUNDLE_FIXTURE_PATH` is set, validates + copies
//      the fixture bundle into place BEFORE the driver runs. A validation
//      failure aborts the wrapper with exit 3.
//
// Every helper is exercised through its exported entry-point OR via an
// in-process `main()` call that spins up a scratch fixture directory with
// a real fake `fix-task.ts` driver. `@foundation/shell` is NOT mocked in
// this file — the parity assertions rely on `sh()`'s real exit-code
// propagation. The CLI-direct-run block (`isDirectRun` + top-level try/
// catch) is covered separately by `trp-run-loop-extend.cli.test.ts` under
// a mocked shell so the outer catch can be exercised without a runaway
// subprocess.
//
// Structure:
//   - `slugify`, `detectSpikeFromTaskJson`, `detectSpikeFromBundle`,
//     `honorBundleFixturePath` — direct unit tests. Each rule + edge
//     case gets its own case; malformed inputs must NOT throw.
//   - `main() in-process` — spins up a scratch dir with `scripts/fix-task.ts`
//     stubbed to a known exit code, runs `main()` against it, and asserts
//     on the wrapper's stdout / stderr / return code. This is the same
//     integration shape `trp-run-loop.test.ts` uses for the source wrapper.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	detectSpikeFromBundle,
	detectSpikeFromTaskJson,
	honorBundleFixturePath,
	main,
	type ParsedArgs,
	slugify,
} from "./trp-run-loop-extend.ts";

// A minimal fake fix-task.ts driver: prints its argv on stdout, exits
// with `code`. Node 26 runs .ts files natively (type-stripping), so a
// plain TS file works as the `sh("node", ["./scripts/fix-task.ts", …])`
// child the wrapper spawns.
function fakeDriverTs(code: number): string {
	return `#!/usr/bin/env node
process.stdout.write("FAKE_FIX_TASK: " + process.argv.slice(2).join(" ") + "\\n");
process.exit(${code});
`;
}

// Materialise a scratch fixture with a fake `scripts/fix-task.ts` + a
// placeholder `discovery/task-<slug>.json`. Returns the temp dir path;
// caller sets `process.chdir(dir)`.
function stageFixture(driverExitCode = 0, taskId = "clickup:HAND_ITC-308"): string {
	const dir = mkdtempSync(join(tmpdir(), "trp-run-loop-extend-"));
	mkdirSync(join(dir, "scripts"), { recursive: true });
	mkdirSync(join(dir, "discovery"), { recursive: true });
	const driverPath = join(dir, "scripts", "fix-task.ts");
	writeFileSync(driverPath, fakeDriverTs(driverExitCode));
	chmodSync(driverPath, 0o755);
	const slug = taskId
		.toLowerCase()
		.replaceAll(/[:/]/gu, "_")
		.replaceAll(/[^a-z0-9_-]/gu, "_")
		.replaceAll(/_+/gu, "_")
		.replaceAll(/^_+|_+$/gu, "");
	writeFileSync(
		join(dir, "discovery", `task-${slug}.json`),
		JSON.stringify({ name: "__PLACEHOLDER__", description: "__PLACEHOLDER__" }),
	);
	return dir;
}

// Overwrite the staged fixture's fake driver with one that exits `code`.
// Used to force the wrapper down its HALT (66 / 67) and HARD FAIL branches.
function installFakeDriver(dir: string, code: number): void {
	const driverPath = join(dir, "scripts", "fix-task.ts");
	writeFileSync(driverPath, fakeDriverTs(code));
	chmodSync(driverPath, 0o755);
}

describe("slugify", () => {
	// The slug feeds bundle + log paths; a regression that changes case
	// folding or replacement class silently mis-routes the driver's
	// discovery writes. WHY: the extend wrapper's Stage 3 fixture-honor
	// path builds `discovery/trp-bundle-${slug}.json` — a wrong slug is a
	// wrong bundle file, and the driver reads from disk not from state.
	it("mirrors the bash `tr | sed` chain", () => {
		expect(slugify("clickup:HAND_ITC-308")).toBe("clickup_hand_itc-308");
		expect(slugify("Linear:PROJ-42")).toBe("linear_proj-42");
	});

	it("collapses repeated underscores and trims edges", () => {
		expect(slugify("  __weird//ID__  ")).toBe("weird_id");
	});

	it("preserves already-clean slugs", () => {
		expect(slugify("abc-123_xyz")).toBe("abc-123_xyz");
	});

	it("returns empty string for an all-punct input", () => {
		// Every char replaced to `_`, then collapsed + trimmed to nothing.
		// An empty slug is what the wrapper writes when the operator typoes
		// an empty task id — the caller sees `bundle-.json`, not a crash.
		expect(slugify(":::///")).toBe("");
	});
});

describe("detectSpikeFromTaskJson", () => {
	// Rule 1 — explicit [SPIKE] prefix in any of the three text fields.
	// WHY: the bash heredoc searched only the title, but the TS port
	// widened the contract to name / description / text_content. A
	// regression that narrows this back to title-only re-introduces
	// silent mis-classification on tickets that put [SPIKE] in the body.
	it("Rule 1 fires on [SPIKE] prefix in name", () => {
		expect(detectSpikeFromTaskJson({ name: "[SPIKE] investigate cache" })).toBe(true);
	});
	it("Rule 1 fires on [SPIKE] prefix in title", () => {
		expect(detectSpikeFromTaskJson({ title: "[SPIKE] evaluate posture" })).toBe(true);
	});
	it("Rule 1 fires on [SPIKE] prefix in text_content", () => {
		expect(detectSpikeFromTaskJson({ text_content: "[SPIKE] follow-up work" })).toBe(true);
	});
	it("Rule 1 fires on [SPIKE] prefix in description", () => {
		// desc reads from text_content OR description — the second half of
		// the ?? chain must still trip rule 1 when only description carries
		// the marker.
		expect(detectSpikeFromTaskJson({ description: "[SPIKE] investigate CSP" })).toBe(true);
	});
	it("Rule 1 is case-insensitive", () => {
		expect(detectSpikeFromTaskJson({ name: "[spike] lowercase marker" })).toBe(true);
	});

	// Rule 2 — title starts with a spike verb. Distinct from rule 1
	// because there's no [SPIKE] marker; the title's first non-space
	// word is one of {spike, research, investigate, explore, figure-out}.
	it("Rule 2 fires on 'spike' title prefix", () => {
		expect(detectSpikeFromTaskJson({ name: "spike the jwt verifier posture" })).toBe(true);
	});
	it("Rule 2 fires on 'research' title prefix", () => {
		expect(detectSpikeFromTaskJson({ name: "research options for CSP" })).toBe(true);
	});
	it("Rule 2 fires on 'investigate' title prefix", () => {
		expect(detectSpikeFromTaskJson({ title: "investigate why cache misses spike" })).toBe(true);
	});
	it("Rule 2 fires on 'explore' title prefix", () => {
		expect(detectSpikeFromTaskJson({ name: "explore token-hygiene approaches" })).toBe(true);
	});
	it("Rule 2 fires on 'figure-out' title prefix", () => {
		expect(detectSpikeFromTaskJson({ name: "figure-out CORS defaults" })).toBe(true);
	});
	it("Rule 2 tolerates 'figure out' with space instead of dash", () => {
		expect(detectSpikeFromTaskJson({ name: "figure out redirect flow" })).toBe(true);
	});
	it("Rule 2 tolerates 'figure_out' with underscore", () => {
		expect(detectSpikeFromTaskJson({ name: "figure_out edge cases" })).toBe(true);
	});

	// Rule 3 — investigative-verb density outweighs code-shape density
	// in the body. Body is title + desc + criteria concatenated. A ticket
	// with >=2 spike verbs AND spike-hits > code-hits trips true.
	it("Rule 3 fires when spike-verb density outweighs code-shape hits", () => {
		expect(
			detectSpikeFromTaskJson({
				name: "evaluate JWT posture",
				description: "propose and describe candidate approaches",
			}),
		).toBe(true);
	});
	it("Rule 3 stays false when code-shape hits dominate", () => {
		expect(
			detectSpikeFromTaskJson({
				name: "consider new feature",
				description: "add a test that the endpoint returns 200 and the page renders",
			}),
		).toBe(false);
	});
	it("Rule 3 stays false with a single spike verb (needs >=2)", () => {
		// Only "propose" hits — < max(2, 0+1) = 2. Rule 3 doesn't fire.
		expect(
			detectSpikeFromTaskJson({
				name: "solve this bug",
				description: "propose a fix",
			}),
		).toBe(false);
	});

	// Custom-fields fold: an "acceptance" field name pulls its value into
	// the body for rule-3 density check. Non-acceptance fields are skipped.
	it("folds custom_fields 'acceptance' body into rule-3 density", () => {
		expect(
			detectSpikeFromTaskJson({
				name: "review options",
				description: "background context, no spike markers",
				custom_fields: [
					{
						name: "Acceptance Criteria",
						value: "propose and describe candidate approaches; recommend one",
					},
					{ name: "Priority", value: "high" },
				],
			}),
		).toBe(true);
	});

	it("skips malformed custom_fields entries (null, primitive, missing name)", () => {
		// null / non-object entries must not blow up the heuristic; the
		// `f !== null && typeof f === "object"` guard skips them.
		expect(
			detectSpikeFromTaskJson({
				name: "solve this",
				custom_fields: [null, "string entry", 42, { name: "acceptance", value: null }],
			}),
		).toBe(false);
	});

	it("tolerates non-array custom_fields (falls through to empty)", () => {
		// `Array.isArray(d.custom_fields) ? d.custom_fields : []` guards the
		// iteration. A non-array value must NOT crash on `for (const f of …)`.
		expect(
			detectSpikeFromTaskJson({
				name: "solve this",
				custom_fields: "not an array",
			}),
		).toBe(false);
	});

	it("tolerates custom_fields entry with missing 'name' key", () => {
		// The `String(field.name ?? "")` nullish coalesce hits the `??` right
		// side when the entry is a valid object but has no `name` field. Must
		// downcast to an empty string, then .toLowerCase().includes("acceptance")
		// misses, and the fold skips. A regression that removed the ?? would
		// throw `Cannot read properties of undefined (reading 'toLowerCase')`.
		expect(
			detectSpikeFromTaskJson({
				name: "solve this",
				custom_fields: [{ value: "propose describe evaluate" } /* no name key */],
			}),
		).toBe(false);
	});

	// Malformed / null / undefined / primitive inputs default to false.
	// WHY: the bash heredoc silently swallowed JSON parse errors and
	// defaulted IS_SPIKE to false. A regression that throws on `null` or
	// a number would blow up the wrapper on a corrupt task JSON.
	it("returns false for null input without throwing", () => {
		expect(detectSpikeFromTaskJson(null)).toBe(false);
	});
	it("returns false for undefined input without throwing", () => {
		expect(detectSpikeFromTaskJson(undefined)).toBe(false);
	});
	it("returns false for primitive number input", () => {
		expect(detectSpikeFromTaskJson(42)).toBe(false);
	});
	it("returns false for primitive string input", () => {
		expect(detectSpikeFromTaskJson("string")).toBe(false);
	});
	it("returns false for primitive boolean input", () => {
		expect(detectSpikeFromTaskJson(true)).toBe(false);
	});

	it("returns false for an empty object (no signals)", () => {
		expect(detectSpikeFromTaskJson({})).toBe(false);
	});
});

describe("detectSpikeFromBundle", () => {
	// Precedence: intent_extract.is_spike (boolean) > top-level is_spike.
	// A prior workflow invocation writes intent_extract, so it's the
	// most authoritative signal.
	it("reads intent_extract.is_spike=true", () => {
		expect(detectSpikeFromBundle({ intent_extract: { is_spike: true } })).toBe(true);
	});
	it("reads intent_extract.is_spike=false (does NOT fall back)", () => {
		expect(detectSpikeFromBundle({ intent_extract: { is_spike: false }, is_spike: true })).toBe(
			false,
		);
	});

	it("falls back to top-level is_spike when intent_extract is absent", () => {
		expect(detectSpikeFromBundle({ is_spike: true })).toBe(true);
	});
	it("falls back to top-level is_spike when intent_extract.is_spike is not a boolean", () => {
		// The `typeof flag === "boolean"` gate means a legacy string "true"
		// falls through to the top-level fallback.
		expect(
			detectSpikeFromBundle({
				intent_extract: { is_spike: "true" },
				is_spike: true,
			}),
		).toBe(true);
	});
	it("falls back to top-level is_spike when intent_extract.is_spike is a number", () => {
		expect(
			detectSpikeFromBundle({
				intent_extract: { is_spike: 1 },
				is_spike: true,
			}),
		).toBe(true);
	});
	it("returns false when intent_extract.is_spike is not boolean and no top-level flag", () => {
		expect(detectSpikeFromBundle({ intent_extract: { is_spike: null } })).toBe(false);
	});

	// intent_extract that's not an object (primitive / null) must NOT
	// crash the accessor; the guard at `ie && typeof ie === "object"`
	// falls through to the top-level branch.
	it("tolerates intent_extract as a primitive string", () => {
		expect(detectSpikeFromBundle({ intent_extract: "wrong shape", is_spike: true })).toBe(true);
	});
	it("tolerates intent_extract as null", () => {
		expect(detectSpikeFromBundle({ intent_extract: null, is_spike: false })).toBe(false);
	});

	it("returns false for an empty bundle", () => {
		expect(detectSpikeFromBundle({})).toBe(false);
	});
	it("returns false for null input without throwing", () => {
		expect(detectSpikeFromBundle(null)).toBe(false);
	});
	it("returns false for undefined input without throwing", () => {
		expect(detectSpikeFromBundle(undefined)).toBe(false);
	});
	it("returns false for primitive number input", () => {
		expect(detectSpikeFromBundle(42)).toBe(false);
	});
	it("returns false for primitive string input", () => {
		expect(detectSpikeFromBundle("a string")).toBe(false);
	});
});

describe("honorBundleFixturePath", () => {
	// Scratch dir per test — env is per-test, files are per-test.
	let scratch: string;
	const originalEnv = process.env.TRP_BUNDLE_FIXTURE_PATH;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "trp-honor-fixture-"));
		Reflect.deleteProperty(process.env, "TRP_BUNDLE_FIXTURE_PATH");
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
		if (originalEnv === undefined) {
			Reflect.deleteProperty(process.env, "TRP_BUNDLE_FIXTURE_PATH");
		} else {
			process.env.TRP_BUNDLE_FIXTURE_PATH = originalEnv;
		}
		rmSync(scratch, { recursive: true, force: true });
	});

	function stderr(): string {
		return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}
	function stdout(): string {
		return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
	}

	// The unset branch is the fast-path no-op: absent env var returns 0
	// without touching disk. WHY: production runs never set this env; the
	// caller must not pay any cost for the offline-replay short-circuit.
	it("returns 0 when TRP_BUNDLE_FIXTURE_PATH is unset (no-op)", () => {
		const result = honorBundleFixturePath(join(scratch, "bundle.json"));
		expect(result).toBe(0);
		// No stdout / stderr writes — pure no-op.
		expect(stdout()).toBe("");
		expect(stderr()).toBe("");
		// No bundle written.
		expect(existsSync(join(scratch, "bundle.json"))).toBe(false);
	});

	it("returns 0 when TRP_BUNDLE_FIXTURE_PATH is an empty string (no-op)", () => {
		// The `fixturePath === ""` guard mirrors the bash `[ -z "$var" ]` idiom.
		// An empty-string env var must be treated the same as unset.
		process.env.TRP_BUNDLE_FIXTURE_PATH = "";
		const result = honorBundleFixturePath(join(scratch, "bundle.json"));
		expect(result).toBe(0);
		expect(existsSync(join(scratch, "bundle.json"))).toBe(false);
	});

	it("returns 3 when fixture file does not exist", () => {
		// WHY exit 3: matches the composed-run workflow.sh die_loud posture.
		// A fixture-authoring bug (typo in the path, missing rebuild) must
		// fail loud at the wrapper boundary, not silently mask a stale
		// bundle.
		process.env.TRP_BUNDLE_FIXTURE_PATH = join(scratch, "no-such-fixture.json");
		const result = honorBundleFixturePath(join(scratch, "bundle.json"));
		expect(result).toBe(3);
		expect(stderr()).toContain("does not exist");
		// No bundle written on failure.
		expect(existsSync(join(scratch, "bundle.json"))).toBe(false);
	});

	it("returns 3 when fixture file is not valid JSON", () => {
		// The wrapper validates JSON at the boundary — a corrupt fixture
		// fails here rather than downstream in the driver. Mirrors the
		// composed-run stub's `jq -e .` guard.
		const fixturePath = join(scratch, "corrupt.json");
		writeFileSync(fixturePath, "{not: valid json}");
		process.env.TRP_BUNDLE_FIXTURE_PATH = fixturePath;
		const result = honorBundleFixturePath(join(scratch, "bundle.json"));
		expect(result).toBe(3);
		expect(stderr()).toContain("not valid JSON");
	});

	it("returns 3 when fixture path is a directory (readFileSync throws EISDIR)", () => {
		// A directory at the fixture path passes `existsSync` but makes
		// `readFileSync` throw EISDIR. The catch branch converts that to
		// exit 3 with the "unreadable" stderr line — the wrapper can't
		// distinguish "corrupt fixture" from "wrong-kind-of-path fixture"
		// without a read syscall, so both take the same fail-loud path.
		const fixturePath = join(scratch, "fixture-as-dir");
		mkdirSync(fixturePath);
		process.env.TRP_BUNDLE_FIXTURE_PATH = fixturePath;
		const result = honorBundleFixturePath(join(scratch, "bundle.json"));
		expect(result).toBe(3);
		expect(stderr()).toContain("unreadable");
	});

	it("returns 3 when the bundle write target is not writable", () => {
		// Fixture is valid but the target bundle path can't be written to.
		// The writeFileSync catch branch converts that to exit 3.
		const fixturePath = join(scratch, "good.json");
		writeFileSync(fixturePath, '{"intent_extract": {"is_spike": true}}');
		process.env.TRP_BUNDLE_FIXTURE_PATH = fixturePath;
		// Bundle target is inside a nonexistent dir → ENOENT on write.
		const bundlePath = join(scratch, "no-such-dir", "bundle.json");
		const result = honorBundleFixturePath(bundlePath);
		expect(result).toBe(3);
		expect(stderr()).toContain("failed to write bundle");
	});

	it("returns 0 and copies the fixture verbatim to the bundle path", () => {
		const fixtureContent = '{\n  "intent_extract": {"is_spike": true},\n  "iter": 1\n}';
		const fixturePath = join(scratch, "spike-bundle.json");
		writeFileSync(fixturePath, fixtureContent);
		process.env.TRP_BUNDLE_FIXTURE_PATH = fixturePath;
		const bundlePath = join(scratch, "bundle.json");
		const result = honorBundleFixturePath(bundlePath);
		expect(result).toBe(0);
		// Bundle exists and is a byte-for-byte copy of the fixture.
		expect(readFileSync(bundlePath, "utf8")).toBe(fixtureContent);
		// The stdout marker fires so an operator scanning the run log
		// can see the short-circuit engaged.
		expect(stdout()).toContain(`TRP_BUNDLE_FIXTURE_PATH honored → ${bundlePath}`);
	});
});

describe("ParsedArgs (type export)", () => {
	// Exported type — the shape check is compile-time only, but a runtime
	// assignment gate catches a regression that renames a field. WHY: the
	// wrapper's arg-parse contract is a public API a downstream test /
	// caller may destructure against.
	it("satisfies the exported type shape", () => {
		const shape: ParsedArgs = {
			taskId: "clickup:HAND_ITC-308",
			driverArgs: ["--push"],
			attempt: 2,
			repoSlug: "providence",
			modeOverride: "solve",
		};
		expect(shape.taskId).toBe("clickup:HAND_ITC-308");
		expect(shape.driverArgs).toEqual(["--push"]);
		expect(shape.attempt).toBe(2);
		expect(shape.repoSlug).toBe("providence");
		expect(shape.modeOverride).toBe("solve");
	});
});

// In-process main() coverage. Following the trp-run-loop.test.ts pattern:
// stage a real fixture with a fake fix-task.ts driver, chdir into it, spy
// on stdout / stderr, drive each observable branch of main(). The
// subprocess sh() spawns is the fixture's fake driver (a real child, real
// exit code) — mocking @foundation/shell would couple these tests to
// sh()'s call shape, which the parity test in `.cli.test.ts` covers.
describe("main() in-process", () => {
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
		for (const key of [
			"TRP_ALLOW_REMOTE_MUTATE",
			"TRP_TASK_MODE",
			"TRP_BUNDLE_FIXTURE_PATH",
		] as const) {
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

	// ------ dispatch: help / usage / bad-mode ------

	it("prints USAGE to stdout and returns 0 on -h", async () => {
		const code = await main(["-h"]);
		expect(code).toBe(0);
		// USAGE header names the extend script — a regression that swaps
		// in an old / different USAGE trips this.
		expect(stdout()).toContain("Usage:\n  trp-run-loop-extend.ts");
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
		// Bare-invocation USAGE goes to STDERR, not stdout — an operator
		// who pipes stdout into a fifo shouldn't lose the usage message.
		expect(stderr()).toContain("Usage:");
		expect(stdout()).toBe("");
	});

	it("rejects --mode=nonsense with an ERROR line to stderr and returns 2", async () => {
		const code = await main(["clickup:HAND_ITC-308", "--mode=nonsense"]);
		expect(code).toBe(2);
		expect(stderr()).toContain("ERROR: --mode=nonsense not in {spike-writeup");
	});

	// ------ driver exit-code branching (SUCCESS / HALT / HARD FAIL) ------

	it("dispatches SUCCESS trailer when driver exits 0", async () => {
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
		// The extend-specific re-run line names the extend script — a
		// regression that reverts to `./scripts/trp-run-loop.sh` misroutes
		// an operator's copy-paste.
		expect(out).toContain("./scripts/trp-run-loop-extend.ts clickup:HAND_ITC-308  --attempt=2");
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

	// ------ --attempt / --push argument threading ------

	it("parses --attempt=N and renders --attempt=N+1 in the HALT next-step block", async () => {
		installFakeDriver(stagedDir, 66);
		const code = await main(["clickup:HAND_ITC-308", "--attempt=3"]);
		expect(code).toBe(66);
		const out = stdout();
		expect(out).toContain("(attempt=3)");
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
		expect(stdout()).toContain(
			"./scripts/trp-run-loop-extend.ts clickup:HAND_ITC-308 --push --attempt=2",
		);
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

	// ------ mode auto-detection precedence ------

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
		writeFileSync(
			join(stagedDir, "discovery", "task-clickup_hand_itc-308.json"),
			JSON.stringify({ name: "[SPIKE] investigate cache misses" }),
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
	});

	it("defaults to solve when neither bundle nor task JSON is present", async () => {
		rmSync(join(stagedDir, "discovery"), { recursive: true, force: true });
		// mkdir back so the wrapper's mkdirSync doesn't fail loudly (it's
		// try/catch-wrapped anyway, but the driver still needs a place to
		// write its bundle).
		mkdirSync(join(stagedDir, "discovery"), { recursive: true });
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=solve (auto-detected)");
	});

	it("readJsonSafely swallows malformed bundle JSON and resolveMode falls through to solve", async () => {
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308.json"),
			"{not: valid json",
		);
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=solve (auto-detected)");
	});

	// ------ remote-mutation gate ------

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
		expect(stderr()).toContain("TRP: dropped driver arg '--push-force'; Stage 8+ will not run");
	});

	it("passes --push through without warnings when TRP_ALLOW_REMOTE_MUTATE=true", async () => {
		process.env.TRP_ALLOW_REMOTE_MUTATE = "true";
		const code = await main(["clickup:HAND_ITC-308", "--push"]);
		expect(code).toBe(0);
		expect(stderr()).not.toContain("TRP: remote mutation blocked");
		expect(stderr()).not.toContain("TRP: dropped driver arg");
	});

	it("still emits stderr warnings when the log-append swallows an EISDIR", async () => {
		// Pre-create the log path as a directory. The `try { appendFileSync(...) }`
		// block inside applyRemoteMutationGate will throw EISDIR; the empty
		// catch swallows it. The stderr warnings run BEFORE the try block,
		// so they're still emitted — that's the contract this test fixes.
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

	// ------ --repo=<slug> routing ------

	it("routes bundle path through --repo=<slug> suffix", async () => {
		writeFileSync(
			join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308-providence.json"),
			JSON.stringify({ is_spike: true }),
		);
		const code = await main(["clickup:HAND_ITC-308", "--repo=providence"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
	});

	it("unknown driver args flow through unchanged (parseArgs default branch)", async () => {
		installFakeDriver(stagedDir, 0);
		const code = await main(["clickup:HAND_ITC-308", "--unknown-flag=foo"]);
		expect(code).toBe(0);
		expect(stdout()).toContain("=== TRP-EE: SUCCESS (attempt 1) ===");
	});

	// ------ Stage 3: TRP_BUNDLE_FIXTURE_PATH short-circuit via main() ------

	it("Stage 3 honors TRP_BUNDLE_FIXTURE_PATH: bundle copied, mode resolved from it", async () => {
		// The fixture bundle marks is_spike=true, so resolveMode reads that
		// and lands on spike-writeup. Proves Stage 3 runs BEFORE mode
		// resolution (documented ordering constraint).
		const fixturePath = join(stagedDir, "fixture-bundle.json");
		writeFileSync(fixturePath, JSON.stringify({ intent_extract: { is_spike: true } }));
		process.env.TRP_BUNDLE_FIXTURE_PATH = fixturePath;
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(0);
		const out = stdout();
		expect(out).toContain(
			`TRP_BUNDLE_FIXTURE_PATH honored → discovery/trp-bundle-clickup_hand_itc-308.json`,
		);
		expect(out).toContain("TRP_TASK_MODE=spike-writeup (auto-detected)");
		// The bundle exists after the wrapper runs.
		expect(existsSync(join(stagedDir, "discovery", "trp-bundle-clickup_hand_itc-308.json"))).toBe(
			true,
		);
	});

	it("Stage 3 fixture-validation failure aborts before driver runs (exit 3)", async () => {
		process.env.TRP_BUNDLE_FIXTURE_PATH = join(stagedDir, "no-such-fixture.json");
		const code = await main(["clickup:HAND_ITC-308"]);
		expect(code).toBe(3);
		expect(stderr()).toContain("does not exist");
		// The driver never ran → no SUCCESS / HALT / HARD FAIL trailer.
		const out = stdout();
		expect(out).not.toContain("=== TRP-EE: SUCCESS");
		expect(out).not.toContain("=== TRP-EE: HALT");
		expect(out).not.toContain("=== TRP-EE: HARD FAIL");
	});
});
