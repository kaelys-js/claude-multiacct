// Behaviour tests for `prep-revise-input.ts` (TRP-EE revise-args builder).
//
// WHY it matters: this port is a line-for-line re-implementation of
// `security-pocs/repos/trp/scripts/prep-revise-input.py`. Every branch —
// pattern selection (repo-scoped vs global), mtime-sort, coverage-status
// grammar, the `str(sorted(list))` list literal in the revise directive —
// has to survive verbatim or the main-context Workflow() REVISE round gets
// a subtly-different args object and the fix loop stalls. These tests
// exercise every reachable branch through the sole exported entry point
// (`main`) since the port keeps its helpers module-private just like the
// Python source does.
//
// No external services are touched: the impl only reads files and env vars.
// The `@foundation/shell` `sh` helper and `fetch` are NOT called by the
// script under test, so there is nothing to mock — a per-test scratch cwd
// plus env-var and stdio spies is the whole harness.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "./prep-revise-input.ts";

// --- test harness ----------------------------------------------------------

const originalCwd = process.cwd();
const originalEnv = { ...process.env };
let scratch = "";
let discoveryDir = "";
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];

// `out.gaps_from_prior_attempt` is only set when there are gaps; several
// assertions below treat "absent" and "empty array" as equivalent. Hoisted
// out of the `it()` bodies so the `??` doesn't read as a conditional inside
// a test (vitest no-conditional-in-test).
function gapsOrEmpty(out: Record<string, unknown>): unknown {
	return out.gaps_from_prior_attempt ?? [];
}

function stubIo(): void {
	stdoutChunks = [];
	stderrChunks = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdoutChunks.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderrChunks.push(String(chunk));
		return true;
	});
}

function writeJson(path: string, data: unknown): void {
	writeFileSync(path, JSON.stringify(data));
}

function setMtime(path: string, seconds: number): void {
	utimesSync(path, seconds, seconds);
}

function stdoutJson(): unknown {
	const combined = stdoutChunks.join("");
	return JSON.parse(combined);
}

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "prep-revise-input-"));
	discoveryDir = join(scratch, "discovery");
	mkdirSync(discoveryDir);
	process.chdir(scratch);
	// Reset env to the pristine snapshot and clear anything the impl reads.
	process.env = { ...originalEnv };
	delete process.env.TASK_ID_SLUG;
	delete process.env.REPO_SLUG;
	delete process.env.FAIL_JSON;
	stubIo();
});

afterEach(() => {
	process.chdir(originalCwd);
	process.env = { ...originalEnv };
	rmSync(scratch, { recursive: true, force: true });
	vi.restoreAllMocks();
});

// --- env / arg parsing edges ----------------------------------------------

describe("main() — env preconditions", () => {
	it("returns 2 with a loud stderr line when TASK_ID_SLUG is unset", async () => {
		await expect(main()).resolves.toBe(2);
		expect(stderrChunks.join("")).toContain("TASK_ID_SLUG env var is required");
		expect(stdoutChunks).toEqual([]);
	});

	it("returns 2 when no fail JSON can be located", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		// input file exists but no fail-json — the glob step must fail first.
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), { any: "thing" });
		await expect(main()).resolves.toBe(2);
		expect(stderrChunks.join("")).toContain("no trp-fail-task-foo-*.json found");
	});

	it("returns 2 when the input JSON is missing even though a fail JSON was found", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-a1.json"), { attempt: 1 });
		await expect(main()).resolves.toBe(2);
		const err = stderrChunks.join("");
		expect(err).toContain("discovery/trp-input-task-foo.json not found");
		expect(err).toContain("--prep-only");
	});
});

// --- fail-JSON discovery --------------------------------------------------

describe("main() — fail-JSON auto-discovery", () => {
	it("honours an explicit FAIL_JSON without touching the discovery dir", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		const explicit = join(scratch, "explicit-fail.json");
		writeJson(explicit, { attempt: 42, marker: "explicit" });
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), { pinned_files: [] });
		process.env.FAIL_JSON = explicit;

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect((out.previous_attempt as Record<string, unknown>).marker).toBe("explicit");
	});

	it("picks the newest fail JSON by mtime when multiple match", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});

		const older = join(discoveryDir, "trp-fail-task-foo-a1.json");
		const newer = join(discoveryDir, "trp-fail-task-foo-a2.json");
		writeJson(older, { attempt: 1, marker: "older" });
		writeJson(newer, { attempt: 2, marker: "newer" });
		setMtime(older, 1_700_000_000);
		setMtime(newer, 1_700_100_000);

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect((out.previous_attempt as Record<string, unknown>).marker).toBe("newer");
	});

	it("prefers the repo-scoped pattern when REPO_SLUG is set and a match exists", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		process.env.REPO_SLUG = "monorepo";
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});

		const global = join(discoveryDir, "trp-fail-task-foo-a1.json");
		const scoped = join(discoveryDir, "trp-fail-task-foo-monorepo-a1.json");
		writeJson(global, { marker: "global" });
		writeJson(scoped, { marker: "scoped" });
		// Make the global newer than the scoped to prove pattern priority
		// beats raw mtime.
		setMtime(scoped, 1_700_000_000);
		setMtime(global, 1_700_100_000);

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect((out.previous_attempt as Record<string, unknown>).marker).toBe("scoped");
	});

	it("falls back to the global pattern when the repo-scoped pattern has no match", async () => {
		process.env.TASK_ID_SLUG = "task-foo";
		process.env.REPO_SLUG = "monorepo";
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});

		const global = join(discoveryDir, "trp-fail-task-foo-a1.json");
		writeJson(global, { marker: "global-fallback" });

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect((out.previous_attempt as Record<string, unknown>).marker).toBe("global-fallback");
	});
});

// --- integration: prior bundle, coverage, gap surfacing --------------------

describe("main() — gap carry-over", () => {
	beforeEach(() => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-a2.json"), {
			attempt: 2,
			marker: "fail",
		});
	});

	it("emits no revise_directive when there is no prior bundle to compare against", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A", "B"],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.revise_directive).toBeUndefined();
		expect(out.gaps_from_prior_attempt).toBeUndefined();
	});

	it("prefers the repo-scoped bundle over the global bundle when both exist", async () => {
		process.env.REPO_SLUG = "monorepo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-monorepo-a2.json"), { attempt: 2 });
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A", "B"],
		});
		// Global bundle claims BOTH closed; repo-scoped bundle claims only A.
		// If the repo-scoped file is preferred we should see B in gaps.
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: [
				{ id: "A", status: "closed" },
				{ id: "B", status: "closed" },
			],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo-monorepo.json"), {
			fix_item_coverage: [{ id: "A", status: "closed" }],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.gaps_from_prior_attempt).toEqual(["B"]);
	});

	it("computes gaps + revise_directive with the Python-style list literal", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A", "B", "C"],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			// A closed via status, B closed via addressed:true, C open.
			fix_item_coverage: [
				{ id: "A", status: "closed" },
				{ id: "B", addressed: true },
				{ id: "C", status: "open" },
			],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.gaps_from_prior_attempt).toEqual(["C"]);
		expect(out.revise_directive).toBe(
			"Attempt 2 closed items ['A', 'B']; items ['C'] still open — YOU MUST close all 3 advisory_fix_items this round.",
		);
	});

	it("falls back to attempt_number when `attempt` is missing, and to `?` when both are missing", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A"],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: [],
		});

		// Overwrite the fail JSON without either attempt key.
		writeJson(join(discoveryDir, "trp-fail-task-foo-a2.json"), {});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(String(out.revise_directive)).toMatch(/^Attempt \? closed items /u);
	});

	it("reads advisory_fix_items from the fail JSON when the input lacks them", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});
		writeJson(join(discoveryDir, "trp-fail-task-foo-a2.json"), {
			attempt: 2,
			advisory_fix_items: [{ id: "X" }],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: [{ id: "X", status: "open" }],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		// gaps computed from fail-json items but NOT surfaced because the
		// base.advisory_fix_items list is empty — so no revise_directive.
		expect(out.gaps_from_prior_attempt).toEqual(["X"]);
		expect(String(out.revise_directive)).toContain("close all 0");
	});

	it("emits an empty list literal when the closed set is empty", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A"],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			// Empty coverage → everything remains open.
			fix_item_coverage: [],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(String(out.revise_directive)).toContain("closed items []");
		expect(String(out.revise_directive)).toContain("items ['A'] still open");
	});

	it("escapes single quotes and backslashes in item ids inside the revise directive", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["tricky'id", String.raw`back\slash`],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: [],
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		// Sorted alphabetically → 'back\\slash' then 'tricky\'id'.
		expect(String(out.revise_directive)).toContain(String.raw`['back\\slash', 'tricky\'id']`);
	});

	it("logs a warning and continues when the prior bundle is not valid JSON", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: ["A"],
		});
		writeFileSync(join(discoveryDir, "trp-bundle-task-foo.json"), "not json at all");

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;
		expect(stderrChunks.join("")).toContain("warn: gap extraction failed");
		expect(out.gaps_from_prior_attempt).toBeUndefined();
		expect(out.revise_directive).toBeUndefined();
	});
});

// --- closedIds coverage-status grammar ------------------------------------

describe("main() — closedIds status grammar", () => {
	beforeEach(() => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-a2.json"), { attempt: 2 });
	});

	async function runWithCoverage(
		items: readonly string[],
		coverage: unknown,
	): Promise<Record<string, unknown>> {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: items,
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: coverage,
		});
		stdoutChunks = [];
		await main();
		return stdoutJson() as Record<string, unknown>;
	}

	it("treats an entry as closed when status is one of the accepted vocab", async () => {
		for (const s of ["closed", "addressed", "covered", "done"]) {
			const out = await runWithCoverage(["A"], [{ id: "A", status: s }]);
			expect(gapsOrEmpty(out)).toEqual([]);
		}
	});

	it("skips entries whose status is open / unaddressed / missing / gap", async () => {
		for (const s of ["open", "unaddressed", "missing", "gap"]) {
			const out = await runWithCoverage(["A"], [{ id: "A", status: s }]);
			expect(out.gaps_from_prior_attempt).toEqual(["A"]);
		}
	});

	it("skips entries where addressed is literally false regardless of status", async () => {
		const out = await runWithCoverage(["A"], [{ id: "A", status: "closed", addressed: false }]);
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("accepts an unknown status when closed_by_files is present", async () => {
		const out = await runWithCoverage(
			["A"],
			[{ id: "A", status: "partial", closed_by_files: ["x.ts"] }],
		);
		expect(gapsOrEmpty(out)).toEqual([]);
	});

	it("accepts an unknown status when addressed is explicitly true", async () => {
		const out = await runWithCoverage(["A"], [{ id: "A", status: "partial", addressed: true }]);
		expect(gapsOrEmpty(out)).toEqual([]);
	});

	it("rejects an unknown status with neither files nor addressed:true", async () => {
		const out = await runWithCoverage(["A"], [{ id: "A", status: "partial" }]);
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("reads `state` when `status` is absent", async () => {
		const out = await runWithCoverage(["A"], [{ id: "A", state: "open" }]);
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("treats coverage:null as an empty set (everything is a gap)", async () => {
		const out = await runWithCoverage(["A"], null);
		// coverage=null means no prior bundle claims anything closed.
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("accepts coverage as a dict — iterates values", async () => {
		const out = await runWithCoverage(["A", "B"], {
			first: { id: "A", status: "closed" },
			second: { id: "B", status: "open" },
		});
		expect(out.gaps_from_prior_attempt).toEqual(["B"]);
	});

	it("accepts scalar entries as bare-string ids", async () => {
		const out = await runWithCoverage(["A", "B"], ["A"]);
		expect(out.gaps_from_prior_attempt).toEqual(["B"]);
	});

	it("silently ignores entries with no recoverable id", async () => {
		const out = await runWithCoverage(["A"], [{ status: "closed" }, 42]);
		// Neither entry had a usable id, so A remains open.
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("uses `item_id`/`key`/`label`/`name`/`title` as id fallbacks in order", async () => {
		const out = await runWithCoverage(
			["A", "B", "C", "D", "E"],
			[
				{ item_id: "A", status: "closed" },
				{ key: "B", status: "closed" },
				{ label: "C", status: "closed" },
				{ name: "D", status: "closed" },
				{ title: "E", status: "closed" },
			],
		);
		expect(gapsOrEmpty(out)).toEqual([]);
	});

	it("accepts an unknown status when closed_by_files is a non-array truthy object", async () => {
		// pyOr's pyTruthy check must treat a non-empty plain object as truthy
		// (Python `bool({"x": 1})` is True) even though `closed_by_files` is
		// documented as a file-list array in the common case.
		const out = await runWithCoverage(
			["A"],
			[{ id: "A", status: "partial", closed_by_files: { "x.ts": true } }],
		);
		expect(gapsOrEmpty(out)).toEqual([]);
	});

	it("treats a non-object, non-array coverage value as an empty set", async () => {
		// `fix_item_coverage` is documented as an array or a dict; a scalar
		// (e.g. a prior bundle written mid-crash with a placeholder) must
		// degrade to "nothing closed" rather than throwing.
		const out = await runWithCoverage(["A"], "not-a-collection");
		expect(out.gaps_from_prior_attempt).toEqual(["A"]);
	});

	it("accepts advisory items that are dicts with an id-shaped key", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			advisory_fix_items: [{ id: "A" }, { name: "B" }, { nope: 1 }],
		});
		writeJson(join(discoveryDir, "trp-bundle-task-foo.json"), {
			fix_item_coverage: [{ id: "A", status: "closed" }],
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		// A closed, B open, {nope:1} silently dropped.
		expect(out.gaps_from_prior_attempt).toEqual(["B"]);
	});
});

// --- trimming ---------------------------------------------------------------

describe("main() — heavy-field trimming", () => {
	beforeEach(() => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-a1.json"), { attempt: 1 });
	});

	it("truncates poc_readme to 5000 characters when it exceeds the cap", async () => {
		const big = "x".repeat(6000);
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			poc_readme: big,
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect((out.poc_readme as string).length).toBe(5000);
	});

	it("leaves a short poc_readme untouched", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			poc_readme: "short",
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.poc_readme).toBe("short");
	});

	it("does not add a poc_readme key when the input omits it", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.poc_readme).toBeUndefined();
	});

	it("skips the trim branch when poc_readme is present but empty", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			poc_readme: "",
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.poc_readme).toBe("");
	});

	it("truncates each pinned_files entry's content_first_200_lines to 3000 chars", async () => {
		const big = "y".repeat(4000);
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			pinned_files: [
				{ path: "a.ts", content_first_200_lines: big },
				// Non-object entry must not blow up.
				null,
				// Object without the target key is left alone.
				{ path: "b.ts" },
			],
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		const pinned = out.pinned_files as unknown[];
		const first = pinned[0] as Record<string, unknown>;
		expect((first.content_first_200_lines as string).length).toBe(3000);
		// Second entry preserved as null.
		expect(pinned[1]).toBeNull();
		// Third entry preserved as-is.
		expect(pinned[2]).toEqual({ path: "b.ts" });
	});

	it("normalises a null content_first_200_lines to an empty string instead of the literal 'null'", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			pinned_files: [{ path: "a.ts", content_first_200_lines: null }],
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		const pinned = out.pinned_files as Array<Record<string, unknown>>;
		expect(pinned[0]?.content_first_200_lines).toBe("");
	});

	it("tolerates pinned_files being absent from the input", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.pinned_files).toBeUndefined();
	});

	it("tolerates pinned_files being a non-array value (skips the trim loop)", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			pinned_files: { not: "an array" },
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.pinned_files).toEqual({ not: "an array" });
	});
});

// --- pythonJsonDumps / pythonJsonString serialization ----------------------

describe("main() — stdout serialization edge cases", () => {
	beforeEach(() => {
		process.env.TASK_ID_SLUG = "task-foo";
		writeJson(join(discoveryDir, "trp-fail-task-foo-a1.json"), { attempt: 1 });
	});

	it("round-trips boolean fields (both true and false) verbatim in the output object", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			mutate: true,
			dry_run: false,
		});
		await main();
		const out = stdoutJson() as Record<string, unknown>;
		expect(out.mutate).toBe(true);
		expect(out.dry_run).toBe(false);
	});

	it("escapes control characters and embedded quotes the same way Python's json.dumps does", async () => {
		writeJson(join(discoveryDir, "trp-input-task-foo.json"), {
			task_summary: 'has "quotes", a\tab, a\bbackspace, a\fformfeed and a\rreturn',
		});
		await main();
		// Assert on the raw stdout text rather than the re-parsed JSON so the
		// literal escape sequences (not their decoded characters) are checked.
		const raw = stdoutChunks.join("");
		expect(raw).toContain(String.raw`\"quotes\"`);
		expect(raw).toContain(String.raw`\t`);
		expect(raw).toContain(String.raw`\b`);
		expect(raw).toContain(String.raw`\f`);
		expect(raw).toContain(String.raw`\r`);
	});
});

// --- integration smoke -----------------------------------------------------

describe("main() — end-to-end with synthesised fixture", () => {
	it("assembles the whole args object from a realistic multi-file layout", async () => {
		process.env.TASK_ID_SLUG = "hand-itc-999";
		process.env.REPO_SLUG = "web";

		// Two failure JSONs; the repo-scoped one must win.
		writeJson(join(discoveryDir, "trp-fail-hand-itc-999-a1.json"), {
			attempt: 1,
			marker: "global",
		});
		writeJson(join(discoveryDir, "trp-fail-hand-itc-999-web-a3.json"), {
			attempt: 3,
			marker: "web-scoped",
			stage_label: "Stage 6 (client CI)",
		});
		// Two bundle JSONs; repo-scoped must win.
		writeJson(join(discoveryDir, "trp-bundle-hand-itc-999.json"), {
			fix_item_coverage: [
				{ id: "AF-1", status: "closed" },
				{ id: "AF-2", status: "closed" },
				{ id: "AF-3", status: "closed" },
			],
		});
		writeJson(join(discoveryDir, "trp-bundle-hand-itc-999-web.json"), {
			fix_item_coverage: [
				{ id: "AF-1", status: "closed" },
				{ id: "AF-2", status: "open" },
				{ id: "AF-3", addressed: false },
			],
		});
		writeJson(join(discoveryDir, "trp-input-hand-itc-999.json"), {
			advisory_fix_items: [{ id: "AF-1" }, { id: "AF-2" }, { id: "AF-3" }],
			poc_readme: "z".repeat(6000),
			pinned_files: [{ path: "server.ts", content_first_200_lines: "line\n".repeat(1000) }],
			// Any extra fields must round-trip untouched.
			task_summary: "keep me",
		});

		await expect(main()).resolves.toBe(0);
		const out = stdoutJson() as Record<string, unknown>;

		// previous_attempt came from the repo-scoped fail JSON.
		const prev = out.previous_attempt as Record<string, unknown>;
		expect(prev.marker).toBe("web-scoped");
		expect(prev.stage_label).toBe("Stage 6 (client CI)");

		// gaps derived from the repo-scoped bundle (AF-1 closed; AF-2 open;
		// AF-3 addressed:false → both AF-2 and AF-3 land in gaps).
		expect(out.gaps_from_prior_attempt).toEqual(["AF-2", "AF-3"]);
		expect(out.revise_directive).toBe(
			"Attempt 3 closed items ['AF-1']; items ['AF-2', 'AF-3'] still open — YOU MUST close all 3 advisory_fix_items this round.",
		);

		// Trimming applied.
		expect((out.poc_readme as string).length).toBe(5000);
		const pinned = out.pinned_files as unknown[];
		const first = pinned[0] as Record<string, unknown>;
		expect((first.content_first_200_lines as string).length).toBe(3000);

		// Extra fields preserved.
		expect(out.task_summary).toBe("keep me");
	});
});
